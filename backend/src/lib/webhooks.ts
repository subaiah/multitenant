/**
 * Outgoing webhooks: the organization's events, sent to URLs it registers
 * (Developers page). docs/API_ACCESS.md.
 *
 * Events are the organization's audit entries (kit/audit-events.ts, tenant
 * scope): user.created, role.assigned, billing.subscribed and so on. When an
 * entry is recorded, a delivery row per subscribed endpoint is written in the
 * same transaction, so an event is sent if and only if it happened. A
 * sender then posts them, retrying with backoff:
 *
 *   1 min, 5 min, 30 min, 2 h, 5 h, 10 h, 24 h   (8 attempts, about two days)
 *
 * An endpoint whose deliveries keep giving up (DISABLE_AFTER in a row) is
 * turned off and its admins see why; they turn it back on.
 *
 * Signing follows the Standard Webhooks spec (standardwebhooks.com):
 *   webhook-id         the event's id (the same on every retry: deduplicate on it)
 *   webhook-timestamp  seconds since the epoch
 *   webhook-signature  v1,<base64 HMAC-SHA256 of "id.timestamp.body", keyed by the secret's bytes>
 *
 * Only public addresses are called: every connection's address is checked
 * as it's made (no private, loopback, link-local or metadata addresses, so a
 * DNS name can't be pointed at the inside later), and redirects aren't
 * followed. WEBHOOK_ALLOW_PRIVATE=true lifts that for development and tests.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { config } from '../config/env.js';
import { controlDb } from './prisma.js';
import { dbForTenant } from './tenant-db.js';
import { PLATFORM_CHAIN, auditCatalog, onAudit, onAuditInTransaction, recordAudit, type AuditContent } from './audit.js';
import { decryptSecret, secretContext } from './secrets.js';
import { AppError } from '../middleware/error-handler.js';

const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 86_400_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
export const DISABLE_AFTER = 5;
const STALE_CLAIM_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
const KEEP_DAYS = 30;
export const TEST_EVENT = 'webhook.test';

// ---------------------------------------------------------------------------
// Events, payloads, signatures
// ---------------------------------------------------------------------------

/** The events an endpoint can subscribe to: the organization's own audit entries */
export function webhookEvents(): { type: string; label: string; category: string }[] {
  return Object.entries(auditCatalog())
    .filter(([, d]) => d.scope === 'tenant')
    .map(([type, d]) => ({ type, label: d.label, category: d.category }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

export const newSigningSecret = () => `whsec_${randomBytes(24).toString('base64')}`;

export function sign(secret: string, id: string, timestamp: number, body: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export interface WebhookPayload {
  id: string;
  type: string;
  timestamp: string;
  tenantId: string;
  data: {
    actor: { type: string; id: string | null; email: string | null };
    resource: { type: string | null; id: string | null; label: string | null };
    outcome: string;
    changes: unknown;
    details: unknown;
    requestId: string | null;
  };
}

function payloadOf(eventId: string, entry: AuditContent, tenantId: string): WebhookPayload {
  return {
    id: eventId,
    type: entry.event,
    timestamp: entry.occurredAt,
    tenantId,
    data: {
      actor: { type: entry.actorType, id: entry.actorId, email: entry.actorEmail },
      resource: { type: entry.resourceType, id: entry.resourceId, label: entry.resourceLabel },
      outcome: entry.outcome,
      // Already redacted for the audit log: no secrets
      changes: entry.changes ?? null,
      details: entry.details ?? null,
      requestId: entry.requestId,
    },
  };
}

// ---------------------------------------------------------------------------
// Where we may send
// ---------------------------------------------------------------------------

/** Addresses that aren't the public internet */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const s = v4.toLowerCase();
  return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')
    || s.startsWith('64:ff9b:') || s.startsWith('ff');
}

/** Refuse a URL we won't send to (a 400 for the person adding it) */
export function assertWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('That is not a valid URL', 400, true, 'BAD_WEBHOOK_URL');
  }
  const httpAllowed = config.webhookAllowPrivate || config.nodeEnv !== 'production';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && httpAllowed)) throw new AppError('Webhook URLs must use https', 400, true, 'BAD_WEBHOOK_URL');
  if (url.username || url.password) throw new AppError("Webhook URLs can't contain a user name or password: use the signature to check deliveries", 400, true, 'BAD_WEBHOOK_URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!config.webhookAllowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || (isIP(host) && isPrivateAddress(host)))) {
    throw new AppError('Webhooks can only be sent to public addresses', 400, true, 'BAD_WEBHOOK_URL');
  }
  return url;
}

