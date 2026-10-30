/**
 * The organization's outgoing webhooks (Developers page). docs/API_ACCESS.md.
 *
 *   GET    /webhooks                          endpoints and how they're doing (not their secrets)
 *   GET    /webhooks/events                   events that can be subscribed to
 *   POST   /webhooks                          add one: { url, events, description? } → its signing secret, once
 *   PATCH  /webhooks/:id                      change it, or turn it on or off
 *   POST   /webhooks/:id/rotate-secret        a new signing secret, once (the old one stops at once)
 *   DELETE /webhooks/:id                      remove it, with its deliveries
 *   POST   /webhooks/:id/test                 send a test event now
 *   GET    /webhooks/:id/deliveries           recent deliveries (?status=FAILED)
 *   POST   /webhooks/deliveries/:id/retry     send one again
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler.js';
import { audit, diff } from '../lib/audit.js';
import { assertWebhookUrl, newSigningSecret, retryDelivery, sendTestEvent, webhookEvents } from '../lib/webhooks.js';

const MAX_ENDPOINTS = 20;

const view = (e: { id: string; url: string; description: string | null; events: string[]; enabled: boolean; lastSuccessAt: Date | null; lastFailureAt: Date | null; consecutiveFailures: number; disabledReason: string | null; createdAt: Date; updatedAt: Date }) => ({
  id: e.id, url: e.url, description: e.description, events: e.events, enabled: e.enabled, lastSuccessAt: e.lastSuccessAt, lastFailureAt: e.lastFailureAt,
  consecutiveFailures: e.consecutiveFailures, disabledReason: e.disabledReason, createdAt: e.createdAt, updatedAt: e.updatedAt,
});

function assertPerson(request: FastifyRequest) {
  if (request.supportSession) throw new AppError("Webhooks are set up by the organization's own people, not in a support session", 403);
}

const eventsSchema = z.array(z.string().max(100)).min(1).max(200).superRefine((events, ctx) => {
  const known = new Set(webhookEvents().map((e) => e.type));
  const unknown = events.filter((e) => e !== '*' && !known.has(e));
  if (unknown.length) ctx.addIssue({ code: 'custom', message: `Unknown events: ${unknown.join(', ')}` });
});

export const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  const endpointOf = async (request: FastifyRequest) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const e = await request.db.webhookEndpoint.findFirst({ where: { id, tenantId: request.tenant.id } });
    if (!e) throw new AppError('Webhook not found', 404);
    return e;
  };

  fastify.get('/', {
    config: { permission: 'api:read' },
    schema: { tags: ['webhooks'], summary: 'Webhook endpoints and how their deliveries are going' },
  }, async (request) => {
    const tenantId = request.tenant.id;
    const [endpoints, pending, failed] = await Promise.all([
      request.db.webhookEndpoint.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
      request.db.webhookDelivery.groupBy({ by: ['endpointId'], where: { tenantId, status: { in: ['PENDING', 'SENDING'] } }, _count: { _all: true } }),
      request.db.webhookDelivery.groupBy({ by: ['endpointId'], where: { tenantId, status: 'FAILED', createdAt: { gt: new Date(Date.now() - 7 * 86_400_000) } }, _count: { _all: true } }),
    ]);
    return {
      endpoints: endpoints.map((e) => ({
        ...view(e),
        waiting: pending.find((p) => p.endpointId === e.id)?._count._all ?? 0,
        failedThisWeek: failed.find((p) => p.endpointId === e.id)?._count._all ?? 0,
      })),
    };
  });

  fastify.get('/events', {
    config: { permission: 'api:read' },
    schema: { tags: ['webhooks'], summary: 'Events a webhook can subscribe to (the organization’s audit events)' },
  }, async () => ({ events: webhookEvents() }));

  fastify.post('/', {
    config: { permission: 'api:manage', rateLimit: { max: 20, timeWindow: '10 minutes' } },
    schema: { tags: ['webhooks'], summary: 'Add a webhook: returns its signing secret, once' },
  }, async (request, reply) => {
    assertPerson(request);
    const body = z.object({ url: z.string().trim().max(2000), events: eventsSchema, description: z.string().trim().max(200).optional() }).parse(request.body);
    const url = assertWebhookUrl(body.url).toString();
    if ((await request.db.webhookEndpoint.count({ where: { tenantId: request.tenant.id } })) >= MAX_ENDPOINTS) {
      throw new AppError(`An organization can have at most ${MAX_ENDPOINTS} webhooks`, 409);
    }
    const secret = newSigningSecret();
    const e = await request.db.webhookEndpoint.create({
      data: { tenantId: request.tenant.id, url, description: body.description || null, events: [...new Set(body.events)], signingSecret: secret, createdById: request.user.userId },
    });
    await audit(request, 'webhook.created', { resource: { type: 'webhook', id: e.id, label: url }, details: { events: e.events } });
    return reply.status(201).send({ ...view(e), secret });
  });

  fastify.patch('/:id', {
    config: { permission: 'api:manage' },
    schema: { tags: ['webhooks'], summary: 'Change a webhook, or turn it on or off' },
  }, async (request) => {
    assertPerson(request);
    const before = await endpointOf(request);
    const body = z.object({
      url: z.string().trim().max(2000).optional(),
      events: eventsSchema.optional(),
      description: z.string().trim().max(200).nullable().optional(),
      enabled: z.boolean().optional(),
    }).parse(request.body);
    const data: Record<string, unknown> = {};
    if (body.url !== undefined) data.url = assertWebhookUrl(body.url).toString();
    if (body.events) data.events = [...new Set(body.events)];
    if (body.description !== undefined) data.description = body.description || null;
    if (body.enabled !== undefined) {
      data.enabled = body.enabled;
      // Back on: a fresh start
      if (body.enabled) Object.assign(data, { disabledReason: null, consecutiveFailures: 0 });
    }
    await request.db.webhookEndpoint.updateMany({ where: { id: before.id, tenantId: request.tenant.id }, data });
    const after = (await request.db.webhookEndpoint.findFirst({ where: { id: before.id, tenantId: request.tenant.id } }))!;
    const changes = diff(view(before) as Record<string, unknown>, data);
    if (Object.keys(changes).length) await audit(request, 'webhook.updated', { resource: { type: 'webhook', id: before.id, label: after.url }, changes });
    return view(after);
  });

  fastify.post('/:id/rotate-secret', {
    config: { permission: 'api:manage', rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: { tags: ['webhooks'], summary: 'Replace the signing secret: the new one is returned once, the old one stops working' },
  }, async (request) => {
    assertPerson(request);
    const e = await endpointOf(request);
    const secret = newSigningSecret();
    await request.db.webhookEndpoint.update({ where: { id: e.id }, data: { signingSecret: secret } });
    await audit(request, 'webhook.secret_rotated', { resource: { type: 'webhook', id: e.id, label: e.url } });
    return { secret };
  });

  fastify.delete('/:id', {
    config: { permission: 'api:manage' },
    schema: { tags: ['webhooks'], summary: 'Remove a webhook and its deliveries' },
  }, async (request, reply) => {
    assertPerson(request);
    const e = await endpointOf(request);
    await request.db.webhookEndpoint.deleteMany({ where: { id: e.id, tenantId: request.tenant.id } });
    await audit(request, 'webhook.deleted', { resource: { type: 'webhook', id: e.id, label: e.url } });
    return reply.status(204).send();
  });

  fastify.post('/:id/test', {
    config: { permission: 'api:manage', rateLimit: { max: 20, timeWindow: '10 minutes' } },
    schema: { tags: ['webhooks'], summary: 'Send a test event now and report what the endpoint answered' },
  }, async (request) => {
    const e = await endpointOf(request);
    return sendTestEvent(request.tenant.id, e.id);
  });

  fastify.get('/:id/deliveries', {
    config: { permission: 'api:read' },
    schema: { tags: ['webhooks'], summary: 'Recent deliveries to a webhook, newest first' },
  }, async (request) => {
    const e = await endpointOf(request);
    const q = z.object({ status: z.enum(['PENDING', 'SENDING', 'DELIVERED', 'FAILED']).optional(), limit: z.coerce.number().int().min(1).max(100).catch(25).default(25) }).parse(request.query);
    const rows = await request.db.webhookDelivery.findMany({
      where: { tenantId: request.tenant.id, endpointId: e.id, ...(q.status && { status: q.status }) },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    return {
      deliveries: rows.map((d) => ({
        id: d.id, eventId: d.eventId, type: d.type, status: d.status, attempts: d.attempts, nextAttemptAt: d.status === 'PENDING' ? d.nextAttemptAt : null,
        responseStatus: d.responseStatus, lastError: d.lastError, durationMs: d.durationMs, deliveredAt: d.deliveredAt, createdAt: d.createdAt, payload: d.payload,
      })),
    };
  });

  fastify.post('/deliveries/:id/retry', {
    config: { permission: 'api:manage' },
    schema: { tags: ['webhooks'], summary: 'Send a delivery again' },
  }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await retryDelivery(request.tenant.id, id);
    return reply.status(202).send({ retrying: true });
  });
};
