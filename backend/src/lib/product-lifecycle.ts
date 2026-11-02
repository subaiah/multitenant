/**
 * Lifecycle events for external products (docs/PRODUCT_INTEGRATION.md): the
 * platform tells a product when an organization turns it on, changes or ends
 * that, is suspended or resumed, or is deleted, so the product can set the
 * organization up or clean it up.
 *
 * - Only for products with a callback address (their manifest's
 *   provisioning.callbackUrl, or the Applications page).
 * - An outbox (product_events): written where the change happens, sent by
 *   the job runner and straight away after a change. Signed like webhooks
 *   (Standard Webhooks), with the product's own signing secret.
 * - In order per product and organization: an event waits while an earlier
 *   one for the same pair is still being sent.
 * - Retried with backoff (about two days), then given up.
 * - organization.entitled sets the organization's setup status: PENDING when
 *   sent, READY when the product answers 2xx (other than 202), or later when
 *   it reports READY or FAILED (routes/product-api.ts) after answering 202.
 *   The Applications page's Open button and the sidebar wait for READY.
 */
import { randomBytes } from 'node:crypto';
import { controlDb } from './prisma.js';
import { decryptSecret, secretContext } from './secrets.js';
import { newSigningSecret, post, sign } from './webhooks.js';
import { z } from 'zod';
import { config } from '../config/env.js';