// The address check happens on every connection, so a name can't later be
// pointed at an inside address (DNS rebinding)
const guardedLookup = (hostname: string, options: object, callback: (...args: any[]) => void) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = (Array.isArray(addresses) ? addresses : [addresses]) as { address: string; family: number }[];
    const allowed = config.webhookAllowPrivate ? list : list.filter((a) => !isPrivateAddress(a.address));
    if (!allowed.length) return callback(new Error(`${hostname} resolves to a private address`));
    if ((options as { all?: boolean }).all) return callback(null, allowed);
    callback(null, allowed[0].address, allowed[0].family);
  });
};

export interface SendResult { ok: boolean; status: number | null; error: string | null; durationMs: number }

/** POST one delivery. 2xx is taken; anything else (redirects too) is a failure. */
export function post(url: string, headers: Record<string, string>, body: string): Promise<SendResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = assertWebhookUrl(url);
    } catch (err) {
      resolve({ ok: false, status: null, error: (err as Error).message, durationMs: 0 });
      return;
    }
    const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Multitenant-Webhooks/1', 'content-length': Buffer.byteLength(body).toString(), ...headers },
      lookup: guardedLookup as never,
      timeout: TIMEOUT_MS,
    }, (res) => {
      // Read a little of the answer (to finish the request), then stop
      let read = 0;
      res.on('data', (c: Buffer) => {
        read += c.length;
        if (read > 4096) res.destroy();
      });
      res.on('close', () => {
        const status = res.statusCode ?? 0;
        const ok = status >= 200 && status < 300;
        resolve({ ok, status, error: ok ? null : status >= 300 && status < 400 ? `Answered ${status} (redirects aren't followed)` : `Answered ${status}`, durationMs: Date.now() - started });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`No answer within ${TIMEOUT_MS / 1000} seconds`)));
    req.on('error', (err) => resolve({ ok: false, status: null, error: err.message.slice(0, 300), durationMs: Date.now() - started }));
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// From audit entries to deliveries
// ---------------------------------------------------------------------------

const kick = new Set<string>();
type Tx = { webhookEndpoint: { findMany: (a: object) => Promise<{ id: string; events: string[] }[]> }; webhookDelivery: { createMany: (a: object) => Promise<unknown> } };

onAuditInTransaction(async ({ tx, chain, entry }) => {
  if (chain === PLATFORM_CHAIN) return;
  const t = tx as Tx;
  const endpoints = await t.webhookEndpoint.findMany({ where: { tenantId: chain, enabled: true }, select: { id: true, events: true } });
  const targets = endpoints.filter((e) => e.events.includes('*') || e.events.includes(entry.event));
  if (!targets.length) return;
  const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
  const payload = payloadOf(eventId, entry, chain) as object;
  await t.webhookDelivery.createMany({ data: targets.map((e) => ({ tenantId: chain, endpointId: e.id, eventId, type: entry.event, payload })) });
  kick.add(chain);
});
onAudit(({ chain }) => {
  if (kick.delete(chain)) scheduleWebhooks(chain);
});

