/**
 * Applications calling each other (docs/adr/0001-app-to-app-calls.md;
 * HUB_GAPS G1). An application exposes scopes (manifest api.scopes) under
 * its audience urn:mt:app:<productId>; another declares the ones it
 * consumes. The platform's token endpoint then issues tokens addressed to
 * the target application:
 * - for machine calls: client credentials with resource=urn:mt:app:<target>
 *   and organization_id (lib/oidc/provider.ts);
 * - on behalf of a person: token exchange (lib/oidc/token-exchange.ts).
 *
 * A connection (caller -> target) exists for an organization when both
 * applications are active, the organization has both turned on and set up,
 * and the caller consumes scopes the target exposes. It's allowed unless the
 * organization's administrators blocked it (app_connection_states, which
 * also counts the tokens issued).
 */
import { controlDb } from './prisma.js';
import { entitlementProblem } from './oidc/accounts.js';

export const APP_AUDIENCE_PREFIX = 'urn:mt:app:';
/** RFC 8693's grant type (lib/oidc/token-exchange.ts) */
export const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const APP_TOKEN_TTL_SECONDS = 600;
export const ON_BEHALF_TOKEN_TTL_SECONDS = 300;
export const audienceOf = (productKey: string) => `${APP_AUDIENCE_PREFIX}${productKey}`;
export const isAppAudience = (resource: string) => resource.startsWith(APP_AUDIENCE_PREFIX) && resource.length > APP_AUDIENCE_PREFIX.length;

/** Why a token can't be issued: the token endpoint's error code and description */
export class ConnectionRefused extends Error {
  constructor(readonly error: 'invalid_target' | 'access_denied' | 'invalid_scope' | 'invalid_request', message: string) {
    super(message);
  }
}

export interface ConnectionScope { name: string; description: string; reason: string; allowsOnBehalfOf: boolean }

/** The scopes the caller consumes that the target exposes (and still declares) */
export async function connectionScopes(callerApplicationId: string, targetApplicationId: string): Promise<ConnectionScope[]> {
  const [consumed, exposed] = await Promise.all([
    controlDb.productConsumedScope.findMany({ where: { applicationId: callerApplicationId }, orderBy: { position: 'asc' } }),
    controlDb.productApiScope.findMany({ where: { applicationId: targetApplicationId, retiredAt: null } }),
  ]);
  const byName = new Map(exposed.map((s) => [s.name, s]));
  return consumed.filter((c) => byName.has(c.scope)).map((c) => {
    const s = byName.get(c.scope)!;
    return { name: s.name, description: s.description, reason: c.reason, allowsOnBehalfOf: s.allowsOnBehalfOf };
  });
}

/**
 * Check everything a token for caller -> target in this organization needs;
 * returns the target and the scopes allowed (onBehalfOf: only those that
 * allow it). Throws ConnectionRefused.
 */
export async function checkConnection(input: { callerApplicationId: string; targetResource: string; tenantId: string | undefined; onBehalfOf: boolean }) {
  const { callerApplicationId, targetResource, tenantId, onBehalfOf } = input;
  if (!isAppAudience(targetResource)) throw new ConnectionRefused('invalid_target', 'Not an application audience (urn:mt:app:<productId>)');
  const target = await controlDb.applicationRegistry.findUnique({
    where: { key: targetResource.slice(APP_AUDIENCE_PREFIX.length) },
    select: { id: true, key: true, name: true, status: true },
  });
  if (!target || target.status !== 'ACTIVE') throw new ConnectionRefused('invalid_target', 'No active application with that audience');
  if (target.id === callerApplicationId) throw new ConnectionRefused('invalid_target', 'An application calls itself without the platform');
  const caller = await controlDb.applicationRegistry.findUnique({ where: { id: callerApplicationId }, select: { id: true, key: true, name: true, status: true } });
  if (!caller || caller.status !== 'ACTIVE') throw new ConnectionRefused('access_denied', 'This application is not active');
  if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) throw new ConnectionRefused('invalid_request', 'Say which organization the call is for (organization_id)');

  const scopes = await connectionScopes(caller.id, target.id);
  const usable = onBehalfOf ? scopes.filter((s) => s.allowsOnBehalfOf) : scopes;
  if (!usable.length) {
    throw new ConnectionRefused('invalid_scope', onBehalfOf
      ? `None of the scopes ${caller.name} consumes from ${target.name} can be used on behalf of a person`
      : `${caller.name}'s manifest doesn't consume any scope ${target.name} exposes`);
  }
  // The organization: both on (and set up), and not blocked
  for (const app of [caller, target]) {
    const problem = await entitlementProblem(tenantId, app.id);
    if (problem) {
      throw new ConnectionRefused('access_denied', problem === 'NOT_READY'
        ? `${app.name} is still being set up for this organization`
        : `This organization doesn't have ${app.name} turned on`);
    }
  }
  const state = await controlDb.appConnectionState.findUnique({
    where: { tenantId_callerApplicationId_targetApplicationId: { tenantId, callerApplicationId: caller.id, targetApplicationId: target.id } },
    select: { blockedAt: true },
  });
  if (state?.blockedAt) throw new ConnectionRefused('access_denied', `This organization has blocked ${caller.name} from calling ${target.name}`);
  return { caller, target, scopes: usable };
}

