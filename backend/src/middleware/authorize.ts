import type { FastifyReply, FastifyRequest } from 'fastify';
import { getEnhancedUserPermissions } from '../utils/authorization.js';
import { permissionMatches } from '../utils/permissions.js';
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
    const { permissions } = await getEnhancedUserPermissions(userId, request.tenant?.id, userType);
    request.effectivePermissions = new Set(permissions);
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
