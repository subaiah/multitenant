/**
 * An external product's lifecycle events (platform staff): where they go,
 * the secret they're signed with (shown once), and what was sent.
 * lib/product-lifecycle.ts; docs/PRODUCT_INTEGRATION.md.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { AppError } from '../middleware/error-handler.js';
import { callbackChanged, callbackUrlSchema, newCallbackSecret, retryLifecycleEvent } from '../lib/product-lifecycle.js';

const settingsSchema = z.object({
  callbackUrl: callbackUrlSchema.nullable(),
  deletesDataOnDeprovision: z.boolean().default(false),
});

const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

export const applicationLifecycleRoutes: FastifyPluginAsync = async (fastify) => {
  const findApp = async (id: string) => {
    const app = await controlDb.applicationRegistry.findUnique({ where: { id } });
    if (!app) throw new AppError('Application not found', 404);
    return app;
  };

  fastify.get('/:id/lifecycle', {
    config: { permission: 'app-registry:manage' },
    schema: { tags: ['applications'], summary: "An application's lifecycle events: settings, organizations' setup and what was sent", params },
  }, async (request) => {
    const app = await findApp((request.params as { id: string }).id);
    const [events, entitlements] = await Promise.all([
      controlDb.productEvent.findMany({ where: { applicationId: app.id }, orderBy: { seq: 'desc' }, take: 50 }),
      controlDb.tenantApplication.findMany({ where: { applicationId: app.id }, include: { tenant: { select: { id: true, name: true, slug: true } } }, orderBy: { createdAt: 'desc' } }),
    ]);
    const tenants = new Map(entitlements.map((e) => [e.tenantId, e.tenant]));
    const missing = [...new Set(events.map((e) => e.tenantId).filter((t) => !tenants.has(t)))];
    if (missing.length) {
      for (const t of await controlDb.tenant.findMany({ where: { id: { in: missing } }, select: { id: true, name: true, slug: true } })) tenants.set(t.id, t);
    }
    return {
      callbackUrl: app.provisioningCallbackUrl,
      hasSecret: !!app.callbackSigningSecret,
      deletesDataOnDeprovision: app.deletesDataOnDeprovision,
      organizations: entitlements.map((e) => ({
        tenant: e.tenant, state: e.state, provisioningStatus: e.provisioningStatus, provisioningError: e.provisioningError, provisionedAt: e.provisionedAt,
      })),
      events: events.map((e) => ({
        id: e.id, publicId: e.publicId, type: e.type, status: e.status, attempts: e.attempts, nextAttemptAt: e.nextAttemptAt,
        lastStatus: e.lastStatus, lastError: e.lastError, deliveredAt: e.deliveredAt, createdAt: e.createdAt,
        tenant: tenants.get(e.tenantId) ?? { id: e.tenantId, name: null, slug: null },
      })),
    };
  });

  fastify.put('/:id/lifecycle', {
    config: { permission: 'app-registry:manage' },
    schema: { tags: ['applications'], summary: "Set where an application's lifecycle events go (a new signing secret is returned once)", params },
  }, async (request) => {
    const app = await findApp((request.params as { id: string }).id);
    const data = settingsSchema.parse(request.body);
    const secret = data.callbackUrl && !app.callbackSigningSecret ? newCallbackSecret() : undefined;
    await controlDb.applicationRegistry.update({
      where: { id: app.id },
      data: { provisioningCallbackUrl: data.callbackUrl, deletesDataOnDeprovision: data.deletesDataOnDeprovision, ...(secret && { callbackSigningSecret: secret }) },
    });
    const told = await callbackChanged(app.id, !!app.provisioningCallbackUrl, !!data.callbackUrl);
    await audit(request, 'application.lifecycle_updated', {
      resource: { type: 'application', id: app.id, label: app.name },
      changes: { callbackUrl: [app.provisioningCallbackUrl, data.callbackUrl], deletesDataOnDeprovision: [app.deletesDataOnDeprovision, data.deletesDataOnDeprovision] },
      details: { organizationsTold: told, ...(secret && { newSigningSecret: true }) },
    });
    return { callbackUrl: data.callbackUrl, deletesDataOnDeprovision: data.deletesDataOnDeprovision, organizationsTold: told, ...(secret && { signingSecret: secret }) };
  });

  fastify.post('/:id/lifecycle/secret', {
    config: { permission: 'app-registry:manage' },
    schema: { tags: ['applications'], summary: "Replace the secret an application's lifecycle events are signed with (returned once)", params },
  }, async (request) => {
    const app = await findApp((request.params as { id: string }).id);
    if (!app.provisioningCallbackUrl) throw new AppError('Set a callback address first', 400);
    const secret = newCallbackSecret();
    await controlDb.applicationRegistry.update({ where: { id: app.id }, data: { callbackSigningSecret: secret } });
    await audit(request, 'application.lifecycle_updated', { resource: { type: 'application', id: app.id, label: app.name }, details: { newSigningSecret: true } });
    return { signingSecret: secret };
  });

  fastify.post('/:id/lifecycle/events/:eventId/retry', {
    config: { permission: 'app-registry:manage' },
    schema: {
      tags: ['applications'],
      summary: 'Send a lifecycle event again now',
      params: { type: 'object', required: ['id', 'eventId'], properties: { id: { type: 'string', format: 'uuid' }, eventId: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const { id, eventId } = request.params as { id: string; eventId: string };
    if (!(await retryLifecycleEvent(id, eventId))) throw new AppError('No such event waiting or failed', 404);
    return reply.status(202).send({ retrying: true });
  });
};