export const LIFECYCLE_EVENTS = [
  'organization.entitled',
  'organization.entitlement_changed',
  'organization.suspended',
  'organization.resumed',
  'organization.deprovisioned',
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const STALE_CLAIM_MS = 5 * 60_000;
const ACTIVE = ['ENABLED', 'TRIAL'];


/** http(s), without credentials or a fragment: platform staff register it, so inside addresses are allowed */
export const callbackUrlSchema = z.string().max(2000).refine((v) => {
  try {
    const u = new URL(v);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}, 'An http(s) address without a user name, password or #fragment');

export const isActiveState = (state: string) => ACTIVE.includes(state);
export const newCallbackSecret = newSigningSecret;

type Tx = Pick<typeof controlDb, 'productEvent' | 'tenantApplication' | 'applicationRegistry' | 'tenant'>;

interface Entitlement {
  tenantId: string;
  applicationId: string;
  state: string;
  validFrom: Date;
  validTo: Date | null;
}

/**
 * Queue an event for one organization and product, if the product takes
 * them. Returns whether one was queued. Call inside the transaction that made
 * the change when there is one.
 */
export async function queueLifecycleEvent(
  tx: Tx,
  type: LifecycleEvent,
  entitlement: Entitlement,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const app = await tx.applicationRegistry.findUnique({
    where: { id: entitlement.applicationId },
    select: { key: true, provisioningCallbackUrl: true, deletesDataOnDeprovision: true },
  });
  if (!app?.provisioningCallbackUrl) return false;
  const tenant = await tx.tenant.findUnique({ where: { id: entitlement.tenantId }, select: { id: true, slug: true, name: true, status: true } });
  const publicId = `evt_${randomBytes(12).toString('base64url')}`;
  const payload = {
    id: publicId,
    type,
    timestamp: new Date().toISOString(),
    data: {
      application: { key: app.key },
      organization: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name, suspended: tenant.status === 'SUSPENDED' } : { id: entitlement.tenantId },
      entitlement: type === 'organization.deprovisioned' ? null : { state: entitlement.state, validFrom: entitlement.validFrom.toISOString(), validTo: entitlement.validTo?.toISOString() ?? null },
      ...(type === 'organization.deprovisioned' && { deleteData: app.deletesDataOnDeprovision }),
      ...extra,
    },
  };
  await tx.productEvent.create({ data: { publicId, applicationId: entitlement.applicationId, tenantId: entitlement.tenantId, type, payload } });
  if (type === 'organization.entitled') {
    await tx.tenantApplication.updateMany({
      where: { tenantId: entitlement.tenantId, applicationId: entitlement.applicationId },
      data: { provisioningStatus: 'PENDING', provisioningError: null },
    });
  }
  return true;
}

/** What changing an entitlement means for the product (create: before is null; delete: after is null) */
export async function entitlementChanged(tx: Tx, before: Entitlement | null, after: Entitlement | null): Promise<boolean> {
  if (!after) return before ? queueLifecycleEvent(tx, 'organization.deprovisioned', before, { reason: 'entitlement_removed' }) : false;
  const wasOn = !!before && isActiveState(before.state);
  const isOn = isActiveState(after.state);
  if (isOn && !wasOn) return queueLifecycleEvent(tx, 'organization.entitled', after);
  if (!before) return false;
  const changed = before.state !== after.state || before.validTo?.getTime() !== after.validTo?.getTime() || before.validFrom.getTime() !== after.validFrom.getTime();
  return changed ? queueLifecycleEvent(tx, 'organization.entitlement_changed', after) : false;
}

/** An organization was suspended or resumed: every product it has tells */
export async function organizationStatusChanged(tenantId: string, before: string, after: string): Promise<void> {
  const type = before !== 'SUSPENDED' && after === 'SUSPENDED' ? 'organization.suspended' : before === 'SUSPENDED' && after !== 'SUSPENDED' ? 'organization.resumed' : null;
  if (!type) return;
  const entitlements = await controlDb.tenantApplication.findMany({ where: { tenantId } });
  let queued = false;
  for (const e of entitlements) queued = (await queueLifecycleEvent(controlDb, type, e)) || queued;
  if (queued) kickLifecycleEvents();
}

/** An organization is being deleted: every product it had is told to clean up (before its entitlements go) */
export async function organizationDeleting(tenantId: string): Promise<void> {
  const entitlements = await controlDb.tenantApplication.findMany({ where: { tenantId } });
  let queued = false;
  for (const e of entitlements) queued = (await queueLifecycleEvent(controlDb, 'organization.deprovisioned', e, { reason: 'organization_deleted' })) || queued;
  if (queued) kickLifecycleEvents();
}

/**
 * A product's callback address was set or changed: organizations that have
 * it on and weren't told yet are told now. Removed: nothing to wait for.
 */
export async function callbackChanged(applicationId: string, hadCallback: boolean, hasCallback: boolean): Promise<number> {
  if (!hasCallback) {
    await controlDb.tenantApplication.updateMany({ where: { applicationId, provisioningStatus: { in: ['PENDING', 'FAILED'] } }, data: { provisioningStatus: 'NOT_REQUIRED', provisioningError: null } });
    return 0;
  }
  if (hadCallback) return 0;
  const waiting = await controlDb.tenantApplication.findMany({ where: { applicationId, state: { in: ACTIVE }, provisioningStatus: 'NOT_REQUIRED' } });
  for (const e of waiting) await queueLifecycleEvent(controlDb, 'organization.entitled', e);
  if (waiting.length) kickLifecycleEvents();
  return waiting.length;
}

/** The product's report on setting an organization up (after answering 202) */
export async function reportProvisioning(applicationId: string, tenantId: string, status: 'READY' | 'FAILED', message?: string): Promise<boolean> {
  const { count } = await controlDb.tenantApplication.updateMany({
    where: { applicationId, tenantId },
    data: status === 'READY'
      ? { provisioningStatus: 'READY', provisionedAt: new Date(), provisioningError: null }
      : { provisioningStatus: 'FAILED', provisioningError: (message ?? 'The application reported a failure').slice(0, 500) },
  });
  return count > 0;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

let log: (msg: string, err?: unknown) => void = (msg, err) => console.error(msg, err);
let running: Promise<number> | null = null;
let again = false;

/** Send what's due now (and again if more was queued meanwhile) */
export function kickLifecycleEvents(): void {
  if (running) {
    again = true;
    return;
  }
  running = sendDueLifecycleEvents()
    .catch((err) => {
      log('Sending lifecycle events failed', err);
      return 0;
    })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        kickLifecycleEvents();
      }
    });
}

/** Everything queued so far has been tried (tests, shutdown) */
export async function lifecycleEventsSettled(): Promise<void> {
  while (running) await running;
}

