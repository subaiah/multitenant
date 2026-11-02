/**
 * Lifecycle events for external products (docs/PRODUCT_INTEGRATION.md): the
 * platform tells a product when an organization turns it on, changes or ends
 * that, is suspended or resumed, or is deleted, so the product can set the
 * organization up or clean it up.
 *
 * - Only for products with a callback address (their manifest's
 *   provisioning.callbackUrl, or the Applications page).
 * - An outbox (product_events): written in the same transaction as the
 *   change, sent by the job runner and straight away after it. Signed like
 *   webhooks (Standard Webhooks) with the product's own secret; during a
 *   rotation, with the old one as well until it expires.
 * - In order per product and organization: an event waits while an earlier
 *   one for the same pair is still being sent.
 * - Retried with backoff and jitter (about a day and a half), then given up.
 * - Setup operations: organization.entitled starts one, with a new operation
 *   id and a higher generation. Its result (the product's 2xx answer, or its
 *   report after answering 202) only counts for the current operation, so a
 *   late answer can't overwrite a newer setup. The Applications page, the
 *   sidebar and sign-in wait for READY.
 */
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { controlDb } from './prisma.js';
import { decryptSecret, secretContext } from './secrets.js';
import { isPrivateAddress, newSigningSecret, post, sign } from './webhooks.js';
import { config } from '../config/env.js';

export const LIFECYCLE_EVENTS = [
  'organization.entitled',
  'organization.entitlement_changed',
  'organization.suspended',
  'organization.resumed',
  'organization.deprovisioning_requested',
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];
export const SCHEMA_VERSION = 1;

const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const STALE_CLAIM_MS = 5 * 60_000;
/** How long the secret before a rotation keeps signing alongside the new one */
export const ROTATION_OVERLAP_MS = 24 * 60 * 60_000;
const ACTIVE = ['ENABLED', 'TRIAL'];

export const isActiveState = (state: string) => ACTIVE.includes(state);
export const newCallbackSecret = newSigningSecret;
const newOperationId = () => `op_${randomBytes(12).toString('base64url')}`;
/** ±20%, so many retries after one outage don't arrive together */
const withJitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4));

// ---------------------------------------------------------------------------
// Callback addresses
// ---------------------------------------------------------------------------

/**
 * Why a callback address can't be used, or null. In production: https, and
 * not an inside address (loopback, private, link-local, cloud metadata),
 * unless the host is listed in PRODUCT_CALLBACK_ALLOWED_HOSTS (a product on
 * the same network, e.g. "appforge"). Elsewhere, any http(s) address.
 */
export function callbackUrlProblem(value: string, { production = config.nodeEnv === 'production', allowedHosts = config.productCallbackAllowedHosts } = {}): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return 'Not a valid address';
  }
  if (!['https:', 'http:'].includes(u.protocol)) return 'Use an http(s) address';
  if (u.username || u.password) return "Don't put a user name or password in the address";
  if (u.hash) return 'Leave out the #fragment';
  if (!production || allowedHosts.includes(u.hostname.toLowerCase())) return null;
  if (u.protocol !== 'https:') return 'Use https (or add the host to PRODUCT_CALLBACK_ALLOWED_HOSTS)';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || (isIP(host) && isPrivateAddress(host))) {
    return 'That is an inside address: add the host to PRODUCT_CALLBACK_ALLOWED_HOSTS to allow it';
  }
  return null;
}
export const callbackUrlSchema = z.string().max(2000).superRefine((v, ctx) => {
  const problem = callbackUrlProblem(v);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});
/** Allowed hosts (and anything outside production) are sent to as given; others through the webhook guard, checked on every connection */
export const trustedCallback = (url: string) => config.nodeEnv !== 'production' || config.productCallbackAllowedHosts.includes(new URL(url).hostname.toLowerCase());

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

type Tx = Pick<typeof controlDb, 'productEvent' | 'tenantApplication' | 'applicationRegistry' | 'tenant'>;

interface Entitlement {
  tenantId: string;
  applicationId: string;
  state: string;
  validFrom: Date;
  validTo: Date | null;
  provisioningGeneration: number;
  provisioningOperationId: string | null;
}

