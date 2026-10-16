/**
 * Single sign-on with a tenant's identity providers (AuthProvider rows).
 *
 * OpenID Connect (Entra, Google, Okta, Auth0, any OIDC provider): the
 * provider's discovery document, authorization code flow with PKCE, a nonce,
 * and a signed ID token checked by openid-client. GitHub isn't OIDC: plain
 * OAuth 2 with PKCE, then the user and their verified emails from its API.
 *
 * Who signed in is matched to a user of the tenant by the provider's stable
 * subject id (ExternalIdentity), so a changed or reused email at the provider
 * can't take over an account. The first time, it matches a user by a
 * verified email and links them; with auto-provisioning on, a new user is
 * created instead when there is none.
 *
 * Every attempt is kept in OAuthSession (single use, 10 minutes): the state
 * starts with the tenant's slug, so the callback knows which tenant database
 * to look in.
 */
import * as oidc from 'openid-client';
import { config } from '../config/env.js';
import { AppError } from '../middleware/error-handler.js';
import { decryptSecret, secretContext } from './secrets.js';
import { slugToken, tenantForSignIn, tokenSlug } from './auth-planes.js';
import type { TenantDb } from './tenant-db.js';

export const SSO_CALLBACK_PATH = '/bff/auth/sso/callback';
export const ssoRedirectUri = () => `${config.bffUrl.replace(/\/$/, '')}${SSO_CALLBACK_PATH}`;

const ATTEMPT_MINUTES = 10;

type Provider = NonNullable<Awaited<ReturnType<TenantDb['authProvider']['findFirst']>>>;

/** An error the sign-in page shows; `code` lets it pick its own wording. */
export class SsoError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

