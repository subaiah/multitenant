import type { FastifyReply, FastifyRequest } from 'fastify';
import { getEnhancedUserPermissions, isPlatformUser, type ScopedGrant, type UserType } from '../utils/authorization.js';
import { config } from '../config/env.js';
import { countPermissionLookup } from '../lib/metrics.js';
import { PLATFORM_RESOURCES, permissionMatches } from '../utils/permissions.js';
import { sessionPermissions } from '../lib/support.js';
import { AppError } from './error-handler.js';

/**
 * Route-level authorization.
 *
 * Every protected route declares what it needs in its options:
 *
 *   fastify.get('/', { config: { permission: 'users:read' } }, handler)
 *   fastify.post('/', { config: { permission: ['users:create', 'users:invite'] } }, handler) // any of
 *   fastify.get('/me', { config: { permission: AUTHENTICATED } }, handler)
 *
 * `AUTHENTICATED` means "any signed-in user"; such handlers either only touch
 * the caller's own data or do their own ownership checks (and may call
 * `requirePermission` for the non-owner case).
 *
 * A route without a declaration is refused (fail closed), and
 * test/route-permissions.test.ts fails the build if one is missing.
 *
 * Effective permissions = user-type defaults + direct roles + group roles +
 * active delegations, in the current tenant (see getEnhancedUserPermissions),
 * so assigning or revoking a role takes effect on the next request.
 */
export const AUTHENTICATED = 'authenticated' as const;
export type RoutePermission = string | string[];

declare module 'fastify' {
  interface FastifyContextConfig {
    permission?: RoutePermission;
    /**
     * The handler checks the permission per organization or unit (lib/scopes.ts),
     * so the route check also lets through someone who holds it in some scope
     */
    scoped?: boolean;
    /** AUTHENTICATED routes only: API keys may use it too (the handler checks permissions for anything not the caller's own) */
    allowApiKeys?: boolean;
    /** Allowed in an organization whose trial has ended (read-only otherwise; lib/tenant-lifecycle.ts) */
    allowWhenTrialEnded?: boolean;
  }
  interface FastifyRequest {
    /** Cached for the lifetime of the request; use loadPermissions(). */
    effectivePermissions?: Set<string>;
    /** Permissions from scoped assignments (lib/scopes.ts); loaded with effectivePermissions */
    scopedGrants?: ScopedGrant[];
  }
}

// ---------------------------------------------------------------------------
// Permissions kept between requests
// ---------------------------------------------------------------------------
//
// Working out what someone may do reads their role assignments, their groups
// and the groups' assignments, and their delegations: several queries, on
// every request. For a tenant's users the answer is kept, per person, for as
// long as nothing about who may do what has changed in their tenant.
//
// "Nothing has changed" is the tenant's access version (access_versions), a
// number a database trigger moves on with every write to roles, their
// permissions, assignments, groups, memberships and delegations, whoever
// makes it and from whichever server. Each request reads it (one query) and
// uses what is kept only if it was worked out at that version. So a grant or
// a revocation applies on the very next request, as before.
//
// Two things the version doesn't see:
// - Access that starts or ends at a set time (validFrom, validTo). What is
//   kept is thrown away after PERMISSION_CACHE_TTL_MS, so it is seen within
//   that long.
// - An organization's administrators also hold the permissions of the
//   applications it has turned on, which change in the control plane. Theirs
//   are worked out every time, as are platform staff's.

interface KeptAccess {
  version: number;
  expires: number;
  permissions: string[];
  scoped: ScopedGrant[];
}
const keptAccess = new Map<string, KeptAccess>();
const KEPT_MAX = 5000;

/** Forget what is kept (tests) */
export function clearKeptAccess() {
  keptAccess.clear();
}

async function tenantUserAccess(request: FastifyRequest, userId: string, userType: string): Promise<{ permissions: string[]; scoped: ScopedGrant[] }> {
  const tenantId = request.tenant?.id;
  const ttl = config.permissionCacheTtlMs;
  if (!ttl || !tenantId || userType === 'TENANT_ADMIN' || isPlatformUser(userType as UserType)) {
    return getEnhancedUserPermissions(userId, tenantId, userType);
  }
  // Read before working anything out: a change that lands in between is then
  // kept under the older number, and worked out again next time
  const version = (await request.db.accessVersion.findUnique({ where: { tenantId }, select: { version: true } }))?.version ?? 0;
  const key = `${tenantId}:${userId}:${userType}`;
  const kept = keptAccess.get(key);
  if (kept && kept.version === version && kept.expires > Date.now()) {
    countPermissionLookup('hit');
    return kept;
  }
  countPermissionLookup('miss');
  const { permissions, scoped } = await getEnhancedUserPermissions(userId, tenantId, userType);
  keptAccess.delete(key);
  keptAccess.set(key, { version, expires: Date.now() + ttl, permissions, scoped });
  // The oldest entry goes when there are too many
  if (keptAccess.size > KEPT_MAX) keptAccess.delete(keptAccess.keys().next().value!);
  return { permissions, scoped };
}