/**
 * Queue an event for one organization and product, if the product takes
 * them. Returns whether one was queued. Call inside the transaction that made
 * the change.
 */
export async function queueLifecycleEvent(tx: Tx, type: LifecycleEvent, entitlement: Entitlement, extra: Record<string, unknown> = {}): Promise<boolean> {
  const app = await tx.applicationRegistry.findUnique({
    where: { id: entitlement.applicationId },
    select: { id: true, key: true, provisioningCallbackUrl: true, deletesDataOnDeprovision: true },
  });
  if (!app?.provisioningCallbackUrl) return false;
  const tenant = await tx.tenant.findUnique({ where: { id: entitlement.tenantId }, select: { id: true, slug: true, name: true, status: true } });

  // A new operation for setting up, and for cleaning up; the others belong to the current one
  const starts = type === 'organization.entitled' || type === 'organization.deprovisioning_requested';
  const operation = starts
    ? { id: newOperationId(), generation: entitlement.provisioningGeneration + 1 }
    : entitlement.provisioningOperationId ? { id: entitlement.provisioningOperationId, generation: entitlement.provisioningGeneration } : null;
  const ending = type === 'organization.deprovisioning_requested';

  const publicId = `evt_${randomBytes(12).toString('base64url')}`;
  const payload = {
    id: publicId,
    type,
    timestamp: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    data: {
      application: { id: app.id, key: app.key },
      organization: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name, suspended: tenant.status === 'SUSPENDED' } : { id: entitlement.tenantId },
      entitlement: ending ? null : { state: entitlement.state, validFrom: entitlement.validFrom.toISOString(), validTo: entitlement.validTo?.toISOString() ?? null },
      operation,
      ...(ending && { deleteData: app.deletesDataOnDeprovision }),
      ...extra,
    },
  };
  await tx.productEvent.create({
    data: { publicId, applicationId: app.id, tenantId: entitlement.tenantId, type, payload, operationId: operation?.id ?? null, generation: operation?.generation ?? null },
  });
  if (type === 'organization.entitled' && operation) {
    await tx.tenantApplication.updateMany({
      where: { tenantId: entitlement.tenantId, applicationId: app.id },
      data: { provisioningStatus: 'PENDING', provisioningError: null, provisioningGeneration: operation.generation, provisioningOperationId: operation.id },
    });
  }
  return true;
}

/**
 * Queue any other event for a product and organization (user events,
 * lib/product-user-events.ts), with the same envelope. Call inside the
 * transaction that decided it.
 */
export async function queueProductEvent(
  tx: Pick<typeof controlDb, 'productEvent'>,
  e: { applicationId: string; applicationKey: string; tenantId: string; type: string; data: Record<string, unknown> },
): Promise<void> {
  const publicId = `evt_${randomBytes(12).toString('base64url')}`;
  const payload = {
    id: publicId,
    type: e.type,
    timestamp: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    data: { application: { id: e.applicationId, key: e.applicationKey }, ...e.data },
  };
  await tx.productEvent.create({ data: { publicId, applicationId: e.applicationId, tenantId: e.tenantId, type: e.type, payload } });
}

/** What changing an entitlement means for the product (create: before is null; delete: after is null) */
export async function entitlementChanged(tx: Tx, before: Entitlement | null, after: Entitlement | null): Promise<boolean> {
  if (!after) return before ? queueLifecycleEvent(tx, 'organization.deprovisioning_requested', before, { reason: 'entitlement_removed' }) : false;
  const wasOn = !!before && isActiveState(before.state);
  const isOn = isActiveState(after.state);
  if (isOn && !wasOn) return queueLifecycleEvent(tx, 'organization.entitled', after);
  if (!before) return false;
  const changed = before.state !== after.state || before.validTo?.getTime() !== after.validTo?.getTime() || before.validFrom.getTime() !== after.validFrom.getTime();
  return changed ? queueLifecycleEvent(tx, 'organization.entitlement_changed', after) : false;
}

