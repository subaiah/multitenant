import type { FastifyReply, FastifyRequest } from 'fastify';
import { getEnhancedUserPermissions } from '../utils/authorization.js';
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
  }
  interface FastifyRequest {
    /** Cached for the lifetime of the request; use loadPermissions(). */
    effectivePermissions?: Set<string>;
  }
}

export async function loadPermissions(request: FastifyRequest): Promise<Set<string>> {
  if (!request.effectivePermissions) {
    const { userId, userType } = request.user;
    if (request.supportSession) {
      // Platform staff in a tenant: the session's tenant permissions, plus their
      // platform-only ones (a platform admin's '*' must not cover tenant data)
      const { permissions } = await getEnhancedUserPermissions(userId, undefined, userType);
      const platformOnly = permissions.flatMap((p) => (p === '*' || p === '*:*' ? [...PLATFORM_RESOURCES].map((r) => `${r}:*`) : PLATFORM_RESOURCES.has(p.split(':')[0]) ? [p] : []));
      request.effectivePermissions = new Set([...platformOnly, ...sessionPermissions(request.supportSession)]);
    } else {
      const { permissions } = await getEnhancedUserPermissions(userId, request.tenant?.id, userType);
      request.effectivePermissions = new Set(permissions);
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
  if (required === AUTHENTICATED) return;

  const anyOf = Array.isArray(required) ? required : [required];
  if (!(await hasPermission(request, ...anyOf))) {
    return reply.status(403).send({ error: 'Forbidden', message: `Missing permission: ${anyOf.join(' or ')}` });
  }
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
