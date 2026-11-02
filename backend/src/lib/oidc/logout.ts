/**
 * Ending a person's sessions in the applications they signed in to
 * ("Sign in with"; docs/SIGN_IN_WITH.md): OpenID Connect Back-Channel
 * Logout 1.0.
 *
 * - When: they sign out everywhere; they're deactivated or removed; their
 *   organization is suspended, closed or deleted; or it turns the
 *   application off. (Signing out of the site in one browser doesn't: the
 *   token carries no session id, so it would end their sessions on every
 *   device. Applications sign people out with RP-initiated logout, which
 *   also signs them out of the site.)
 * - What: the provider's own record of them (grants, with their access and
 *   refresh tokens, and sessions) is deleted at once, so nothing it issued
 *   keeps working; and each application they signed in to that has a
 *   back-channel logout address is sent a logout token.
 * - The logout token is a JWT signed with the provider's key (RS256, as ID
 *   tokens): iss, aud (the client id), iat, exp (2 minutes), jti, sub and the
 *   back-channel logout event; no nonce, no sid (back_channel_logout_session
 *   is not required). It is POSTed as logout_token, form-encoded, and the
 *   application answers 200 or 204.
 * - Sent from an outbox (oidc_logout_deliveries), so a missed one is
 *   retried with backoff, a fresh token each time; given up after about a
 *   day and a half.
 */
import { randomBytes } from 'node:crypto';
import { SignJWT, importJWK } from 'jose';
import type { Prisma } from '../../generated/control/client.js';
import { controlDb } from '../prisma.js';
import { post } from '../webhooks.js';
import { trustedCallback } from '../product-lifecycle.js';
import { signingKeys } from './keys.js';
import { issuer } from './provider.js';
import { config } from '../../config/env.js';
import { onAudit, PLATFORM_CHAIN, type AuditContent } from '../audit.js';
import { accountIdFor } from './accounts.js';

export const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const TOKEN_LIFETIME_S = 120;
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const STALE_CLAIM_MS = 5 * 60_000;
const withJitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4));

let log: (msg: string, err?: unknown) => void = (msg, err) => console.error(msg, err);

export type LogoutReason =
  | 'signed_out_everywhere' | 'deactivated' | 'removed'
  | 'organization_suspended' | 'organization_closed' | 'application_turned_off';

/** Who: some people, or everyone in an organization; optionally only one application */
export type LogoutScope = { accountIds: string[]; applicationId?: string } | { tenantId: string; applicationId?: string };

/**
 * End the scope's sessions in the applications: delete what the provider
 * issued, and queue a logout token for each application they signed in to
 * that asks for them. Returns how many were queued.
 */
export async function endApplicationSessions(scope: LogoutScope, reason: LogoutReason): Promise<number> {
  const clientIds = scope.applicationId
    ? (await controlDb.applicationSignIn.findMany({ where: { applicationId: scope.applicationId }, select: { clientId: true } })).map((s) => s.clientId)
    : null;
  if (clientIds && !clientIds.length) return 0;
  if ('accountIds' in scope && !scope.accountIds.length) return 0;
  const who: Prisma.OidcPayloadWhereInput = 'accountIds' in scope
    ? { OR: scope.accountIds.map((id) => ({ payload: { path: ['accountId'], equals: id } })) }
    : { payload: { path: ['accountId'], string_starts_with: `${scope.tenantId}.` } };

  // What they signed in to: the provider's grants (one per person and application)
  const forClients = clientIds ? [{ OR: clientIds.map((c) => ({ payload: { path: ['clientId'], equals: c } })) }] : [];
  const grants = await controlDb.oidcPayload.findMany({
    where: { model: 'Grant', AND: [who, ...forClients] },
    select: { id: true, payload: true },
  });
  const pairs = new Map<string, { accountId: string; clientId: string }>();
  for (const g of grants) {
    const p = g.payload as { accountId?: string; clientId?: string };
    if (p.accountId && p.clientId) pairs.set(`${p.accountId} ${p.clientId}`, { accountId: p.accountId, clientId: p.clientId });
  }

  // Nothing the provider issued them keeps working: tokens and grants, and (for everything) its sessions
  const grantIds = grants.map((g) => g.id);
  if (grantIds.length) {
    await controlDb.oidcPayload.deleteMany({ where: { grantId: { in: grantIds } } });
    await controlDb.oidcPayload.deleteMany({ where: { model: 'Grant', id: { in: grantIds } } });
  }
  if (!clientIds) await controlDb.oidcPayload.deleteMany({ where: { model: 'Session', AND: [who] } });

  // The applications that want to be told
  const signIns = await controlDb.applicationSignIn.findMany({
    where: { clientId: { in: [...new Set([...pairs.values()].map((p) => p.clientId))] }, backchannelLogoutUri: { not: null } },
    select: { clientId: true, applicationId: true },
  });
  const appOf = new Map(signIns.map((s) => [s.clientId, s.applicationId]));
  const rows = [...pairs.values()].filter((p) => appOf.has(p.clientId)).map((p) => ({ applicationId: appOf.get(p.clientId)!, clientId: p.clientId, accountId: p.accountId, reason }));
  if (rows.length) {
    await controlDb.oidcLogoutDelivery.createMany({ data: rows });
    kickLogouts();
  }
  return rows.length;
}