const withScheme = (domain: string) => (/^https?:\/\//.test(domain) ? domain : `https://${domain}`);

/** The OpenID issuer for a provider, or null for GitHub (not OpenID). */
export function issuerOf(p: Pick<Provider, 'provider' | 'domain' | 'idpTenantId'>): string | null {
  switch (p.provider) {
    case 'ENTRA':
      if (!p.idpTenantId) throw new SsoError('Microsoft sign-in needs the directory (tenant) id', 'SSO_MISCONFIGURED');
      return `https://login.microsoftonline.com/${encodeURIComponent(p.idpTenantId)}/v2.0`;
    case 'GOOGLE':
      return p.domain ? withScheme(p.domain) : 'https://accounts.google.com';
    case 'OKTA':
    case 'AUTH0':
    case 'CUSTOM_OIDC':
      if (!p.domain) throw new SsoError('This sign-in option needs its domain or issuer URL', 'SSO_MISCONFIGURED');
      return withScheme(p.domain);
    case 'GITHUB':
      return null;
  }
}

const insecureOk = () => config.nodeEnv !== 'production';

// Discovery documents, kept for an hour per provider configuration
const discovered = new Map<string, { at: number; conf: oidc.Configuration }>();

async function configurationFor(p: Provider): Promise<oidc.Configuration> {
  if (!p.clientId) throw new SsoError('This sign-in option has no client id', 'SSO_MISCONFIGURED');
  const secret = p.clientSecret ? decryptSecret(p.clientSecret, secretContext('clientSecret')) : undefined;
  const key = `${p.id}:${p.updatedAt.getTime()}`;
  const hit = discovered.get(key);
  if (hit && hit.at > Date.now() - 3_600_000) return hit.conf;

  const issuer = issuerOf(p);
  const auth = secret ? oidc.ClientSecretPost(secret) : oidc.None();
  let conf: oidc.Configuration;
  if (issuer) {
    conf = await oidc.discovery(new URL(issuer), p.clientId, secret, auth, insecureOk() ? { execute: [oidc.allowInsecureRequests] } : undefined)
      .catch((err) => {
        throw new SsoError(`Could not reach the identity provider (${(err as Error).message})`, 'SSO_UNAVAILABLE');
      });
  } else {
    conf = new oidc.Configuration(
      {
        issuer: 'https://github.com',
        authorization_endpoint: p.authorizeUrl || 'https://github.com/login/oauth/authorize',
        token_endpoint: p.tokenUrl || 'https://github.com/login/oauth/access_token',
      },
      p.clientId,
      secret,
      auth,
    );
    if (insecureOk()) oidc.allowInsecureRequests(conf);
  }
  discovered.set(key, { at: Date.now(), conf });
  return conf;
}

function scopesFor(p: Provider): string {
  if (p.provider === 'GITHUB') return (p.scopes.length ? p.scopes : ['read:user', 'user:email']).join(' ');
  const scopes = new Set(['openid', 'email', 'profile', ...p.scopes]);
  return [...scopes].join(' ');
}

/** Where to send the browser to sign in with a provider. */
export async function startSso(tenantSlug: string, providerId: string): Promise<URL> {
  const { tenant, db } = await tenantForSignIn(tenantSlug);
  const provider = await db.authProvider.findFirst({ where: { id: providerId, tenantId: tenant.id, enabled: true } });
  if (!provider) throw new AppError('This sign-in option is not available', 404);

  const conf = await configurationFor(provider);
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const nonce = provider.provider === 'GITHUB' ? null : oidc.randomNonce();
  const state = slugToken(tenant.slug, 32);

  // Old attempts are no use to anyone
  await db.oAuthSession.deleteMany({ where: { tenantId: tenant.id, expiresAt: { lt: new Date() } } });
  await db.oAuthSession.create({
    data: {
      tenantId: tenant.id,
      state,
      providerId: provider.id,
      redirectUri: ssoRedirectUri(),
      codeVerifier,
      nonce,
      expiresAt: new Date(Date.now() + ATTEMPT_MINUTES * 60_000),
    },
  });

  const params: Record<string, string> = {
    redirect_uri: ssoRedirectUri(),
    scope: scopesFor(provider),
    state,
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
  };
  if (nonce) params.nonce = nonce;
  if (provider.provider === 'GOOGLE' || provider.provider === 'ENTRA') params.prompt = 'select_account';
  return oidc.buildAuthorizationUrl(conf, params);
}

export interface SsoIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

async function githubIdentity(p: Provider, accessToken: string): Promise<SsoIdentity> {
  const api = (p.userInfoUrl || 'https://api.github.com/user').replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'multitenant-sso' };
  const [userRes, emailsRes] = await Promise.all([fetch(api, { headers }), fetch(`${api}/emails`, { headers })]);
  if (!userRes.ok) throw new SsoError('GitHub did not return your profile', 'SSO_FAILED');
  const user = (await userRes.json()) as { id: number; name?: string | null; login: string };
  const emails = emailsRes.ok ? ((await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>) : [];
  const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
  return { subject: String(user.id), email: primary?.email ?? null, emailVerified: Boolean(primary), name: user.name || user.login };
}

/**
 * The callback: check the attempt and the provider's answer, and return the
 * tenant, the provider and who signed in. Throws SsoError for the sign-in page.
 */
export async function finishSso(callbackUrl: URL) {
  const providerError = callbackUrl.searchParams.get('error');
  const state = callbackUrl.searchParams.get('state') ?? '';
  const slug = tokenSlug(state);
  if (!slug) throw new SsoError('This sign-in link is not valid. Please start again.', 'SSO_EXPIRED');

  const { tenant, db } = await tenantForSignIn(slug);
  const attempt = await db.oAuthSession.findUnique({ where: { state } });
  // Single use: whoever deletes it first carries on
  const claimed = attempt ? await db.oAuthSession.deleteMany({ where: { id: attempt.id } }) : { count: 0 };
  if (!attempt || claimed.count !== 1 || attempt.tenantId !== tenant.id || attempt.expiresAt < new Date()) {
    throw Object.assign(new SsoError('This sign-in has expired. Please start again.', 'SSO_EXPIRED'), { tenantSlug: slug });
  }
  const fail = (message: string, code: string) => Object.assign(new SsoError(message, code), { tenantSlug: slug });

  if (providerError) {
    const description = callbackUrl.searchParams.get('error_description');
    throw fail(providerError === 'access_denied' ? 'Sign-in was cancelled' : `The identity provider refused the sign-in${description ? `: ${description}` : ''}`, 'SSO_DENIED');
  }

  const provider = await db.authProvider.findFirst({ where: { id: attempt.providerId, tenantId: tenant.id, enabled: true } });
  if (!provider) throw fail('This sign-in option is no longer available', 'SSO_MISCONFIGURED');

  let identity: SsoIdentity;
  try {
    const conf = await configurationFor(provider);
    const tokens = await oidc.authorizationCodeGrant(conf, callbackUrl, {
      pkceCodeVerifier: attempt.codeVerifier,
      expectedState: state,
      ...(attempt.nonce ? { expectedNonce: attempt.nonce, idTokenExpected: true } : {}),
    });
    if (provider.provider === 'GITHUB') {
      identity = await githubIdentity(provider, tokens.access_token);
    } else {
      const claims = tokens.claims();
      if (!claims) throw new SsoError('The identity provider did not return an ID token', 'SSO_FAILED');
      if (provider.provider === 'ENTRA' && claims.tid !== provider.idpTenantId) {
        throw new SsoError('That account is not in this organization’s Microsoft directory', 'SSO_DENIED');
      }
      const email = (claims.email as string | undefined) ?? (provider.provider === 'ENTRA' ? (claims.preferred_username as string | undefined) : undefined) ?? null;
      identity = {
        subject: claims.sub,
        email: email?.toLowerCase() ?? null,
        // Entra doesn't send email_verified; its addresses are managed by the
        // directory, which the tid check above pins to this organization's
        emailVerified: claims.email_verified === true || (provider.provider === 'ENTRA' && Boolean(email)),
        name: (claims.name as string | undefined) ?? null,
      };
    }
  } catch (err) {
    if (err instanceof SsoError) throw Object.assign(err, { tenantSlug: slug });
    throw fail(`Sign-in with the identity provider failed (${(err as Error).message})`, 'SSO_FAILED');
  }
  if (identity.email) identity.email = identity.email.toLowerCase();

  return { tenant, db, provider, identity, slug };
}

/**
 * The tenant user for an identity: linked before, or matched by verified
 * email (then linked), or created when the provider auto-provisions.
 */
export async function userForIdentity(
  db: TenantDb,
  tenantId: string,
  provider: Provider,
  identity: SsoIdentity,
) {
  const linked = await db.externalIdentity.findUnique({
    where: { tenantId_providerId_subject: { tenantId, providerId: provider.id, subject: identity.subject } },
    include: { user: true },
  });
  if (linked) {
    await db.externalIdentity.update({ where: { id: linked.id }, data: { lastUsedAt: new Date(), email: identity.email } });
    return { user: linked.user, how: 'linked' as const };
  }

  if (!identity.email) throw new SsoError('The identity provider did not share an email address', 'SSO_NO_EMAIL');
  if (!identity.emailVerified) throw new SsoError('Your email address is not verified with the identity provider', 'SSO_UNVERIFIED');

  let user = await db.user.findFirst({ where: { tenantId, email: { equals: identity.email, mode: 'insensitive' } } });
  let how: 'matched' | 'created' = 'matched';
  if (!user) {
    if (!provider.autoProvision) {
      throw new SsoError('There is no account for this email in this organization. Ask an administrator to invite you.', 'SSO_NO_ACCOUNT');
    }
    user = await db.user.create({
      data: { tenantId, email: identity.email, name: identity.name, userType: 'TENANT_USER', status: 'ACTIVE' },
    });
    how = 'created';
  }
  await db.externalIdentity.create({
    data: { tenantId, userId: user.id, providerId: provider.id, subject: identity.subject, email: identity.email },
  });
  return { user, how };
}
