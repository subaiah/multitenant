/**
 * Access rules for every organization (Global policies → Access rules),
 * checked before each organization's own (lib/access-rules.ts).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler.js';
import { diff, withPlatformAudit } from '../lib/audit.js';
import { controlDb } from '../lib/prisma.js';
import { dbForTenant } from '../lib/tenant-db.js';
import { ATTRIBUTES, OPERATORS, decide, forgetPlatformRules, organizationRules, platformRules, ruleBodySchema, subjectFor } from '../lib/access-rules.js';

const ruleSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(500).nullish(),
  effect: z.enum(['ALLOW', 'DENY']),
  conditions: ruleBodySchema,
  priority: z.number().int().min(0).max(10_000).default(0),
  enabled: z.boolean().default(true),
});
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

export const platformAccessRuleRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onResponse', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD' && reply.statusCode < 400) forgetPlatformRules();
  });

  fastify.get('/', {
    config: { permission: 'policies:read' },
    schema: { tags: ['access-rules'], summary: 'Access rules for every organization, highest priority first, with what a rule can say' },
  }, async () => ({
    data: await controlDb.platformAccessRule.findMany({ orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] }),
    language: { attributes: ATTRIBUTES, operators: OPERATORS },
  }));

  fastify.post('/', {
    config: { permission: 'policies:manage' },
    schema: { tags: ['access-rules'], summary: 'Create an access rule for every organization' },
  }, async (request, reply) => {
    const data = ruleSchema.parse(request.body);
    const rule = await withPlatformAudit(request, async (tx, record) => {
      const created = await tx.platformAccessRule.create({ data });
      await record('platform.access_rule_created', { resource: { type: 'platform_access_rule', id: created.id, label: created.name }, details: { rule: data } });
      return created;
    });
    return reply.status(201).send(rule);
  });

  fastify.patch('/:id', {
    config: { permission: 'policies:manage' },
    schema: { tags: ['access-rules'], summary: 'Change an access rule for every organization', params: idParams },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const data = ruleSchema.partial().parse(request.body);
    const before = await controlDb.platformAccessRule.findUnique({ where: { id } });
    if (!before) throw new AppError('Access rule not found', 404);
    return withPlatformAudit(request, async (tx, record) => {
      const updated = await tx.platformAccessRule.update({ where: { id }, data });
      const changes = diff(before as unknown as Record<string, unknown>, data as Record<string, unknown>);
      if (Object.keys(changes).length) await record('platform.access_rule_updated', { resource: { type: 'platform_access_rule', id, label: updated.name }, changes });
      return updated;
    });
  });

  fastify.delete('/:id', {
    config: { permission: 'policies:manage' },
    schema: { tags: ['access-rules'], summary: 'Delete an access rule for every organization', params: idParams },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = await controlDb.platformAccessRule.findUnique({ where: { id } });
    if (!before) throw new AppError('Access rule not found', 404);
    await withPlatformAudit(request, async (tx, record) => {
      await tx.platformAccessRule.delete({ where: { id } });
      await record('platform.access_rule_deleted', { resource: { type: 'platform_access_rule', id, label: before.name } });
    });
    return reply.status(204).send();
  });

  // Try the rules on someone in an organization: the platform's and that organization's
  fastify.post('/evaluate', {
    config: { permission: 'policies:read' },
    schema: {
      tags: ['access-rules'],
      summary: "Would this person's request with this permission be refused, and by which rule",
      body: {
        type: 'object',
        required: ['tenantId', 'email', 'action'],
        properties: {
          tenantId: { type: 'string', format: 'uuid' },
          email: { type: 'string' },
          action: { type: 'string' },
          context: { type: 'object', properties: { ip: { type: 'string' }, at: { type: 'string', format: 'date-time' }, resourceId: { type: 'string' }, apiKey: { type: 'boolean' } } },
        },
      },
    },
  }, async (request) => {
    const { tenantId, email, action, context = {} } = request.body as { tenantId: string; email: string; action: string; context?: { ip?: string; at?: string; resourceId?: string; apiKey?: boolean } };
    const db = await dbForTenant(tenantId);
    const user = await db.user.findFirst({ where: { tenantId, email: { equals: email, mode: 'insensitive' } }, select: { id: true, userType: true, email: true } });
    if (!user) throw new AppError('No one with that email in that organization', 404);
    const subject = subjectFor(db, tenantId, { userId: user.id, userType: context.apiKey ? 'API_KEY' : user.userType, email: user.email },
      { ip: context.ip ?? request.ip, method: 'GET', path: '/', apiKey: Boolean(context.apiKey), resourceId: context.resourceId ?? null },
      [action], context.at ? new Date(context.at) : new Date());
    const { allowed, deniedBy, steps } = await decide(await platformRules(), await organizationRules(tenantId, db), subject);
    return { decision: allowed ? 'ALLOW' : 'DENY', deniedBy, evaluations: steps };
  });
};
