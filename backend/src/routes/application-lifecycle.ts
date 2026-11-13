/**
 * An external product's lifecycle events (platform staff): where they go,
 * the secret they're signed with (shown once), and what was sent.
 * lib/product-lifecycle.ts; docs/PRODUCT_INTEGRATION.md.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { decryptSecret, secretContext } from '../lib/secrets.js';
import { audit, withPlatformAudit } from '../lib/audit.js';
import { AppError } from '../middleware/error-handler.js';
import { userEventsChanged } from '../lib/product-user-events.js';
import { ROTATION_OVERLAP_MS, callbackChanged, callbackUrlSchema, newCallbackSecret, retryLifecycleEvent } from '../lib/product-lifecycle.js';

const settingsSchema = z.object({
  callbackUrl: callbackUrlSchema.nullable(),
  deletesDataOnDeprovision: z.boolean().default(false),
  userEvents: z.boolean().default(false),
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
      previousSecretValidUntil: app.previousCallbackSecretExpiresAt && app.previousCallbackSecretExpiresAt > new Date() ? app.previousCallbackSecretExpiresAt : null,
      deletesDataOnDeprovision: app.deletesDataOnDeprovision,
      userEvents: app.userEvents,
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
    // User events go to the callback too: none without one
    const userEvents = data.userEvents && !!data.callbackUrl;
    await controlDb.applicationRegistry.update({
      where: { id: app.id },
      data: { provisioningCallbackUrl: data.callbackUrl, deletesDataOnDeprovision: data.deletesDataOnDeprovision, userEvents, ...(secret && { callbackSigningSecret: secret }) },
    });
    const told = await callbackChanged(app.id, !!app.provisioningCallbackUrl, !!data.callbackUrl);
    await userEventsChanged(app.id, app.userEvents, userEvents);
    await audit(request, 'application.lifecycle_updated', {
      resource: { type: 'application', id: app.id, label: app.name },
      changes: { callbackUrl: [app.provisioningCallbackUrl, data.callbackUrl], deletesDataOnDeprovision: [app.deletesDataOnDeprovision, data.deletesDataOnDeprovision], userEvents: [app.userEvents, userEvents] },
      details: { organizationsTold: told, ...(secret && { newSigningSecret: true }) },
    });
    return { callbackUrl: data.callbackUrl, deletesDataOnDeprovision: data.deletesDataOnDeprovision, userEvents, organizationsTold: told, ...(secret && { signingSecret: secret }) };
  });

  fastify.post('/:id/lifecycle/secret', {
    config: { permission: 'app-registry:manage' },
    schema: { tags: ['applications'], summary: "Replace the secret an application's lifecycle events are signed with (returned once; the old one keeps signing alongside for 24 hours)", params },
  }, async (request) => {
    const app = await findApp((request.params as { id: string }).id);
    if (!app.provisioningCallbackUrl) throw new AppError('Set a callback address first', 400);
    const secret = newCallbackSecret();
    // The old secret keeps signing alongside, so the application can switch over without missing events
    const previousExpiresAt = new Date(Date.now() + ROTATION_OVERLAP_MS);
    await withPlatformAudit(request, async (tx, record) => {
      await tx.applicationRegistry.update({
        where: { id: app.id },
        // Decrypted, so it's stored encrypted for its own column (secrets are bound to their column)
        data: {
          callbackSigningSecret: secret,
          previousCallbackSigningSecret: app.callbackSigningSecret ? decryptSecret(app.callbackSigningSecret, secretContext('callbackSigningSecret')) : null,
          previousCallbackSecretExpiresAt: app.callbackSigningSecret ? previousExpiresAt : null,
        },
      });
      await record('application.lifecycle_updated', { resource: { type: 'application', id: app.id, label: app.name }, details: { newSigningSecret: true, previousSecretValidUntil: previousExpiresAt.toISOString() } });
    });
    return { signingSecret: secret, previousSecretValidUntil: app.callbackSigningSecret ? previousExpiresAt : null };
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
