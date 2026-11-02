/**
 * External products calling API v1 themselves (docs/PRODUCT_INTEGRATION.md):
 * OAuth 2.0 client credentials, through the platform's OpenID Connect
 * provider (lib/oidc/provider.ts).
 *
 * - Each product has service credentials (product_service_credentials),
 *   separate from its sign-in client: a client ID (mts_…), a secret shown
 *   once and stored encrypted, and the scopes it may ask for. Several can be
 *   active at once, so one can be replaced without downtime.
 * - The product asks the token endpoint for an access token:
 *     POST /oidc/token  grant_type=client_credentials&scope=…
 *   and gets a short-lived JWT (audience API_RESOURCE, 10 minutes) with the
 *   scopes it asked for and is allowed.
 * - API v1's product routes check the token (signature, issuer, audience,
 *   expiry), then that its credential still exists and isn't revoked and the
 *   product is active, on every call: revoking takes effect at once.
 * - Which organizations a product may see is decided per request from the
 *   current entitlements, never from anything in the token.
 */
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { controlDb } from './prisma.js';
import { decryptSecret, secretContext } from './secrets.js';
import { signingKeys } from './oidc/keys.js';
import { issuer } from './oidc/provider.js';
import { SERVICE_SCOPES, isServiceScope, type ServiceScope } from './service-scopes.js';

export { SERVICE_SCOPES, isServiceScope, type ServiceScope };

/** The resource indicator and audience of API v1 access tokens */
export const API_RESOURCE = 'urn:multitenant:api:v1';
export const SERVICE_TOKEN_TTL_SECONDS = 600;
export const SERVICE_CLIENT_PREFIX = 'mts_';

export const isServiceClientId = (clientId: string) => clientId.startsWith(SERVICE_CLIENT_PREFIX);
export const newServiceClientId = () => `${SERVICE_CLIENT_PREFIX}${randomBytes(16).toString('base64url')}`;
export const newServiceSecret = () => randomBytes(32).toString('base64url');

/** A service credential that can get tokens: not revoked, its product active */
async function activeCredential(clientId: string) {
  const c = await controlDb.productServiceCredential.findUnique({
    where: { clientId },
    include: { application: { select: { id: true, key: true, name: true, status: true } } },
  });
  return c && !c.revokedAt && c.application.status === 'ACTIVE' ? c : null;
}

/** The provider's client metadata for a service credential (lib/oidc/adapter.ts) */
export async function serviceClientMetadata(clientId: string): Promise<Record<string, unknown> | undefined> {
  const c = await activeCredential(clientId);
  if (!c) return undefined;
  return {
    client_id: c.clientId,
    client_name: `${c.application.name} (service: ${c.name})`,
    client_secret: decryptSecret(c.serviceClientSecret, secretContext('serviceClientSecret')),
    token_endpoint_auth_method: 'client_secret_basic',
    grant_types: ['client_credentials'],
    response_types: [],
    redirect_uris: [],
  };
}

/** API v1 as a resource server for this client: its allowed scopes, JWT access tokens (lib/oidc/provider.ts) */
export async function serviceResourceServer(clientId: string) {
  const c = await activeCredential(clientId);
  if (!c) return null;
  return {
    scope: c.scopes.filter(isServiceScope).join(' '),
    audience: API_RESOURCE,
    accessTokenTTL: SERVICE_TOKEN_TTL_SECONDS,
    accessTokenFormat: 'jwt' as const,
    jwt: { sign: { alg: 'RS256' as const } },
  };
}

/** Claims added to a service access token */
export async function serviceTokenClaims(clientId: string): Promise<Record<string, unknown> | undefined> {
  const c = await activeCredential(clientId);
  return c ? { product_id: c.application.key } : undefined;
}

// ---------------------------------------------------------------------------
// Checking a service access token (API v1's product routes)
// ---------------------------------------------------------------------------

