/**
 * Audit log endpoints (lib/audit.ts).
 *
 *   tenant   /audit            the current tenant's log
 *   platform /platform-audit   the platform's log, and checks/archiving of any log
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { controlDb } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import {
  PLATFORM_CHAIN, archiveExpired, archiveStream, audit, auditCatalog, auditCsv, listAudit, verifyChain, type AuditFilter,
} from '../lib/audit.js';

const filterSchema = z.object({
  event: z.string().max(200).optional(),
  category: z.string().max(50).optional(),
  outcome: z.enum(['SUCCESS', 'FAILURE']).optional(),
  actorId: z.string().max(100).optional(),
  resourceType: z.string().max(100).optional(),
  resourceId: z.string().max(200).optional(),
  tenantId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().max(200).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function parseFilter(query: unknown): { filter: AuditFilter; limit: number } {
  const { before, limit, ...rest } = filterSchema.parse(query);
  return { filter: { ...rest, beforeSeq: before }, limit };
}

async function page(chain: string, query: unknown) {
  const { filter, limit } = parseFilter(query);
  const rows = await listAudit(chain, filter, limit + 1);
  const data = rows.slice(0, limit);
  return { data, nextBefore: rows.length > limit ? data.at(-1)!.seq : null };
}

const eventsFor = (scope: 'tenant' | 'platform') =>
  Object.entries(auditCatalog())
    .filter(([, d]) => d.scope === scope)
    .map(([key, d]) => ({ key, label: d.label, category: d.category }));

async function sendCsv(request: FastifyRequest, reply: FastifyReply, chain: string, event: string) {
  const { filter } = parseFilter(request.query);
  await audit(request, event, { details: { filter: JSON.parse(JSON.stringify(filter)) }, ...(chain === PLATFORM_CHAIN && { tenantId: filter.tenantId }) });
  const stamp = new Date().toISOString().slice(0, 10);
  reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="audit-log-${stamp}.csv"`);
  return reply.send(Readable.from(auditCsv(chain, filter)));
}

async function sendArchive(reply: FastifyReply, id: string, chain: string | null) {
  const archive = await controlDb.auditArchive.findUnique({ where: { id } });
  if (!archive || (chain !== null && archive.chain !== chain)) throw new AppError('Archive not found', 404);
  reply
    .header('content-type', 'application/gzip')
    .header('content-disposition', `attachment; filename="${archive.file.split('/').pop()}"`);
  return reply.send(archiveStream(archive.file));
}

const archiveList = (where: { chain?: string }) =>
  controlDb.auditArchive.findMany({
    where,
    orderBy: { fromSeq: 'desc' },
    select: { id: true, chain: true, tenantId: true, fromSeq: true, toSeq: true, fromAt: true, toAt: true, rows: true, bytes: true, sha256: true, createdAt: true },
  });

export const auditRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    config: { permission: 'audit:read' },
    schema: { tags: ['audit'], summary: "The tenant's audit log, newest first (page with ?before=<seq>)" },
  }, async (request) => page(request.tenant.id, request.query));

  fastify.get('/events', {
    config: { permission: 'audit:read' },
    schema: { tags: ['audit'], summary: 'Kinds of audit entries (for filters)' },
  }, async () => eventsFor('tenant'));

  fastify.get('/verify', {
    config: { permission: 'audit:read' },
    schema: { tags: ['audit'], summary: 'Check the audit log has not been changed' },
  }, async (request) => verifyChain(request.tenant.id));

  fastify.get('/export', {
    config: { permission: 'audit:export' },
    schema: { tags: ['audit'], summary: 'Download matching entries as CSV' },
  }, async (request, reply) => sendCsv(request, reply, request.tenant.id, 'audit.exported'));

  fastify.get('/archives', {
    config: { permission: 'audit:export' },
    schema: { tags: ['audit'], summary: 'Archived (older) audit entries' },
  }, async (request) => archiveList({ chain: request.tenant.id }));

  fastify.get('/archives/:id/download', {
    config: { permission: 'audit:export' },
    schema: { tags: ['audit'], summary: 'Download an archive file (gzipped JSON lines)' },
  }, async (request, reply) => sendArchive(reply, (request.params as { id: string }).id, request.tenant.id));
};

const chainQuery = z.object({ chain: z.union([z.literal(PLATFORM_CHAIN), z.string().uuid()]).default(PLATFORM_CHAIN) });

export const platformAuditRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    config: { permission: 'platform-audit:read' },
    schema: { tags: ['audit'], summary: "The platform's audit log, newest first" },
  }, async (request) => page(PLATFORM_CHAIN, request.query));

  fastify.get('/events', {
    config: { permission: 'platform-audit:read' },
    schema: { tags: ['audit'], summary: 'Kinds of platform audit entries' },
  }, async () => eventsFor('platform'));

  fastify.get('/verify', {
    config: { permission: 'platform-audit:manage' },
    schema: { tags: ['audit'], summary: "Check the platform's (or a tenant's, ?chain=<tenantId>) audit log" },
  }, async (request) => {
    const { chain } = chainQuery.parse(request.query);
    if (chain !== PLATFORM_CHAIN && !(await controlDb.tenant.findUnique({ where: { id: chain }, select: { id: true } }))) {
      throw new AppError('Tenant not found', 404);
    }
    return verifyChain(chain);
  });

  fastify.get('/export', {
    config: { permission: 'platform-audit:manage' },
    schema: { tags: ['audit'], summary: 'Download matching platform entries as CSV' },
  }, async (request, reply) => sendCsv(request, reply, PLATFORM_CHAIN, 'platform.audit.exported'));

  fastify.get('/archives', {
    config: { permission: 'platform-audit:manage' },
    schema: { tags: ['audit'], summary: 'Archived audit entries of every log' },
  }, async () => archiveList({}));

  fastify.get('/archives/:id/download', {
    config: { permission: 'platform-audit:manage' },
    schema: { tags: ['audit'], summary: 'Download an archive file' },
  }, async (request, reply) => sendArchive(reply, (request.params as { id: string }).id, null));

  fastify.post('/archive', {
    config: { permission: 'platform-audit:manage' },
    schema: { tags: ['audit'], summary: 'Archive entries past the retention period now (normally daily)' },
  }, async () => ({ results: await archiveExpired() }));
};
