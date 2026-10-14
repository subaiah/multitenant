import { FastifyReply, FastifyRequest } from 'fastify';
import { isPlatformUser, USER_TYPE_HIERARCHY } from '../utils/authorization.js';

/**
 * onRequest hook for protected routes.
 *
 * 1. Verifies the JWT.
 * 2. Rejects tokens that aren't user access tokens (e.g. BFF service tokens).
 * 3. Binds the tenant: `tenantContext` resolves the tenant from the
 *    x-tenant-id header, which the client controls. Tenant users may only
 *    act on the tenant in their token. Platform users may act on any tenant.
 *
 * Must run after `tenantContext`.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { userId, userType, tenantId } = request.user;
  if (!userId || !userType || !(userType in USER_TYPE_HIERARCHY)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  if (!isPlatformUser(userType) && (!tenantId || request.tenant?.id !== tenantId)) {
    return reply.status(403).send({ error: 'Forbidden', message: 'Access to this tenant is not allowed' });
  }
}