/** A logout token for one person and application */
export async function logoutToken(clientId: string, accountId: string): Promise<string> {
  const [jwk] = await signingKeys();
  const key = await importJWK(jwk as never, 'RS256');
  return new SignJWT({ events: { [LOGOUT_EVENT]: {} } })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid, typ: 'logout+jwt' })
    .setIssuer(issuer())
    .setAudience(clientId)
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_LIFETIME_S}s`)
    .setJti(randomBytes(16).toString('base64url'))
    .sign(key);
}

// ---------------------------------------------------------------------------
// When: from the audit log
// ---------------------------------------------------------------------------

const ACTIVE_STATES = ['ENABLED', 'TRIAL'];

/** What an audit entry means for sessions in applications, if anything */
export async function logoutFor(chain: string, entry: Pick<AuditContent, 'event' | 'outcome' | 'actorId' | 'resourceId' | 'tenantId'>): Promise<{ scope: LogoutScope; reason: LogoutReason } | null> {
  if (entry.outcome !== 'SUCCESS') return null;
  if (chain === PLATFORM_CHAIN) {
    const tenantId = entry.tenantId;
    if (!tenantId) return null;
    if (entry.event === 'tenant.closed' || entry.event === 'tenant.deleted') return { scope: { tenantId }, reason: 'organization_closed' };
    if (entry.event === 'tenant.updated') {
      const t = await controlDb.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
      return t?.status === 'SUSPENDED' ? { scope: { tenantId }, reason: 'organization_suspended' } : null;
    }
    return null;
  }
  const person = (id: string | null | undefined) => (id ? { accountIds: [accountIdFor(chain, id)] } : null);
  switch (entry.event) {
    case 'auth.signed_out_everywhere': {
      const s = person(entry.actorId);
      return s && { scope: s, reason: 'signed_out_everywhere' };
    }
    case 'user.deactivated': {
      const s = person(entry.resourceId);
      return s && { scope: s, reason: 'deactivated' };
    }
    case 'user.deleted': {
      const s = person(entry.resourceId);
      return s && { scope: s, reason: 'removed' };
    }
    case 'entitlement.updated': {
      // Only when the application is no longer on for the organization
      const applicationId = entry.resourceId;
      if (!applicationId) return null;
      const now = new Date();
      const e = await controlDb.tenantApplication.findUnique({ where: { tenantId_applicationId: { tenantId: chain, applicationId } }, select: { state: true, validFrom: true, validTo: true } });
      const on = !!e && ACTIVE_STATES.includes(e.state) && e.validFrom <= now && (!e.validTo || e.validTo > now);
      return on ? null : { scope: { tenantId: chain, applicationId }, reason: 'application_turned_off' };
    }
    default:
      return null;
  }
}

onAudit(async ({ chain, entry }) => {
  const what = await logoutFor(chain, entry);
  if (what) await endApplicationSessions(what.scope, what.reason);
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

let running: Promise<number> | null = null;
let again = false;

export function kickLogouts(): void {
  if (running) {
    again = true;
    return;
  }
  running = sendDueLogouts()
    .catch((err) => (log('Sending logout tokens failed', err), 0))
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        kickLogouts();
      }
    });
}

export async function logoutsSettled(): Promise<void> {
  while (running) await running;
}

export async function sendDueLogouts(): Promise<number> {
  const now = new Date();
  const due = await controlDb.oidcLogoutDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now }, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } }] },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  let sent = 0;
  for (const d of due) {
    // One server sends each
    const { count } = await controlDb.oidcLogoutDelivery.updateMany({
      where: { id: d.id, status: 'PENDING', OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }] },
      data: { claimedAt: new Date() },
    });
    if (!count) continue;
    await deliver(d.id).catch(async (err) => {
      log('Sending a logout token failed', err);
      await failed(d.id, d.attempts + 1, null, `Not sent: ${(err as Error).message}`);
    });
    sent++;
  }
  return sent;
}

async function failed(id: string, attempts: number, status: number | null, error: string) {
  await controlDb.oidcLogoutDelivery.update({
    where: { id },
    data: {
      attempts, claimedAt: null, lastStatus: status, lastError: error.slice(0, 300),
      ...(attempts >= MAX_ATTEMPTS ? { status: 'FAILED' } : { nextAttemptAt: new Date(Date.now() + withJitter(BACKOFF_MS[attempts - 1])) }),
    },
  }).catch(() => {});
}

async function deliver(id: string): Promise<void> {
  const d = await controlDb.oidcLogoutDelivery.findUniqueOrThrow({ where: { id } });
  const signIn = await controlDb.applicationSignIn.findUnique({ where: { clientId: d.clientId }, select: { backchannelLogoutUri: true } });
  const url = signIn?.backchannelLogoutUri;
  if (!url) {
    await controlDb.oidcLogoutDelivery.update({ where: { id }, data: { status: 'FAILED', claimedAt: null, lastError: 'The application no longer has a back-channel logout address' } });
    return;
  }
  const body = new URLSearchParams({ logout_token: await logoutToken(d.clientId, d.accountId) }).toString();
  const result = await post(url, { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-store' }, body, {
    trusted: trustedCallback(url),
    userAgent: 'Multitenant-Logout/1',
  });
  const attempts = d.attempts + 1;
  // The specification's answers: 200 OK (or 204), nothing else
  if (result.ok && (result.status === 200 || result.status === 204)) {
    await controlDb.oidcLogoutDelivery.update({ where: { id }, data: { status: 'DELIVERED', attempts, claimedAt: null, deliveredAt: new Date(), lastStatus: result.status, lastError: null } });
    return;
  }
  await failed(id, attempts, result.status, result.error ?? `Answered ${result.status}`);
}

// ---------------------------------------------------------------------------
// For the job runner
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | undefined;
export function startLogouts(logger: (msg: string, err?: unknown) => void) {
  log = logger;
  if (timer || config.notificationPollMs <= 0) return;
  timer = setInterval(kickLogouts, config.notificationPollMs);
  timer.unref();
}
export function stopLogouts() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
