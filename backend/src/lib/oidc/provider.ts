/**
 * "Sign in with": the platform as an OpenID Connect provider for the
 * applications in its catalogue (docs/SIGN_IN_WITH.md).
 *
 * - Issuer: `${BFF_URL}/oidc`, with discovery at /.well-known/openid-configuration.
 * - Clients: applications with sign-in turned on (application_sign_ins), read
 *   fresh on every request (lib/oidc/adapter.ts).
 * - Authorization code flow with PKCE (S256) for every client; refresh tokens
 *   when the application asks for offline_access.
 * - People sign in with their normal session on this site: the interaction
 *   route (routes/oidc.ts) sends them to the sign-in page if they aren't, then
 *   checks their organization has the application turned on
 *   (lib/oidc/accounts.ts). There's no consent screen: the organization turned
 *   the application on, and the applications are the platform's own.
 * - The provider's own session follows the site's: a check on every
 *   authorization asks again when the site session has ended or belongs to
 *   someone else, so signing out of the site also ends silent sign-in.
 */
import crypto from 'node:crypto';
import Provider, { errors, interactionPolicy, type Configuration, type KoaContextWithOIDC } from 'oidc-provider';
import { API_RESOURCE, activeCredential, isServiceClientId, serviceResourceServer, serviceTokenClaims } from '../product-service.js';
import { APP_TOKEN_TTL_SECONDS, ConnectionRefused, checkConnection, countIssued, isAppAudience } from '../app-connections.js';
import { registerTokenExchange } from './token-exchange.js';
import { config } from '../../config/env.js';
import { OidcAdapter } from './adapter.js';
import { signingKeys } from './keys.js';
import { accountIdFor, checkAccount, claimsFor } from './accounts.js';

/** Access tokens for applications last this long unless their sign-in settings say otherwise (seconds) */
export const DEFAULT_ACCESS_TOKEN_LIFETIME = 15 * 60;

type AppTokenContext = KoaContextWithOIDC & { appConnection?: { tenantId: string; callerApplicationId: string; targetApplicationId: string } };

/** The token endpoint's errors for a refused connection */
export function connectionError(err: unknown): Error {
  if (!(err instanceof ConnectionRefused)) return err as Error;
  if (err.error === 'invalid_target') return new errors.InvalidTarget(err.message);
  if (err.error === 'invalid_scope') return new errors.InvalidScope(err.message, '');
  if (err.error === 'invalid_request') return new errors.InvalidRequest(err.message);
  return new errors.AccessDenied(err.message);
}

/** Another application as a resource server for a machine call: the scopes its manifest lets the caller have, for one organization */
async function appResourceServer(ctx: KoaContextWithOIDC, resource: string, clientId: string) {
  const cred = await activeCredential(clientId);
  if (!cred) throw new errors.InvalidClient();
  // A token request's own parameter (extraParams covers authorization requests only)
  const tenantId = ((ctx.oidc.params?.organization_id ?? (ctx.oidc.body as Record<string, unknown> | undefined)?.organization_id) as string | undefined) || undefined;
  try {
    const { caller, target, scopes } = await checkConnection({ callerApplicationId: cred.application.id, targetResource: resource, tenantId, onBehalfOf: false });
    (ctx as AppTokenContext).appConnection = { tenantId: tenantId!, callerApplicationId: caller.id, targetApplicationId: target.id };
    return {
      scope: scopes.map((s) => s.name).join(' '),
      audience: resource,
      accessTokenTTL: APP_TOKEN_TTL_SECONDS,
      accessTokenFormat: 'jwt' as const,
      jwt: { sign: { alg: 'RS256' as const } },
    };
  } catch (err) {
    throw connectionError(err);
  }
}

export const SCOPES = ['openid', 'offline_access', 'email', 'profile', 'organization', 'roles'] as const;
export const CLAIMS: Record<string, string[]> = {
  openid: ['sub'],
  email: ['email'],
  profile: ['name', 'updated_at'],
  organization: ['tenant_id', 'tenant_slug', 'tenant_name'],
  roles: ['roles', 'permissions', 'scoped_permissions'],
};

const trimmed = (url: string) => url.replace(/\/+$/, '');
export const issuer = () => `${trimmed(config.bffUrl)}/oidc`;
/** Where the provider is in the browser's address space (BFF_URL's path + /oidc) */
export const publicMountPath = () => new URL(issuer()).pathname;
export const interactionPath = (uid: string) => `${publicMountPath()}/interaction/${uid}`;

/** A signed-in person on this site, from their session cookie */
export interface SiteSession {
  tenantId: string | null;
  userId: string;
}
/** Reads and checks the site's session from a request's cookies (routes/oidc.ts supplies it) */
export type SessionReader = (accessToken: string | undefined) => Promise<SiteSession | null>;

// The site's own cookies aren't signed the way the provider signs its own
const siteCookie = (ctx: KoaContextWithOIDC, name: string) => ctx.cookies.get(name, { signed: false });
export type SessionEnder = (refreshToken: string | undefined) => Promise<void>;