export interface ServiceCaller {
  applicationId: string;
  productKey: string;
  productName: string;
  credentialId: string;
  credentialName: string;
  scopes: Set<string>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** An external product calling with a service access token (lib/product-service.ts) */
    service?: ServiceCaller;
  }
  interface FastifyContextConfig {
    /** The scope a product route needs (lib/product-service.ts) */
    serviceScope?: ServiceScope | null;
  }
}

let keySet: ReturnType<typeof createLocalJWKSet> | null = null;
async function publicKeys() {
  if (!keySet) {
    const keys = (await signingKeys()).map(({ kty, n, e, kid, alg, use }) => ({ kty, n, e, kid, alg, use }));
    keySet = createLocalJWKSet({ keys: keys as never });
  }
  return keySet;
}

export class ServiceAuthError extends Error {
  constructor(readonly status: 401 | 403, readonly code: string, message: string) {
    super(message);
  }
}

/** Who's calling, from `Authorization: Bearer <access token>`; throws ServiceAuthError */
export async function serviceCallerOf(authorization: string | undefined): Promise<ServiceCaller> {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!m) throw new ServiceAuthError(401, 'INVALID_TOKEN', 'Send an access token from the token endpoint: Authorization: Bearer <token>');
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(m[1], await publicKeys(), { issuer: issuer(), audience: API_RESOURCE, algorithms: ['RS256'], typ: 'at+jwt' }));
  } catch (err) {
    const expired = (err as { code?: string }).code === 'ERR_JWT_EXPIRED';
    throw new ServiceAuthError(401, expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN', expired ? 'The access token has expired: get a new one' : 'Not a valid access token for this API');
  }
  const clientId = typeof payload.client_id === 'string' ? payload.client_id : '';
  const c = clientId ? await controlDb.productServiceCredential.findUnique({ where: { clientId }, include: { application: { select: { id: true, key: true, name: true, status: true } } } }) : null;
  if (!c) throw new ServiceAuthError(401, 'INVALID_TOKEN', 'Unknown service credential');
  if (c.revokedAt) throw new ServiceAuthError(401, 'CREDENTIAL_REVOKED', 'This service credential was revoked');
  if (c.application.status !== 'ACTIVE') throw new ServiceAuthError(403, 'APPLICATION_INACTIVE', 'This application is not active');
  // Last used, at most every few minutes
  if (!c.lastUsedAt || Date.now() - c.lastUsedAt.getTime() > 5 * 60_000) {
    void controlDb.productServiceCredential.update({ where: { id: c.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return {
    applicationId: c.application.id,
    productKey: c.application.key,
    productName: c.application.name,
    credentialId: c.id,
    credentialName: c.name,
    // Only what the credential still allows (it may have been narrowed since the token was issued)
    scopes: new Set(String(payload.scope ?? '').split(' ').filter((s) => s && c.scopes.includes(s))),
  };
}

/** onRequest hook for product routes: the caller, and the route's scope (config.serviceScope) */
export async function authenticateService(request: FastifyRequest, reply: FastifyReply) {
  try {
    request.service = await serviceCallerOf(request.headers.authorization);
  } catch (err) {
    if (err instanceof ServiceAuthError) {
      if (err.status === 401) reply.header('WWW-Authenticate', `Bearer error="invalid_token"`);
      return reply.status(err.status).send({ error: err.status === 401 ? 'Unauthorized' : 'Forbidden', code: err.code, message: err.message });
    }
    throw err;
  }
  const needed = request.routeOptions.config.serviceScope;
  if (needed === undefined) return reply.status(500).send({ error: 'Internal Server Error', message: 'This route declares no scope' });
  if (needed && !request.service.scopes.has(needed)) {
    reply.header('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${needed}"`);
    return reply.status(403).send({ error: 'Forbidden', code: 'INSUFFICIENT_SCOPE', message: `This needs the ${needed} scope (ask for it when getting the token, and have it on the credential)` });
  }
}