export function scheduleWebhooks(tenantId: string) {
  void controlDb.webhookWork
    .upsert({ where: { tenantId }, create: { tenantId, dueAt: new Date() }, update: { dueAt: new Date() } })
    .catch(() => {})
    .finally(() => void processWebhooks(tenantId));
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const running = new Map<string, Promise<void>>();
const again = new Set<string>();
let log: (msg: string, err?: unknown) => void = () => {};
export const setWebhookLogger = (fn: typeof log) => (log = fn);

/** Send one organization's due deliveries. One run per organization at a time in this server. */
export function processWebhooks(tenantId: string): Promise<void> {
  const current = running.get(tenantId);
  if (current) {
    again.add(tenantId);
    return current;
  }
  const run = (async () => {
    try {
      do {
        again.delete(tenantId);
        await processOnce(tenantId);
      } while (again.has(tenantId));
    } catch (err) {
      const gone = !(await controlDb.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }).catch(() => ({ id: tenantId })));
      if (gone) await controlDb.webhookWork.deleteMany({ where: { tenantId } }).catch(() => {});
      else log(`Webhooks for ${tenantId} failed`, err);
    } finally {
      running.delete(tenantId);
    }
  })();
  running.set(tenantId, run);
  return run;
}

async function processOnce(tenantId: string) {
  const db = await dbForTenant(tenantId);
  for (;;) {
    const now = new Date();
    const due = await db.webhookDelivery.findMany({
      where: { tenantId, OR: [{ status: 'PENDING', nextAttemptAt: { lte: now } }, { status: 'SENDING', claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } }] },
      orderBy: { createdAt: 'asc' },
      take: 25,
      include: { endpoint: true },
    });
    if (!due.length) break;
    let claimed = 0;
    for (const d of due) {
      const got = await db.webhookDelivery.updateMany({ where: { id: d.id, tenantId, attempts: d.attempts }, data: { status: 'SENDING', claimedAt: now, attempts: { increment: 1 } } });
      if (!got.count) continue;
      claimed++;
      await deliver(tenantId, { ...d, attempts: d.attempts + 1 });
    }
    if (!claimed) break;
  }
  // When to look again
  const next = await db.webhookDelivery.findFirst({ where: { tenantId, status: 'PENDING' }, orderBy: { nextAttemptAt: 'asc' }, select: { nextAttemptAt: true } });
  if (next) await controlDb.webhookWork.upsert({ where: { tenantId }, create: { tenantId, dueAt: next.nextAttemptAt }, update: { dueAt: next.nextAttemptAt } });
  else await controlDb.webhookWork.deleteMany({ where: { tenantId } });
  // Old deliveries go after a while
  await db.webhookDelivery.deleteMany({ where: { tenantId, status: { in: ['DELIVERED', 'FAILED'] }, createdAt: { lt: new Date(Date.now() - KEEP_DAYS * 86_400_000) } } });
}

type DeliveryRow = { id: string; eventId: string; payload: unknown; attempts: number; endpoint: { id: string; url: string; enabled: boolean; signingSecret: string; consecutiveFailures: number } };

