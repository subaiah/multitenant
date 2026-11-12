/**
 * Bundles (platform staff): named sets of applications organizations turn on
 * together, e.g. "Sales suite" = CRMForge + Hearth + Documents
 * (docs/hub/HUB_GAPS.md G2). Organizations turn one on from Application
 * Entitlements (routes/tenant-applications.ts); what each application
 * requires is checked across the whole set.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { audit, withPlatformAudit } from '../lib/audit.js';
import { AppError } from '../middleware/error-handler.js';

const bundleSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,49}$/, 'Lowercase letters, digits and -'),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(300).nullable().optional(),
  active: z.boolean().default(true),
  applicationIds: z.array(z.string().uuid()).min(2, 'A bundle has at least two applications').max(20),
});
const include = { applications: { orderBy: { position: 'asc' as const }, include: { application: { select: { id: true, key: true, name: true, status: true } } } } };
const view = (b: { id: string; key: string; name: string; description: string | null; active: boolean; applications: { application: { id: string; key: string; name: string; status: string } }[] }) => ({
  id: b.id, key: b.key, name: b.name, description: b.description, active: b.active, applications: b.applications.map((x) => x.application),
});

async function checkApplications(ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw new AppError('An application is listed twice', 400);
  const found = await controlDb.applicationRegistry.count({ where: { id: { in: unique } } });
  if (found !== unique.length) throw new AppError('Unknown application in the bundle', 400);
}

export const applicationBundleRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/bundles', {
    config: { permission: 'app-registry:manage' },
    schema: { tags: ['applications'], summary: 'Bundles of applications' },
  }, async () => ({ bundles: (await controlDb.bundle.findMany({ include, orderBy: { name: 'asc' } })).map(view) }));

  fastify.post('/bundles', {
    config: { permission: 'app-registry:manage' },
    schema: { tags: ['applications'], summary: 'Make a bundle' },
  }, async (request, reply) => {
    const data = bundleSchema.parse(request.body);
    await checkApplications(data.applicationIds);
    if (await controlDb.bundle.findUnique({ where: { key: data.key } })) throw new AppError('A bundle with that key exists', 409);
    const bundle = await withPlatformAudit(request, async (tx, record) => {
      const bundle = await tx.bundle.create({
        data: { key: data.key, name: data.name, description: data.description ?? null, active: data.active, applications: { create: data.applicationIds.map((applicationId, position) => ({ applicationId, position })) } },
        include,
      });
      await record('bundle.created', { resource: { type: 'bundle', id: bundle.id, label: bundle.name }, details: { applications: bundle.applications.map((x) => x.application.key) } });
      return bundle;
    });
    return reply.status(201).send(view(bundle));
  });

  fastify.put('/bundles/:bundleId', {
    config: { permission: 'app-registry:manage' },
    schema: { tags: ['applications'], summary: 'Change a bundle', params: { type: 'object', required: ['bundleId'], properties: { bundleId: { type: 'string', format: 'uuid' } } } },
  }, async (request) => {
    const { bundleId } = request.params as { bundleId: string };
    const data = bundleSchema.parse(request.body);
    await checkApplications(data.applicationIds);
    const before = await controlDb.bundle.findUnique({ where: { id: bundleId } });
    if (!before) throw new AppError('Bundle not found', 404);
    if (data.key !== before.key && await controlDb.bundle.findUnique({ where: { key: data.key } })) throw new AppError('A bundle with that key exists', 409);
    const bundle = await controlDb.$transaction(async (tx) => {
      await tx.bundleApplication.deleteMany({ where: { bundleId } });
      return tx.bundle.update({
        where: { id: bundleId },
        data: { key: data.key, name: data.name, description: data.description ?? null, active: data.active, applications: { create: data.applicationIds.map((applicationId, position) => ({ applicationId, position })) } },
        include,
      });
    });
    await audit(request, 'bundle.updated', { resource: { type: 'bundle', id: bundle.id, label: bundle.name }, details: { applications: bundle.applications.map((x) => x.application.key), active: bundle.active } });
    return view(bundle);
  });

  fastify.delete('/bundles/:bundleId', {
    config: { permission: 'app-registry:manage' },
    schema: { tags: ['applications'], summary: 'Delete a bundle (organizations keep what they turned on)', params: { type: 'object', required: ['bundleId'], properties: { bundleId: { type: 'string', format: 'uuid' } } } },
  }, async (request, reply) => {
    const { bundleId } = request.params as { bundleId: string };
    const bundle = await controlDb.bundle.findUnique({ where: { id: bundleId } });
    if (!bundle) throw new AppError('Bundle not found', 404);
    await withPlatformAudit(request, async (tx, record) => {
      await tx.bundle.delete({ where: { id: bundleId } });
      await record('bundle.deleted', { resource: { type: 'bundle', id: bundle.id, label: bundle.name } });
    });
    return reply.status(204).send();
  });
};