export async function sendDueLifecycleEvents(): Promise<number> {
  const now = new Date();
  const due = await controlDb.productEvent.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now }, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } }] },
    orderBy: { seq: 'asc' },
    take: 50,
  });
  let sent = 0;
  for (const e of due) {
    // In order: wait while an earlier event for this organization and product is still going
    const earlier = await controlDb.productEvent.count({ where: { applicationId: e.applicationId, tenantId: e.tenantId, status: 'PENDING', seq: { lt: e.seq } } });
    if (earlier) continue;
    const claimed = await controlDb.productEvent.updateMany({
      where: { id: e.id, status: 'PENDING', OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }] },
      data: { claimedAt: new Date() },
    });
    if (!claimed.count) continue;
    await deliver(e.id);
    sent++;
  }
  return sent;
}

async function deliver(eventId: string): Promise<void> {
  const e = await controlDb.productEvent.findUniqueOrThrow({
    where: { id: eventId },
    include: { application: { select: { provisioningCallbackUrl: true, callbackSigningSecret: true } } },
  });
  const url = e.application.provisioningCallbackUrl;
  const secret = e.application.callbackSigningSecret;
  if (!url || !secret) {
    await controlDb.productEvent.update({ where: { id: e.id }, data: { status: 'FAILED', claimedAt: null, lastError: 'The application no longer has a callback address' } });
    return;
  }
  const body = JSON.stringify(e.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const result = await post(url, {
    'webhook-id': e.publicId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': sign(decryptSecret(secret, secretContext('callbackSigningSecret')), e.publicId, timestamp, body),
  }, body, { trusted: true, userAgent: 'Multitenant-Lifecycle/1' });

  const attempts = e.attempts + 1;
  if (result.ok) {
    await controlDb.productEvent.update({ where: { id: e.id }, data: { status: 'DELIVERED', attempts, claimedAt: null, deliveredAt: new Date(), lastStatus: result.status, lastError: null } });
    // Set up at once, unless the product said it will report back (202)
    if (e.type === 'organization.entitled' && result.status !== 202) {
      await controlDb.tenantApplication.updateMany({
        where: { applicationId: e.applicationId, tenantId: e.tenantId, provisioningStatus: 'PENDING' },
        data: { provisioningStatus: 'READY', provisionedAt: new Date(), provisioningError: null },
      });
    }
    return;
  }
  const givingUp = attempts >= MAX_ATTEMPTS;
  await controlDb.productEvent.update({
    where: { id: e.id },
    data: {
      attempts,
      claimedAt: null,
      lastStatus: result.status,
      lastError: result.error,
      ...(givingUp ? { status: 'FAILED' } : { nextAttemptAt: new Date(Date.now() + BACKOFF_MS[attempts - 1]) }),
    },
  });
  if (givingUp && e.type === 'organization.entitled') {
    await controlDb.tenantApplication.updateMany({
      where: { applicationId: e.applicationId, tenantId: e.tenantId, provisioningStatus: 'PENDING' },
      data: { provisioningStatus: 'FAILED', provisioningError: `The application couldn't be reached: ${result.error}` },
    });
  }
}

/** Try an event again now (platform staff, after fixing the product) */
export async function retryLifecycleEvent(applicationId: string, eventId: string): Promise<boolean> {
  const { count } = await controlDb.productEvent.updateMany({
    where: { id: eventId, applicationId, status: { in: ['PENDING', 'FAILED'] } },
    data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), claimedAt: null },
  });
  if (count) {
    const e = await controlDb.productEvent.findUniqueOrThrow({ where: { id: eventId } });
    if (e.type === 'organization.entitled') {
      await controlDb.tenantApplication.updateMany({ where: { applicationId, tenantId: e.tenantId, provisioningStatus: 'FAILED' }, data: { provisioningStatus: 'PENDING', provisioningError: null } });
    }
    kickLifecycleEvents();
  }
  return count > 0;
}

// ---------------------------------------------------------------------------
// For the job runner
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | undefined;
export function startLifecycleEvents(logger: (msg: string, err?: unknown) => void) {
  log = logger;
  if (timer || config.notificationPollMs <= 0) return;
  timer = setInterval(kickLifecycleEvents, config.notificationPollMs);
  timer.unref();
}
export function stopLifecycleEvents() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