export async function loadPermissions(request: FastifyRequest): Promise<Set<string>> {
  if (!request.effectivePermissions) {
    const { userId, userType } = request.user;
    if (request.apiKey) {
      // An API key: exactly its own permissions (fixed when it was made)
      request.effectivePermissions = new Set(request.apiKey.permissions);
      request.scopedGrants = [];
    } else if (request.supportSession) {
      // Platform staff in a tenant: the session's tenant permissions, plus their
      // platform-only ones (a platform admin's '*' must not cover tenant data)
      const { permissions } = await getEnhancedUserPermissions(userId, undefined, userType);
      const platformOnly = permissions.flatMap((p) => (p === '*' || p === '*:*' ? [...PLATFORM_RESOURCES].map((r) => `${r}:*`) : PLATFORM_RESOURCES.has(p.split(':')[0]) ? [p] : []));
      request.effectivePermissions = new Set([...platformOnly, ...sessionPermissions(request.supportSession)]);
      request.scopedGrants = [];
    } else {
      const { permissions, scoped } = await tenantUserAccess(request, userId, userType);
      request.effectivePermissions = new Set(permissions);
      request.scopedGrants = scoped;
    }
  }
  return request.effectivePermissions;
}

/** For handlers that allow owners and need a permission for everyone else. */
export async function hasPermission(request: FastifyRequest, ...anyOf: string[]): Promise<boolean> {
  const granted = await loadPermissions(request);
  return anyOf.some((p) => permissionMatches(granted, p));
}

export async function requirePermission(request: FastifyRequest, ...anyOf: string[]): Promise<void> {
  if (!(await hasPermission(request, ...anyOf))) {
    throw new AppError(`Missing permission: ${anyOf.join(' or ')}`, 403);
  }
}

/** preValidation hook for all protected routes (runs after `authenticate`, before body validation). */
export async function authorize(request: FastifyRequest, reply: FastifyReply) {
  const required = request.routeOptions.config.permission;

  if (required === undefined) {
    request.log.error({ route: request.routeOptions.url, method: request.method }, 'Route has no permission declaration');
    return reply.status(403).send({ error: 'Forbidden', message: 'This route has no access policy' });
  }
  // "Any signed-in person" routes are about that person's own account: not for keys
  if (required === AUTHENTICATED) {
    if (request.apiKey && !request.routeOptions.config.allowApiKeys) return reply.status(403).send({ error: 'Forbidden', code: 'NOT_FOR_API_KEYS', message: 'API keys cannot use this route: it is for people signed in to their own account' });
    return;
  }

  const anyOf = Array.isArray(required) ? required : [required];
  if (await hasPermission(request, ...anyOf)) return;
  // Scoped routes decide per item; let through someone with the permission somewhere
  if (request.routeOptions.config.scoped) {
    await loadPermissions(request);
    if ((request.scopedGrants ?? []).some((g) => anyOf.some((p) => permissionMatches([g.permission], p)))) return;
  }
  return reply.status(403).send({ error: 'Forbidden', message: `Missing permission: ${anyOf.join(' or ')}` });
}

/**
 * "You can't hand out what you don't have." Refuses (403) when the caller's
 * effective permissions don't cover every permission in `granted`. Used when
 * assigning roles and changing group membership, so e.g. a manager (groups:*)
 * can't add themselves to a group that holds the Tenant Admin role.
 */
export async function requireCanGrant(request: FastifyRequest, granted: Iterable<string>, what: string): Promise<void> {
  const mine = await loadPermissions(request);
  const missing = [...new Set(granted)].filter((p) => !permissionMatches(mine, p));
  if (missing.length > 0) {
    throw new AppError(`You can't ${what}: it grants permissions you don't have (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''})`, 403);
  }
}
