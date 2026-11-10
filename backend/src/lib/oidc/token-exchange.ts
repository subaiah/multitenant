/**
 * OAuth 2.0 Token Exchange (RFC 8693) for calls on behalf of a person
 * (docs/adr/0001-app-to-app-calls.md): an application's server swaps the
 * access token a person got signing in to it for a short token addressed to
 * another application, which then applies that person's access.
 *
 *   POST /oidc/token   (Basic: the caller's service credential)
 *   grant_type=urn:ietf:params:oauth:grant-type:token-exchange
 *   &subject_token=<the person's access token for the caller>
 *   &subject_token_type=urn:ietf:params:oauth:token-type:access_token
 *   &resource=urn:mt:app:<target>        (audience= is the same)
 *   &scope=<scopes, optional: all allowed>
 *
 * Checks: the subject token is the caller's own (issued to its sign-in
 * client) and still valid; the person may still use the caller (active,
 * organization open, caller on); the connection (lib/app-connections.ts),
 * with only scopes that allow on-behalf-of. The token (RS256, typ at+jwt,
 * 5 minutes, no refresh) carries sub, tenant_id, scope, act { sub, product_id }
 * (who acts) and the person's permissions for the target application.
 */
import { randomBytes } from 'node:crypto';
import { SignJWT, importJWK } from 'jose';
import { errors, type KoaContextWithOIDC } from 'oidc-provider';
import type Provider from 'oidc-provider';
import { controlDb } from '../prisma.js';
import { activeCredential, isServiceClientId } from '../product-service.js';
import { ON_BEHALF_TOKEN_TTL_SECONDS, TOKEN_EXCHANGE, checkConnection, countIssued } from '../app-connections.js';
import { checkAccount, claimsFor } from './accounts.js';
import { signingKeys } from './keys.js';

export { TOKEN_EXCHANGE };
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/** invalid_grant with a description (the provider's own InvalidGrant hides it) */
const invalidGrant = (description: string) => new errors.CustomOIDCProviderError('invalid_grant', description);

const one = (v: unknown): string | undefined => (Array.isArray(v) ? (v.length === 1 ? String(v[0]) : undefined) : typeof v === 'string' && v ? v : undefined);

export function registerTokenExchange(provider: Provider, refused: (err: unknown) => Error, issuer: () => string) {
  provider.registerGrantType(TOKEN_EXCHANGE, async (ctx: KoaContextWithOIDC) => {
    const client = ctx.oidc.client!;
    if (!isServiceClientId(client.clientId)) throw new errors.UnauthorizedClient('Token exchange is for applications’ service credentials');
    const p = ctx.oidc.params as Record<string, unknown>;
    if (p.subject_token_type !== ACCESS_TOKEN_TYPE) throw new errors.InvalidRequest(`subject_token_type must be ${ACCESS_TOKEN_TYPE}`);
    if (p.requested_token_type && p.requested_token_type !== ACCESS_TOKEN_TYPE) throw new errors.InvalidRequest(`Only ${ACCESS_TOKEN_TYPE} can be requested`);
    const resource = one(p.resource);
    const audience = one(p.audience);
    if (resource && audience && resource !== audience) throw new errors.InvalidRequest('resource and audience name different applications');
    const target = resource ?? audience;
    if (!target) throw new errors.InvalidRequest('Name the application: resource=urn:mt:app:<productId>');
    const cred = await activeCredential(client.clientId);
    if (!cred) throw new errors.InvalidClient();

    // The person's token: the caller's own, still valid
    const subjectToken = one(p.subject_token);
    const subject = subjectToken ? await provider.AccessToken.find(subjectToken) : undefined;
    if (!subject || !subject.accountId || (subject.exp ?? 0) * 1000 <= Date.now()) throw invalidGrant('subject_token is not a valid access token');
    const signIn = await controlDb.applicationSignIn.findUnique({ where: { clientId: subject.clientId! }, select: { applicationId: true } });
    if (signIn?.applicationId !== cred.application.id) throw invalidGrant('subject_token was not issued to this application');
    const person = await checkAccount(subject.accountId, subject.clientId!, (subject.iat ?? 0) * 1000);
    if ('problem' in person) throw invalidGrant(`The person can't use this application now (${person.problem})`);
    const tenantId = person.account.tenant.id;

    let connection;
    try {
      connection = await checkConnection({ callerApplicationId: cred.application.id, targetResource: target, tenantId, onBehalfOf: true });
    } catch (err) {
      throw refused(err);
    }
    const allowed = new Set(connection.scopes.map((s) => s.name));
    const asked = one(p.scope)?.split(' ').filter(Boolean) ?? [...allowed];
    const notAllowed = asked.filter((s) => !allowed.has(s));
    if (notAllowed.length) throw new errors.InvalidScope(`Not allowed on behalf of a person: ${notAllowed.join(' ')}`, notAllowed.join(' '));
    const scope = [...new Set(asked)].join(' ');

    // The person's access in the target application, as at signing in to it
    const claims = await claimsFor(subject.accountId, person.account, connection.target.id, new Set(['roles']));
    const permissions = (claims.permissions as string[] | undefined) ?? [];
    const scopedPermissions = claims.scoped_permissions ?? [];

    const [jwk] = await signingKeys();
    const key = await importJWK(jwk as never, 'RS256');
    const accessToken = await new SignJWT({
      client_id: client.clientId,
      product_id: connection.caller.key,
      tenant_id: tenantId,
      scope,
      permissions,
      scoped_permissions: scopedPermissions,
      act: { sub: client.clientId, product_id: connection.caller.key },
    })
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid, typ: 'at+jwt' })
      .setIssuer(issuer())
      .setAudience(target)
      .setSubject(subject.accountId)
      .setIssuedAt()
      .setExpirationTime(`${ON_BEHALF_TOKEN_TTL_SECONDS}s`)
      .setJti(randomBytes(16).toString('base64url'))
      .sign(key);
    await countIssued(tenantId, connection.caller.id, connection.target.id);

    ctx.body = { access_token: accessToken, issued_token_type: ACCESS_TOKEN_TYPE, token_type: 'Bearer', expires_in: ON_BEHALF_TOKEN_TTL_SECONDS, scope };
  }, ['subject_token', 'subject_token_type', 'requested_token_type', 'resource', 'audience', 'scope']);
}