/** An organization was suspended or resumed: every product it has is told (call in the transaction that changed it) */
export async function organizationStatusChanged(tx: Tx, tenantId: string, before: string, after: string): Promise<boolean> {
  const type = before !== 'SUSPENDED' && after === 'SUSPENDED' ? 'organization.suspended' : before === 'SUSPENDED' && after !== 'SUSPENDED' ? 'organization.resumed' : null;
  if (!type) return false;
  let queued = false;
  for (const e of await tx.tenantApplication.findMany({ where: { tenantId } })) queued = (await queueLifecycleEvent(tx, type, e)) || queued;
  return queued;
}

/** An organization is being deleted: every product it had is told to clean up (in the transaction that deletes it) */
export async function organizationDeleting(tx: Tx, tenantId: string): Promise<boolean> {
  let queued = false;
  for (const e of await tx.tenantApplication.findMany({ where: { tenantId } })) {
    queued = (await queueLifecycleEvent(tx, 'organization.deprovisioning_requested', e, { reason: 'organization_deleted' })) || queued;
  }
  return queued;
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
  for (const e of waiting) await controlDb.$transaction((tx) => queueLifecycleEvent(tx, 'organization.entitled', e));
  if (waiting.length) kickLifecycleEvents();
  return waiting.length;
}

// ---------------------------------------------------------------------------
// The product's report on a setup operation (after answering 202)
// ---------------------------------------------------------------------------

export type ReportOutcome =
  | { ok: true; changed: boolean; tenantId: string }
  | { ok: false; reason: 'NOT_FOUND' | 'STALE' | 'INVALID_TRANSITION'; message: string };

/**
 * Record a product's result for one of its setup operations. Only the
 * current operation counts (generation must match); repeating the same
 * result is harmless; READY can't turn into FAILED (a failure later is the
 * product's to handle, not a setup result).
 */
export async function reportOperationResult(
  applicationId: string,
  operationId: string,
  generation: number,
  status: 'READY' | 'FAILED',
  message?: string,
): Promise<ReportOutcome> {
  return controlDb.$transaction(async (tx) => {
    const current = await tx.tenantApplication.findFirst({ where: { applicationId, provisioningOperationId: operationId } });
    if (!current) {
      const known = await tx.productEvent.findFirst({ where: { applicationId, operationId }, select: { id: true } });
      return known
        ? { ok: false as const, reason: 'STALE' as const, message: 'A newer operation has replaced this one (or the organization no longer has the application)' }
        : { ok: false as const, reason: 'NOT_FOUND' as const, message: 'No such operation for this application' };
    }
    if (current.provisioningGeneration !== generation) {
      return { ok: false as const, reason: 'STALE' as const, message: `This operation is generation ${current.provisioningGeneration}` };
    }
    const error = status === 'FAILED' ? (message ?? 'The application reported a failure').slice(0, 500) : null;
    if (current.provisioningStatus === status && (status === 'READY' || current.provisioningError === error)) {
      return { ok: true as const, changed: false, tenantId: current.tenantId };
    }
    if (current.provisioningStatus === 'READY' && status === 'FAILED') {
      return { ok: false as const, reason: 'INVALID_TRANSITION' as const, message: 'This operation already finished (READY)' };
    }
    if (!['PENDING', 'FAILED'].includes(current.provisioningStatus)) {
      return { ok: false as const, reason: 'INVALID_TRANSITION' as const, message: `Nothing is waiting for a result (${current.provisioningStatus})` };
    }
    // Only if it's still this operation (a newer one may have started meanwhile)
    const { count } = await tx.tenantApplication.updateMany({
      where: { id: current.id, provisioningOperationId: operationId, provisioningGeneration: generation },
      data: status === 'READY' ? { provisioningStatus: 'READY', provisionedAt: new Date(), provisioningError: null } : { provisioningStatus: 'FAILED', provisioningError: error },
    });
    return count ? { ok: true as const, changed: true, tenantId: current.tenantId } : { ok: false as const, reason: 'STALE' as const, message: 'A newer operation has replaced this one' };
  });
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
    try {
      await deliver(e.id);
    } catch (err) {
      // Something on our side (a secret that won't decrypt, the database): a failed attempt, shown on the panel
      log('Delivering a lifecycle event failed', err);
      const attempts = e.attempts + 1;
      await controlDb.productEvent.update({
        where: { id: e.id },
        data: {
          attempts, claimedAt: null, lastStatus: null, lastError: `Not sent: ${(err as Error).message}`.slice(0, 300),
          ...(attempts >= MAX_ATTEMPTS ? { status: 'FAILED' } : { nextAttemptAt: new Date(Date.now() + withJitter(BACKOFF_MS[attempts - 1])) }),
        },
      }).catch(() => {});
    }
    sent++;
  }
  return sent;
}

