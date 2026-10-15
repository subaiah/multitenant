import { FastifyReply, FastifyRequest } from 'fastify';
import { controlDb } from '../lib/prisma.js';
import { dbForTenant, type TenantDb } from '../lib/tenant-db.js';
import { tenantDb } from '../lib/prisma.js';
import { config } from '../config/env.js';
import { isPlatformUser, USER_TYPE_HIERARCHY } from '../utils/authorization.js';
import { verifySession } from '../lib/sessions.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Route works without a tenant (platform-level operations).
     * Platform users may call it without selecting a tenant; `request.tenant`
     * is then undefined, so handlers must use `request.tenant?.id`.
     */
    platformScoped?: boolean;
  }
  interface FastifyRequest {
    /**
     * The tenant plane client for this request's tenant. Use it for every
     * tenant-owned model; use controlDb only for control-plane models.
     * Platform-scoped requests without a tenant get the shared tenant
     * database (for cross-tenant platform views).
     */
    db: TenantDb;
  }
}

/**
 * onRequest hook for protected routes.
 *
 * 1. Verifies the JWT from the Authorization header or the `access_token`
 *    cookie set by /bff/auth/login, and that the account is still active and
 *    hasn't been signed out everywhere since (see lib/sessions.ts). The user
 *    type comes from the database, not the token.
 * 2. Rejects tokens that aren't user access tokens (e.g. BFF service tokens).
 * 3. Resolves the tenant:
 *    - tenant users: always the tenant in their token. An `x-tenant-id`
 *      header is optional; if sent, it must match.
 *    - platform users: the tenant named by `x-tenant-id`, if any.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    // Also checks the account is still active and the session not ended,
    // and refreshes userType from the database
    await verifySession(request);
  } catch (err) {
    return reply.status(401).send({ error: 'Unauthorized', message: err instanceof Error ? err.message : undefined });
  }

  const { userId, userType, tenantId: tokenTenantId } = request.user;
  if (!userId || !userType || !(userType in USER_TYPE_HIERARCHY)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const headerTenantId = request.headers[config.tenantHeader];
  const requestedTenantId = typeof headerTenantId === 'string' && headerTenantId ? headerTenantId : undefined;
  const platformUser = isPlatformUser(userType);

  let tenantId: string | undefined;
  if (platformUser) {
    tenantId = requestedTenantId;
  } else {
    if (!tokenTenantId || (requestedTenantId && requestedTenantId !== tokenTenantId)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Access to this tenant is not allowed' });
    }
    tenantId = tokenTenantId;
  }

  if (tenantId) {
    const tenant = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, plan: true, status: true },
    });
    if (!tenant) {
      return reply.status(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }
    // Platform users can still manage suspended tenants
    if (tenant.status === 'SUSPENDED' && !platformUser) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Tenant is suspended' });
    }
    request.tenant = tenant;
    request.db = dbForTenant(tenant.id);
    return;
  }

  request.db = tenantDb;
  if (!request.routeOptions.config.platformScoped) {
    return reply.status(400).send({
      error: 'Bad Request',
      message: `Select a tenant with the ${config.tenantHeader} header`,
    });
  }
}
