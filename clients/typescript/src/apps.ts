/**
 * Applications calling each other through the platform
 * (docs/adr/0001-app-to-app-calls.md; docs/PRODUCT_INTEGRATION.md).
 *
 * The caller:
 *   const tokens = createAppTokens({ tokenUrl, clientId, clientSecret });
 *   await tokens.forOrganization('hearth', organizationId, ['hearth.threads:write']);  // a machine call
 *   await tokens.onBehalfOf(personAccessToken, 'hearth', ['hearth.threads:read']);     // as the person
 *
 * The target (verifying what it's called with):
 *   const verify = createAppTokenVerifier({ issuer, productId: 'hearth' });
 *   const caller = await verify(request.headers.authorization);
 *   // caller.tenantId: scope every query by it; caller.person: apply their permissions
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export const APP_AUDIENCE_PREFIX = 'urn:mt:app:';
export const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
export const appAudience = (productId: string) => `${APP_AUDIENCE_PREFIX}${productId}`;

export interface AppTokenOptions {
  /** The platform's token endpoint, e.g. https://app.example.com/api/oidc/token */
  tokenUrl: string;
  /** The calling application's service credential */
  clientId: string;
  clientSecret: string;
}

/** A token endpoint refusal: error is the OAuth error code (access_denied, invalid_scope, …) */
export class AppTokenError extends Error {
  constructor(readonly error: string, message: string, readonly status: number) {
    super(message);
  }
}

export function createAppTokens({ tokenUrl, clientId, clientSecret }: AppTokenOptions) {
  const basic = `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`;
  const ask = async (params: Record<string, string>) => {
    const res = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic }, body: new URLSearchParams(params) });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new AppTokenError(body.error ?? 'server_error', body.error_description ?? body.error ?? `The token endpoint answered ${res.status}`, res.status);
    return { token: body.access_token, expiresIn: body.expires_in ?? 300, scope: body.scope ?? '' };
  };
  const cache = new Map<string, { token: string; renewAt: number }>();
  return {
    /** For a machine call to another application, for one organization (cached until shortly before it expires) */
    async forOrganization(targetProductId: string, organizationId: string, scopes: string[]): Promise<string> {
      const key = `${targetProductId} ${organizationId} ${[...scopes].sort().join(' ')}`;
      const hit = cache.get(key);
      if (hit && Date.now() < hit.renewAt) return hit.token;
      const t = await ask({ grant_type: 'client_credentials', resource: appAudience(targetProductId), organization_id: organizationId, scope: scopes.join(' ') });
      cache.set(key, { token: t.token, renewAt: Date.now() + (t.expiresIn - 60) * 1000 });
      return t.token;
    },
    /** For a call on behalf of the person whose access token (for this application) you have; not cached: exchange again each time */
    async onBehalfOf(subjectToken: string, targetProductId: string, scopes?: string[]): Promise<string> {
      const t = await ask({
        grant_type: TOKEN_EXCHANGE,
        subject_token: subjectToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        resource: appAudience(targetProductId),
        ...(scopes?.length && { scope: scopes.join(' ') }),
      });
      return t.token;
    },
  };
}

export interface AppCaller {
  /** The organization the call is for: scope every query by it */
  tenantId: string;
  /** The calling application's product id */
  productId: string;
  scopes: Set<string>;
  /** On behalf of a person: who, and their permissions in this application (apply these, never the caller's) */
  person: { subject: string; permissions: string[] } | null;
  claims: JWTPayload;
}

/** Thrown for a missing, invalid or expired token, or one for another application */
export class AppTokenInvalid extends Error {}

/**
 * For the target application: checks a token from the platform (signature
 * against its published keys, issuer, audience, expiry, typ at+jwt) and says
 * who's calling, for which organization, and for whom.
 */
export function createAppTokenVerifier({ issuer, productId, jwksUrl }: { issuer: string; productId: string; jwksUrl?: string }) {
  const keys = createRemoteJWKSet(new URL(jwksUrl ?? `${issuer.replace(/\/+$/, '')}/jwks`));
  const audience = appAudience(productId);
  return async (authorization: string | undefined | null): Promise<AppCaller> => {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1] ?? (authorization && !authorization.includes(' ') ? authorization : undefined);
    if (!token) throw new AppTokenInvalid('No bearer token');
    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256'], typ: 'at+jwt' }));
    } catch (err) {
      throw new AppTokenInvalid(`Not a valid token for ${productId}: ${(err as Error).message}`);
    }
    const tenantId = typeof claims.tenant_id === 'string' ? claims.tenant_id : '';
    if (!tenantId) throw new AppTokenInvalid('The token names no organization');
    const act = claims.act as { sub?: string } | undefined;
    return {
      tenantId,
      productId: String(claims.product_id ?? ''),
      scopes: new Set(String(claims.scope ?? '').split(' ').filter(Boolean)),
      person: act && claims.sub ? { subject: claims.sub, permissions: Array.isArray(claims.permissions) ? (claims.permissions as string[]) : [] } : null,
      claims,
    };
  };
}
