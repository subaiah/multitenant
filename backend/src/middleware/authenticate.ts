import { FastifyReply, FastifyRequest } from 'fastify';
import { controlDb } from '../lib/prisma.js';
import { dbForTenant, type TenantDb } from '../lib/tenant-db.js';
import { AppError } from './error-handler.js';
import { classifyDatabaseError } from '../lib/db-errors.js';
import { config } from '../config/env.js';
import { isPlatformUser, USER_TYPE_HIERARCHY } from '../utils/authorization.js';
import { verifySession } from '../lib/sessions.js';
import { activeSupportSession, type ActiveSupportSession } from '../lib/support.js';

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
     * Connected as the tenant's own database role, so row-level security
     * keeps it to the tenant's rows. Platform-scoped requests without a
     * tenant have no tenant client; using it throws.
     */
    db: TenantDb;
    /** A platform user's support session for request.tenant (lib/support.ts) */
    supportSession?: ActiveSupportSession;
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
 *    - platform users: the tenant named by `x-tenant-id`, if any, and only
 *      with an active support session for it (lib/support.ts).
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    // Also checks the account is still active and the session not ended,
    // and refreshes userType from the database
    await verifySession(request);
  } catch (err) {
    // The tenant's database being briefly unreachable is not a reason to sign
    // anyone out: let the error handler answer 503
    if (classifyDatabaseError(err) || (err instanceof AppError && err.statusCode >= 500)) throw err;
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
      select: {
        id: true, name: true, slug: true, plan: true, status: true, provisioningStatus: true,
        databaseConfig: { select: { updatedAt: true } },
      },
    });
    if (!tenant) {
      return reply.status(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }
    // Platform users can still manage suspended tenants
    if (tenant.status === 'SUSPENDED' && !platformUser) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Tenant is suspended' });
    }
    // Nobody works inside a tenant until its data is set up
    if (tenant.provisioningStatus !== 'READY') {
      return reply.status(409).send({ error: 'Conflict', message: 'This tenant is not ready yet' });
    }
    const { provisioningStatus: _, databaseConfig, ...tenantInfo } = tenant;
    // Platform staff work inside a tenant only through an approved, active
    // support session; a read-only one gets a connection that can't write
    let readOnly = false;
    if (platformUser) {
      const session = await activeSupportSession(userId, tenant.id);
      if (!session) {
        return reply.status(403).send({
          error: 'Forbidden',
          code: 'SUPPORT_SESSION_REQUIRED',
          message: `Working in ${tenant.name} needs an approved support session`,
        });
      }
      request.supportSession = session;
      readOnly = session.access === 'READ_ONLY';
    }
    request.tenant = tenantInfo;
    // The config's version, so a change made on another server (rotated credentials) applies at once
    request.db = await dbForTenant(tenant.id, databaseConfig?.updatedAt, { readOnly });
    return;
  }

  request.db = NO_TENANT;
  if (!request.routeOptions.config.platformScoped) {
    return reply.status(400).send({
      error: 'Bad Request',
      message: `Select a tenant with the ${config.tenantHeader} header`,
    });
  }
}

/** request.db when no tenant is selected: any use is a bug in a platform-scoped route. */
const NO_TENANT = new Proxy({} as TenantDb, {
  get() {
    throw new AppError(`Select a tenant with the ${config.tenantHeader} header`, 400);
  },
});