const html = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string, script = ''): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;max-width:420px;width:100%;box-sizing:border-box}
h1{font-size:1.2rem;margin:0 0 12px}p{color:#475569;line-height:1.5;margin:0 0 16px}
button,a.button{display:inline-block;font:inherit;padding:9px 16px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;text-decoration:none;cursor:pointer;margin-right:8px}
button.primary{background:#2563eb;border-color:#2563eb;color:#fff}
@media (prefers-color-scheme:dark){body{background:#0f172a;color:#f1f5f9}main{background:#1e293b;border-color:#334155}p{color:#cbd5e1}button,a.button{background:#1e293b;color:#f1f5f9;border-color:#475569}}</style>
</head><body><main>${body}</main>${script}</body></html>`;
}

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "You can't sign in to this application.",
  invalid_client: "This application isn't set up to sign in here.",
  invalid_redirect_uri: "This application asked to return to an address it isn't registered for.",
  login_required: 'You need to sign in first.',
};

export async function createProvider({ readSession, endSession }: { readSession: SessionReader; endSession: SessionEnder }): Promise<Provider> {
  const iss = new URL(issuer());
  // Cookie keys from COOKIE_SECRET, so every server signs the provider's cookies alike
  const cookieKey = crypto.createHmac('sha256', config.cookieSecret).update('oidc-provider cookies').digest('base64url');
  const secure = iss.protocol === 'https:';

  // The provider's session must belong to whoever is signed in to the site
  // now, and their organization must have the application turned on
  const siteSession = new interactionPolicy.Check(
    'site_session',
    'The site session ended, changed or no longer allows this application',
    'login_required',
    async (ctx: KoaContextWithOIDC) => {
      const s = await readSession(siteCookie(ctx, 'access_token'));
      if (!s?.tenantId) return interactionPolicy.Check.REQUEST_PROMPT;
      if (ctx.oidc.session?.accountId !== accountIdFor(s.tenantId, s.userId)) return interactionPolicy.Check.REQUEST_PROMPT;
      const result = await checkAccount(ctx.oidc.session.accountId, ctx.oidc.client!.clientId);
      return 'problem' in result ? interactionPolicy.Check.REQUEST_PROMPT : interactionPolicy.Check.NO_NEED_TO_PROMPT;
    },
  );
  const policy = interactionPolicy.base();
  policy.get('login')!.checks.add(siteSession);

  const configuration: Configuration = {
    adapter: OidcAdapter as unknown as Configuration['adapter'],
    clients: [],
    jwks: { keys: (await signingKeys()) as never },
    scopes: [...SCOPES],
    claims: CLAIMS,
    responseTypes: ['code'],
    pkce: { required: () => true },
    cookies: {
      keys: [cookieKey],
      long: { signed: true, secure, sameSite: 'lax', httpOnly: true },
      short: { signed: true, secure, sameSite: 'lax', httpOnly: true },
    },
    // Each application's own access token lifetime (application_sign_ins.access_token_lifetime, 15 minutes unless set)
    extraClientMetadata: {
      properties: ['access_token_lifetime'],
      validator: (_ctx, key, value) => {
        if (key === 'access_token_lifetime' && value !== undefined && !(Number.isInteger(value) && (value as number) >= 60 && (value as number) <= 86_400)) {
          throw new errors.InvalidClientMetadata('access_token_lifetime must be 60 to 86400 seconds');
        }
      },
    },
    ttl: {
      AccessToken: (_ctx, _token, client) => ((client as unknown as { access_token_lifetime?: number } | undefined)?.access_token_lifetime ?? DEFAULT_ACCESS_TOKEN_LIFETIME),
      AuthorizationCode: 60,
      IdToken: 60 * 60,
      Interaction: 10 * 60,
      RefreshToken: 30 * 24 * 60 * 60,
      Grant: 30 * 24 * 60 * 60,
      Session: 14 * 24 * 60 * 60,
    },
    // Refresh tokens only when asked for (offline_access); each use returns a new one
    // Which product a service token belongs to
    extraTokenClaims: async (ctx, token) => {
      const clientId = (token as { clientId?: string }).clientId;
      if (!clientId || !isServiceClientId(clientId)) return undefined;
      const claims = await serviceTokenClaims(clientId);
      // A token for another application: which organization it's for; counted for the connection
      const connection = (ctx as AppTokenContext).appConnection;
      if (connection) {
        await countIssued(connection.tenantId, connection.callerApplicationId, connection.targetApplicationId);
        return { ...claims, tenant_id: connection.tenantId };
      }
      return claims;
    },
    // organization_id: which organization a token for another application is for
    extraParams: ['organization_id'],
    issueRefreshToken: async (_ctx, client, code) => client.grantTypeAllowed('refresh_token') && code.scopes.has('offline_access'),
    rotateRefreshToken: true,
    features: {
      devInteractions: { enabled: false },
      // External products calling API v1 themselves (lib/product-service.ts)
      clientCredentials: { enabled: true },
      resourceIndicators: {
        enabled: true,
        // A service credential's tokens are for API v1, asked for or not
        defaultResource: async (_ctx, client, oneOf) => (client && isServiceClientId(client.clientId) ? API_RESOURCE : oneOf) as never,
        getResourceServerInfo: async (ctx, resource, client) => {
          if (!isServiceClientId(client.clientId)) throw new errors.InvalidTarget();
          // Another application, for a machine call (docs/adr/0001-app-to-app-calls.md)
          if (isAppAudience(resource)) return appResourceServer(ctx, resource, client.clientId);
          const info = resource === API_RESOURCE ? await serviceResourceServer(client.clientId) : null;
          if (!info) throw new errors.InvalidTarget();
          return info;
        },
        useGrantedResource: async () => false,
      },
      revocation: { enabled: true },
      // Advertised in discovery; the logout tokens are sent from an outbox (lib/oidc/logout.ts), not by the provider
      backchannelLogout: { enabled: true },
      userinfo: { enabled: true },
      rpInitiatedLogout: {
        enabled: true,
        // With an ID token naming the person, the application is trusted to
        // ask: sign out straight away. Otherwise ask first, so another site
        // can't sign people out.
        logoutSource: async (ctx, form) => {
          const auto = ctx.oidc.params?.id_token_hint !== undefined;
          // site_logout marks a sign-out the person asked for (the provider
          // also signs out by itself when switching accounts: not that one)
          const withYes = form.replace('</form>', '<input type="hidden" name="logout" value="yes"/><input type="hidden" name="site_logout" value="1"/></form>');
          ctx.type = 'html';
          ctx.body = auto
            ? page('Signing out', `<h1>Signing out…</h1>${withYes}`, '<script>document.getElementById("op.logoutForm").submit()</script>')
            : page('Sign out', `<h1>Sign out?</h1><p>This signs you out of the applications you signed in to with your organization account, and of this site.</p>${withYes}
<button class="primary" type="submit" form="op.logoutForm">Sign out</button><a class="button" href="${html(config.frontendUrl)}">Cancel</a>`);
        },
        postLogoutSuccessSource: async (ctx) => {
          ctx.type = 'html';
          ctx.body = page('Signed out', `<h1>You're signed out</h1><p><a class="button" href="${html(config.frontendUrl)}">Sign in again</a></p>`);
        },
      },
    },
    interactions: {
      url: async (_ctx, interaction) => interactionPath(interaction.uid),
      policy,
    },
    // Applications in the browser may call the token endpoint from the origins they return to
    clientBasedCORS: (_ctx, origin, client) =>
      [...(client.redirectUris ?? []), ...(client.postLogoutRedirectUris ?? [])].some((u) => {
        try {
          return new URL(u).origin === origin;
        } catch {
          return false;
        }
      }),
    findAccount: async (ctx, sub, token) => {
      const clientId = ctx.oidc.client?.clientId ?? (token as { clientId?: string } | undefined)?.clientId;
      if (!clientId) return undefined;
      // A token from before "sign out everywhere" no longer works
      const iat = (token as { iat?: number } | undefined)?.iat;
      const result = await checkAccount(sub, clientId, iat !== undefined ? iat * 1000 : undefined);
      if ('problem' in result) return undefined;
      return {
        accountId: sub,
        claims: async (_use, scope) => claimsFor(sub, result.account, result.applicationId, new Set(scope.split(' '))),
      };
    },
    renderError: async (ctx, out) => {
      const message = ERROR_MESSAGES[out.error] ?? 'Signing in to this application failed.';
      ctx.type = 'html';
      ctx.body = page('Sign-in problem', `<h1>${html(message)}</h1>${out.error_description ? `<p>${html(out.error_description)}</p>` : ''}
<p><a class="button" href="${html(config.frontendUrl)}">Go to your dashboard</a></p>`);
    },
  };

  const provider = new Provider(iss.href.replace(/\/$/, ''), configuration);
  // Calls on behalf of a person to another application (RFC 8693)
  registerTokenExchange(provider, connectionError, issuer);
  // Headers are pinned to the issuer by the mount (routes/oidc.ts), so this is safe
  provider.proxy = true;

  // Signing out from an application signs out of the site too: its cookies
  // go with this response, its refresh token is revoked before it's sent
  provider.on('end_session.success', (ctx: KoaContextWithOIDC) => {
    if ((ctx.oidc.body as Record<string, unknown> | undefined)?.site_logout !== '1') return;
    const refresh = siteCookie(ctx, 'refresh_token');
    for (const name of ['access_token', 'refresh_token']) ctx.cookies.set(name, null, { path: '/', secure, sameSite: 'lax', httpOnly: true, overwrite: true, signed: false });
    ctx.state.siteSignOut = endSession(refresh).catch(() => {});
  });
  provider.use(async (ctx, next) => {
    await next();
    if (ctx.state.siteSignOut) await ctx.state.siteSignOut;
  });
  return provider;
}