/** Count a token issued for the connection (not each call) */
export async function countIssued(tenantId: string, callerApplicationId: string, targetApplicationId: string): Promise<void> {
  await controlDb.appConnectionState.upsert({
    where: { tenantId_callerApplicationId_targetApplicationId: { tenantId, callerApplicationId, targetApplicationId } },
    create: { tenantId, callerApplicationId, targetApplicationId, tokensIssued: 1, lastIssuedAt: new Date() },
    update: { tokensIssued: { increment: 1 }, lastIssuedAt: new Date() },
  }).catch(() => {});
}

export interface OrganizationConnection {
  caller: { id: string; key: string; name: string };
  target: { id: string; key: string; name: string };
  scopes: ConnectionScope[];
  blocked: boolean;
  blockedAt: string | null;
  blockedByEmail: string | null;
  tokensIssued: number;
  lastIssuedAt: string | null;
}

/** The connections between the applications an organization has on, for its administrators */
export async function organizationConnections(tenantId: string): Promise<OrganizationConnection[]> {
  const now = new Date();
  const on = await controlDb.tenantApplication.findMany({
    where: { tenantId, state: { in: ['ENABLED', 'TRIAL'] }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }], application: { status: 'ACTIVE' } },
    select: { application: { select: { id: true, key: true, name: true } } },
  });
  const apps = on.map((o) => o.application);
  const ids = apps.map((a) => a.id);
  if (ids.length < 2) return [];
  const [consumed, exposed, states] = await Promise.all([
    controlDb.productConsumedScope.findMany({ where: { applicationId: { in: ids } }, orderBy: { position: 'asc' } }),
    controlDb.productApiScope.findMany({ where: { applicationId: { in: ids }, retiredAt: null } }),
    controlDb.appConnectionState.findMany({ where: { tenantId } }),
  ]);
  const exposedBy = new Map(exposed.map((s) => [s.name, s]));
  const out: OrganizationConnection[] = [];
  for (const caller of apps) {
    for (const target of apps) {
      if (caller.id === target.id) continue;
      const scopes = consumed
        .filter((c) => c.applicationId === caller.id && exposedBy.get(c.scope)?.applicationId === target.id)
        .map((c) => {
          const s = exposedBy.get(c.scope)!;
          return { name: s.name, description: s.description, reason: c.reason, allowsOnBehalfOf: s.allowsOnBehalfOf };
        });
      if (!scopes.length) continue;
      const st = states.find((x) => x.callerApplicationId === caller.id && x.targetApplicationId === target.id);
      out.push({
        caller, target, scopes,
        blocked: !!st?.blockedAt,
        blockedAt: st?.blockedAt?.toISOString() ?? null,
        blockedByEmail: st?.blockedByEmail ?? null,
        tokensIssued: st?.tokensIssued ?? 0,
        lastIssuedAt: st?.lastIssuedAt?.toISOString() ?? null,
      });
    }
  }
  return out;
}

/** Block or allow a connection; returns whether anything changed */
export async function setConnectionBlocked(tenantId: string, callerApplicationId: string, targetApplicationId: string, blocked: boolean, by: string | null): Promise<boolean> {
  const key = { tenantId_callerApplicationId_targetApplicationId: { tenantId, callerApplicationId, targetApplicationId } };
  const before = await controlDb.appConnectionState.findUnique({ where: key, select: { blockedAt: true } });
  if (!!before?.blockedAt === blocked) return false;
  const data = blocked ? { blockedAt: new Date(), blockedByEmail: by } : { blockedAt: null, blockedByEmail: null };
  await controlDb.appConnectionState.upsert({ where: key, create: { tenantId, callerApplicationId, targetApplicationId, ...data }, update: data });
  return true;
}