/** The secrets an event is signed with now: the current one, and the one before a rotation until it expires */
export function signingSecrets(app: { callbackSigningSecret: string | null; previousCallbackSigningSecret: string | null; previousCallbackSecretExpiresAt: Date | null }, now = new Date()): string[] {
  const list: string[] = [];
  if (app.callbackSigningSecret) list.push(decryptSecret(app.callbackSigningSecret, secretContext('callbackSigningSecret')));
  if (app.previousCallbackSigningSecret && app.previousCallbackSecretExpiresAt && app.previousCallbackSecretExpiresAt > now) {
    list.push(decryptSecret(app.previousCallbackSigningSecret, secretContext('previousCallbackSigningSecret')));
  }
  return list;
}

async function deliver(eventId: string): Promise<void> {
  const e = await controlDb.productEvent.findUniqueOrThrow({
    where: { id: eventId },
    include: { application: { select: { provisioningCallbackUrl: true, callbackSigningSecret: true, previousCallbackSigningSecret: true, previousCallbackSecretExpiresAt: true } } },
  });
  const url = e.application.provisioningCallbackUrl;
  const secrets = signingSecrets(e.application);
  if (!url || !secrets.length) {
    await controlDb.productEvent.update({ where: { id: e.id }, data: { status: 'FAILED', claimedAt: null, lastError: 'The application no longer has a callback address' } });
    return;
  }
  const body = JSON.stringify(e.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  // Standard Webhooks: several signatures, space-separated; any one verifies
  const signature = secrets.map((s) => sign(s, e.publicId, timestamp, body)).join(' ');
  const result = await post(url, { 'webhook-id': e.publicId, 'webhook-timestamp': String(timestamp), 'webhook-signature': signature }, body, {
    trusted: trustedCallback(url),
    userAgent: 'Multitenant-Lifecycle/1',
  });

  const attempts = e.attempts + 1;
  // Results only count for the organization's current setup operation
  const currentOperation = { applicationId: e.applicationId, tenantId: e.tenantId, provisioningOperationId: e.operationId ?? '-', provisioningStatus: 'PENDING' as const };
  if (result.ok) {
    await controlDb.productEvent.update({ where: { id: e.id }, data: { status: 'DELIVERED', attempts, claimedAt: null, deliveredAt: new Date(), lastStatus: result.status, lastError: null } });
    // Set up at once, unless the product said it will report back (202)
    if (e.type === 'organization.entitled' && result.status !== 202) {
      await controlDb.tenantApplication.updateMany({ where: currentOperation, data: { provisioningStatus: 'READY', provisionedAt: new Date(), provisioningError: null } });
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
      ...(givingUp ? { status: 'FAILED' } : { nextAttemptAt: new Date(Date.now() + withJitter(BACKOFF_MS[attempts - 1])) }),
    },
  });
  if (givingUp && e.type === 'organization.entitled') {
    await controlDb.tenantApplication.updateMany({ where: currentOperation, data: { provisioningStatus: 'FAILED', provisioningError: `The application couldn't be reached: ${result.error}` } });
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
    if (e.type === 'organization.entitled' && e.operationId) {
      await controlDb.tenantApplication.updateMany({
        where: { applicationId, tenantId: e.tenantId, provisioningOperationId: e.operationId, provisioningStatus: 'FAILED' },
        data: { provisioningStatus: 'PENDING', provisioningError: null },
      });
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
