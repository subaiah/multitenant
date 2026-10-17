/**
 * An organization's administrators export its data (Settings).
 *
 *   GET  /data-exports                 recent exports and their state
 *   POST /data-exports                 start one (built in the background; emailed when ready)
 *   GET  /data-exports/:id/download    the ZIP, while it's kept
 *
 * Its own administrators only: not other users with settings access, and not
 * platform staff in a support session (who see data only as approved, in the
 * app). Allowed while a trial has ended, so nobody's data is held hostage.
 */
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { controlDb } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { audit } from '../lib/audit.js';
import { exportFile, runExport } from '../lib/data-export.js';
import { isTenantAdmin } from '../utils/authorization.js';

const PER_DAY = 5;

function assertAdmin(request: FastifyRequest) {
  if (!isTenantAdmin(request.user.userType) || request.supportSession) {
    throw new AppError("Only the organization's administrators can export its data", 403);
  }
}

const view = (e: Awaited<ReturnType<typeof controlDb.dataExport.findFirstOrThrow>>) => ({
  id: e.id,
  status: e.status,
  requestedBy: e.requestedBy,
  createdAt: e.createdAt,
  finishedAt: e.finishedAt,
  expiresAt: e.expiresAt,
  sizeBytes: e.sizeBytes === null ? null : Number(e.sizeBytes),
  tables: e.tables,
  error: e.status === 'FAILED' ? 'The export could not be completed. Try again, or contact the platform team if it keeps failing.' : null,
  downloadCount: e.downloadCount,
});

export const dataExportRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    config: { permission: 'settings:manage' },
    schema: { tags: ['data-exports'], summary: "The organization's recent data exports" },
  }, async (request) => {
    const exports = await controlDb.dataExport.findMany({ where: { tenantId: request.tenant.id }, orderBy: { createdAt: 'desc' }, take: 10 });
    return { canExport: isTenantAdmin(request.user.userType) && !request.supportSession, exports: exports.map(view) };
  });

  fastify.post('/', {
    config: { permission: 'settings:manage', allowWhenTrialEnded: true },
    schema: { tags: ['data-exports'], summary: "Export the organization's data (a ZIP of CSV files, built in the background)" },
  }, async (request, reply) => {
    assertAdmin(request);
    const tenantId = request.tenant.id;
    if (await controlDb.dataExport.findFirst({ where: { tenantId, status: { in: ['PENDING', 'RUNNING'] } }, select: { id: true } })) {
      throw new AppError('An export is already being prepared', 409, true, 'EXPORT_IN_PROGRESS');
    }
    const today = await controlDb.dataExport.count({ where: { tenantId, createdAt: { gt: new Date(Date.now() - 86_400_000) } } });
    if (today >= PER_DAY) throw new AppError(`At most ${PER_DAY} exports a day. Try again tomorrow.`, 429, true, 'EXPORT_LIMIT');

    const user = await request.db.user.findFirst({ where: { id: request.user.userId, tenantId }, select: { email: true } });
    const created = await controlDb.dataExport.create({ data: { tenantId, requestedById: request.user.userId, requestedBy: user?.email ?? null } });
    await audit(request, 'data_export.requested', { resource: { type: 'data_export', id: created.id, label: 'Organization data' } });
    void runExport(created.id);
    return reply.status(202).send(view(created));
  });

  fastify.get('/:id/download', {
    config: { permission: 'settings:manage' },
    schema: { tags: ['data-exports'], summary: 'Download a finished export', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (request, reply) => {
    assertAdmin(request);
    const { id } = request.params as { id: string };
    const e = await controlDb.dataExport.findFirst({ where: { id, tenantId: request.tenant.id } });
    if (!e) throw new AppError('Export not found', 404);
    if (e.status !== 'READY') throw new AppError('This export is not ready', 409);
    const file = exportFile(e);
    if ((e.expiresAt && e.expiresAt < new Date()) || !(await access(file).then(() => true, () => false))) {
      throw new AppError('This export has expired. Start a new one.', 410, true, 'EXPORT_EXPIRED');
    }
    await controlDb.dataExport.update({ where: { id }, data: { downloadCount: { increment: 1 } } });
    await audit(request, 'data_export.downloaded', { resource: { type: 'data_export', id, label: 'Organization data' } });
    const date = e.createdAt.toISOString().slice(0, 10);
    return reply
      .header('content-type', 'application/zip')
      .header('content-length', String(e.sizeBytes))
      .header('content-disposition', `attachment; filename="${request.tenant.slug}-data-${date}.zip"`)
      .header('cache-control', 'no-store')
      .send(createReadStream(file));
  });
};
