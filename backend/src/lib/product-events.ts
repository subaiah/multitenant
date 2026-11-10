/**
 * Applications publishing events for each other and for organizations'
 * webhooks (docs/hub/HUB_GAPS.md G4; routes/product-v1.ts).
 *
 * - An application declares the events it publishes (manifest v2
 *   events.emits: <productId>.<name>) and those of others it wants
 *   (events.subscribes).
 * - POST …/organizations/{id}/events (events.publish) for an organization
 *   that has the publisher turned on: the event goes to every subscribing
 *   application the organization also has on and set up, through the same
 *   outbox as lifecycle events (lib/product-lifecycle.ts: signed with the
 *   receiver's signing secret, Standard Webhooks headers, in order per
 *   receiver and organization, retried with backoff, Retry now). It also goes
 *   to the organization's webhook endpoints that subscribe to the type
 *   (lib/webhooks.ts).
 * - Every copy carries the same eventId, so a receiver deduplicates on it.
 *   An idempotencyKey makes publishing again a no-op answering the first
 *   result.
 * - The platform doesn't validate data against the declared schema (the
 *   schemaUrl is for receivers); it's limited in size and must be an object.
 * - Organizations' administrators see which applications receive which
 *   events (organizationEventFlows), on Application Entitlements.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { controlDb } from './prisma.js';
import { readableOrganization } from './product-data.js';
import { kickLifecycleEvents, queueProductEvent } from './product-lifecycle.js';
import { limit, ownType, userIdsOf } from './product-services.js';
import { declaredTypes, refreshProductCatalog } from './product-catalog.js';
import { queueApplicationWebhookEvent } from './webhooks.js';
import { dbForTenant } from './tenant-db.js';
import type { ServiceCaller } from './product-service.js';
import { AppError } from '../middleware/error-handler.js';

export const MAX_EVENT_DATA = 64 * 1024;
const ACTIVE = ['ENABLED', 'TRIAL'];
const SET_UP = ['READY', 'NOT_REQUIRED'] as ('READY' | 'NOT_REQUIRED')[];
const onNow = (tenantId: string) => {
  const now = new Date();
  return { tenantId, state: { in: ACTIVE }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] };
};

export const publishSchema = z.object({
  type: z.string().max(100),
  data: z.record(z.string(), z.unknown()).refine((d) => JSON.stringify(d).length <= MAX_EVENT_DATA, `data: at most ${MAX_EVENT_DATA / 1024} KB as JSON`),
  /** The person it's about or who caused it, as their subject (optional) */
  subject: z.string().max(200).optional(),
  /** When it happened, if not now */
  occurredAt: z.coerce.date().optional(),
  /** Publishing again with the same key (per organization) does nothing and answers the first result */
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

/** The applications that receive this type for the organization now */
async function receiversOf(type: string, tenantId: string, publisherId: string) {
  return controlDb.productEventSubscription.findMany({
    where: {
      type,
      applicationId: { not: publisherId },
      application: { status: 'ACTIVE', provisioningCallbackUrl: { not: null }, tenantApplications: { some: { ...onNow(tenantId), provisioningStatus: { in: SET_UP } } } },
    },
    include: { application: { select: { id: true, key: true, name: true } } },
  });
}