/** `test`: a test event, which isn't retried and doesn't count for or against the endpoint */
async function deliver(tenantId: string, d: DeliveryRow, test = false): Promise<SendResult> {
  const db = await dbForTenant(tenantId);
  if (!d.endpoint.enabled && !test) {
    await db.webhookDelivery.updateMany({ where: { id: d.id, tenantId }, data: { status: 'FAILED', lastError: 'The webhook is turned off', claimedAt: null } });
    return { ok: false, status: null, error: 'The webhook is turned off', durationMs: 0 };
  }
  const body = JSON.stringify(d.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = decryptSecret(d.endpoint.signingSecret, secretContext('signingSecret'));
  const result = await post(d.endpoint.url, {
    'webhook-id': d.eventId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': sign(secret, d.eventId, timestamp, body),
  }, body);

  const common = { responseStatus: result.status, durationMs: result.durationMs, claimedAt: null };
  if (test) {
    await db.webhookDelivery.updateMany({ where: { id: d.id, tenantId }, data: { ...common, status: result.ok ? 'DELIVERED' : 'FAILED', deliveredAt: result.ok ? new Date() : null, lastError: result.error } });
    return result;
  }
  if (result.ok) {
    await db.webhookDelivery.updateMany({ where: { id: d.id, tenantId }, data: { ...common, status: 'DELIVERED', deliveredAt: new Date(), lastError: null } });
    await db.webhookEndpoint.updateMany({ where: { id: d.endpoint.id, tenantId }, data: { lastSuccessAt: new Date(), consecutiveFailures: 0 } });
    return result;
  }
  if (d.attempts < MAX_ATTEMPTS) {
    await db.webhookDelivery.updateMany({ where: { id: d.id, tenantId }, data: { ...common, status: 'PENDING', lastError: result.error, nextAttemptAt: new Date(Date.now() + BACKOFF_MS[d.attempts - 1]) } });
    await db.webhookEndpoint.updateMany({ where: { id: d.endpoint.id, tenantId }, data: { lastFailureAt: new Date() } });
    return result;
  }
  // Given up on: count it against the endpoint
  await db.webhookDelivery.updateMany({ where: { id: d.id, tenantId }, data: { ...common, status: 'FAILED', lastError: result.error } });
  const failures = d.endpoint.consecutiveFailures + 1;
  const disable = failures >= DISABLE_AFTER;
  const reason = disable ? `Turned off after ${failures} deliveries in a row failed (the last: ${result.error ?? 'no answer'})` : null;
  await db.webhookEndpoint.updateMany({
    where: { id: d.endpoint.id, tenantId },
    data: { lastFailureAt: new Date(), consecutiveFailures: failures, ...(disable && { enabled: false, disabledReason: reason }) },
  });
  if (disable) {
    await recordAudit({ actor: { type: 'SYSTEM' }, tenantId }, 'webhook.disabled', { resource: { type: 'webhook', id: d.endpoint.id, label: d.endpoint.url }, details: { reason } }).catch(() => {});
  }
  return result;
}

/** A test event to one endpoint, sent now (whether or not it's subscribed to anything) */
export async function sendTestEvent(tenantId: string, endpointId: string): Promise<SendResult & { deliveryId: string }> {
  const db = await dbForTenant(tenantId);
  const endpoint = await db.webhookEndpoint.findFirst({ where: { id: endpointId, tenantId } });
  if (!endpoint) throw new AppError('Webhook not found', 404);
  const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
  const payload: WebhookPayload = {
    id: eventId, type: TEST_EVENT, timestamp: new Date().toISOString(), tenantId,
    data: { actor: { type: 'SYSTEM', id: null, email: null }, resource: { type: 'webhook', id: endpoint.id, label: endpoint.url }, outcome: 'SUCCESS', changes: null, details: { message: 'A test event: if you can read this, the webhook works.' }, requestId: null },
  };
  const row = await db.webhookDelivery.create({ data: { tenantId, endpointId, eventId, type: TEST_EVENT, payload: payload as object, status: 'SENDING', attempts: MAX_ATTEMPTS, claimedAt: new Date() } });
  const result = await deliver(tenantId, { ...row, endpoint }, true);
  return { ...result, deliveryId: row.id };
}

/** Send a delivery again (a failed one, or one that's waiting for its next attempt) */
export async function retryDelivery(tenantId: string, deliveryId: string) {
  const db = await dbForTenant(tenantId);
  const d = await db.webhookDelivery.findFirst({ where: { id: deliveryId, tenantId }, include: { endpoint: true } });
  if (!d) throw new AppError('Delivery not found', 404);
  if (d.status === 'DELIVERED' || d.status === 'SENDING') throw new AppError(`This delivery is ${d.status.toLowerCase()}`, 409);
  if (!d.endpoint.enabled) throw new AppError('Turn the webhook on first', 409);
  // Another full set of attempts
  await db.webhookDelivery.updateMany({ where: { id: d.id, tenantId }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null } });
  scheduleWebhooks(tenantId);
}

// ---------------------------------------------------------------------------
// For the job runner
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | undefined;
export async function sendDueWebhooks() {
  const due = await controlDb.webhookWork.findMany({ where: { dueAt: { lte: new Date() } }, orderBy: { dueAt: 'asc' }, take: 100 });
  for (const w of due) await processWebhooks(w.tenantId);
}
export function startWebhooks(logger: (msg: string, err?: unknown) => void) {
  log = logger;
  if (timer || config.notificationPollMs <= 0) return;
  timer = setInterval(() => void sendDueWebhooks().catch((err) => log('Sending webhooks failed', err)), config.notificationPollMs);
  timer.unref();
}
export function stopWebhooks() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
export const webhooksSettled = () => Promise.all([...running.values()]);