export async function publishProductEvent(caller: ServiceCaller, tenantId: string, input: unknown) {
  limit('events', caller.credentialId);
  const e = publishSchema.parse(input);
  const db = await readableOrganization(caller.applicationId, tenantId);
  const t = await ownType(caller, 'event', e.type);
  if (e.subject) {
    const [userId] = userIdsOf(tenantId, [e.subject]);
    if (!(await db.user.findFirst({ where: { tenantId, id: userId }, select: { id: true } }))) {
      throw new AppError(`${e.subject} isn't a person in this organization`, 400, true, 'UNKNOWN_SUBJECT');
    }
  }
  const already = async () => e.idempotencyKey
    ? controlDb.productPublishedEvent.findUnique({ where: { applicationId_tenantId_idempotencyKey: { applicationId: caller.applicationId, tenantId, idempotencyKey: e.idempotencyKey } } })
    : null;
  const seen = await already();
  if (seen) return { id: seen.id, applications: seen.applications, webhooks: seen.webhooks, duplicate: true };

  const id = `evt_${randomBytes(12).toString('base64url')}`;
  const occurredAt = (e.occurredAt ?? new Date()).toISOString();
  const tenant = await controlDb.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { id: true, slug: true, name: true, status: true } });
  const receivers = await receiversOf(e.type, tenantId, caller.applicationId);
  try {
    await controlDb.$transaction(async (tx) => {
      await tx.productPublishedEvent.create({ data: { id, applicationId: caller.applicationId, tenantId, type: e.type, idempotencyKey: e.idempotencyKey ?? null, applications: receivers.length } });
      for (const r of receivers) {
        await queueProductEvent(tx, {
          applicationId: r.application.id,
          applicationKey: r.application.key,
          tenantId,
          type: e.type,
          data: {
            organization: { id: tenant.id, slug: tenant.slug, name: tenant.name, suspended: tenant.status === 'SUSPENDED' },
            eventId: id,
            source: { productId: caller.productKey, name: caller.productName },
            subject: e.subject ?? null,
            occurredAt,
            ...(t.schemaUrl && { schemaUrl: t.schemaUrl }),
            event: e.data,
          },
        });
      }
    });
  } catch (err) {
    // The same key published at the same moment: the other one won
    if ((err as { code?: string }).code === 'P2002' && e.idempotencyKey) {
      const won = await already();
      if (won) return { id: won.id, applications: won.applications, webhooks: won.webhooks, duplicate: true };
    }
    throw err;
  }
  if (receivers.length) kickLifecycleEvents();
  const webhooks = await queueApplicationWebhookEvent(tenantId, {
    eventId: id, type: e.type, occurredAt, subject: e.subject ?? null, data: e.data,
    application: { id: caller.applicationId, key: caller.productKey, name: caller.productName },
  });
  if (webhooks) await controlDb.productPublishedEvent.update({ where: { id }, data: { webhooks } });
  return { id, applications: receivers.length, webhooks, duplicate: false };
}

/**
 * For the organization's administrators: each event an application it has
 * on publishes, who receives it (applications it has on, and how many of its
 * webhook endpoints), and how many were published in the last 30 days.
 */
export async function organizationEventFlows(tenantId: string) {
  await refreshProductCatalog();
  const on = await controlDb.tenantApplication.findMany({
    where: onNow(tenantId),
    select: { applicationId: true, provisioningStatus: true, application: { select: { id: true, key: true, name: true, status: true, provisioningCallbackUrl: true } } },
  });
  const onById = new Map(on.filter((e) => e.application.status === 'ACTIVE').map((e) => [e.applicationId, e]));
  const types = declaredTypes().filter((t) => t.kind === 'event' && !t.retired && onById.has(t.applicationId));
  if (!types.length) return { flows: [] };
  const [subs, endpoints, counts] = await Promise.all([
    controlDb.productEventSubscription.findMany({ where: { type: { in: types.map((t) => t.type) } }, orderBy: { position: 'asc' } }),
    dbForTenant(tenantId).then((tdb) => tdb.webhookEndpoint.findMany({ where: { tenantId, enabled: true }, select: { events: true } })),
    controlDb.productPublishedEvent.groupBy({
      by: ['type'],
      where: { tenantId, type: { in: types.map((t) => t.type) }, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
  ]);
  const countOf = new Map(counts.map((c) => [c.type, c]));
  const flows = types.map((t) => ({
    type: t.type,
    label: t.label,
    description: t.description,
    publisher: { id: t.applicationId, key: t.productKey, name: t.productName },
    receivers: subs
      .filter((sub) => sub.type === t.type && sub.applicationId !== t.applicationId && onById.has(sub.applicationId))
      .map((sub) => {
        const e = onById.get(sub.applicationId)!;
        // Why one listed doesn't get them yet
        const waiting = !e.application.provisioningCallbackUrl ? 'has no address for events' : !SET_UP.includes(e.provisioningStatus as never) ? 'still being set up' : null;
        return { id: e.application.id, key: e.application.key, name: e.application.name, reason: sub.reason, waiting };
      }),
    webhooks: endpoints.filter((x) => x.events.includes('*') || x.events.includes(t.type)).length,
    publishedLast30Days: countOf.get(t.type)?._count._all ?? 0,
    lastPublishedAt: countOf.get(t.type)?._max.createdAt?.toISOString() ?? null,
  }));
  flows.sort((a, b) => a.publisher.name.localeCompare(b.publisher.name) || a.type.localeCompare(b.type));
  return { flows };
}
