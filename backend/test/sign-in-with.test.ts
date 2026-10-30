/**
 * "Sign in with" (lib/oidc/): the platform as an OpenID Connect provider for
 * the applications in its catalogue. These tests play the application: the
 * whole authorization code flow with PKCE against the real server, the ID
 * token checked against the published keys, userinfo, refresh, sign-out, and
 * who may sign in (the organization must have the application turned on).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { api, baseUrl, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type PlatformSeed, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let B: TenantSeed;
let P: PlatformSeed;
let platform: string;
let adminA: string;
let memberA: string;
let adminB: string;
const appIds: string[] = [];
const REDIRECT = 'http://localhost:9/callback';
let discovery: Record<string, string>;

before(async () => {
  // The issuer is this test server (BFF_URL), so discovery and tokens name it
  process.env.BFF_URL = baseUrl();
  process.env.FRONTEND_URL = 'http://localhost:5173';
  A = await seedTenant('oidc-a');
  B = await seedTenant('oidc-b');
  P = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', P.adminEmail)).cookie;
  adminA = (await loginSession(A.slug, A.adminEmail)).cookie;
  memberA = (await loginSession(A.slug, A.userEmail)).cookie;
  adminB = (await loginSession(B.slug, B.adminEmail)).cookie;
  discovery = (await api('GET', '/oidc/.well-known/openid-configuration')).json;
});
after(async () => {
  const { controlDb } = await db();
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: { in: appIds } } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: { in: appIds } } });
  await stopServerAndCleanUp();
});

// --- A small relying party -------------------------------------------------

class Browser {
  jar = new Map<string, string>();
  constructor(siteCookie = '') {
    for (const c of siteCookie.split('; ').filter(Boolean)) this.store(c);
  }
  private store(c: string) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i);
    const value = pair.slice(i + 1);
    if (!value || /expires=Thu, 01 Jan 1970/i.test(c) || /max-age=0\b/i.test(c)) this.jar.delete(name);
    else this.jar.set(name, value);
  }
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async go(url: string, init: RequestInit = {}) {
    const res = await fetch(url.startsWith('http') ? url : baseUrl() + url, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers as Record<string, string>), cookie: this.cookie() },
    });
    for (const c of res.headers.getSetCookie()) this.store(c);
    return res;
  }
  /** Post a page's form, as the page's script or a click would */
  async submit(page: string, extra: Record<string, string> = {}) {
    const action = /<form[^>]*action="([^"]+)"/.exec(page)![1].replace(/&amp;/g, '&');
    const fields = Object.fromEntries([...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/?>/g)].map((m) => [m[1], m[2]]));
    return this.go(new URL(action, baseUrl()).href, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: baseUrl() },
      body: new URLSearchParams({ ...fields, ...extra }).toString(),
    });
  }
  /** Follow redirects (and self-submitting forms) on the provider until one leaves it, or a page is shown */
  async follow(url: string): Promise<{ location?: string; res: Response }> {
    let res = await this.go(url);
    for (let i = 0; i < 15; i++) {
      if (res.status >= 300 && res.status < 400) {
        const location = new URL(res.headers.get('location')!, baseUrl()).href;
        if (!location.startsWith(baseUrl())) return { location, res };
        res = await this.go(location);
      } else if (res.status === 200 && (res.headers.get('content-type') ?? '').includes('html')) {
        const page = await res.text();
        if (!/forms\[0\]\.submit\(\)|\.submit\(\)<\/script>/.test(page)) return { res: new Response(page, { status: 200 }) };
        res = await this.submit(page);
      } else break;
    }
    return { res };
  }
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

function authorizeUrl(clientId: string, extra: Record<string, string> = {}) {
  const { verifier, challenge } = pkce();
  const state = randomBytes(8).toString('hex');
  const nonce = randomBytes(8).toString('hex');
  const u = new URL(discovery.authorization_endpoint);
  for (const [k, v] of Object.entries({
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', scope: 'openid email profile organization roles',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', ...extra,
  })) u.searchParams.set(k, v);
  return { url: u.href, verifier, state, nonce };
}

async function signIn(browser: Browser, clientId: string, extra: Record<string, string> = {}) {
  const req = authorizeUrl(clientId, extra);
  const { location, res } = await browser.follow(req.url);
  return { ...req, location: location ? new URL(location) : undefined, res };
}

async function token(body: Record<string, string>, auth?: { id: string; secret: string }) {
  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(auth && { authorization: `Basic ${Buffer.from(`${encodeURIComponent(auth.id)}:${encodeURIComponent(auth.secret)}`).toString('base64')}` }),
    },
    body: new URLSearchParams(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function makeApp(key: string, settings: Record<string, unknown> = {}) {
  const created = await api('POST', '/applications', { cookie: platform, body: { key: `${key}-${randomBytes(3).toString('hex')}`, name: `App ${key}` } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  appIds.push(created.json.id);
  const res = await api('PUT', `/applications/${created.json.id}/sign-in`, {
    cookie: platform,
    body: { enabled: true, clientType: 'CONFIDENTIAL', redirectUris: [REDIRECT], postLogoutRedirectUris: ['http://localhost:9/bye'], initiateLoginUri: 'https://app.example/login', ...settings },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { id: created.json.id as string, clientId: res.json.settings.clientId as string, secret: res.json.clientSecret as string | undefined };
}

async function entitle(tenantId: string, applicationId: string, state = 'ENABLED') {
  const { controlDb } = await db();
  await controlDb.tenantApplication.upsert({
    where: { tenantId_applicationId: { tenantId, applicationId } },
    create: { tenantId, applicationId, state },
    update: { state },
  });
}

async function userId(t: TenantSeed, email: string) {
  const { dataOf } = await import('./helpers.js');
  return (await (await dataOf(t.tenantId)).user.findFirstOrThrow({ where: { email } })).id;
}

// --- The flow ----------------------------------------------------------------

test('discovery describes a code-flow provider with PKCE on this issuer', async () => {
  assert.equal(discovery.issuer, `${baseUrl()}/oidc`);
  assert.equal(discovery.authorization_endpoint, `${baseUrl()}/oidc/auth`);
  assert.deepEqual((discovery as any).response_types_supported, ['code']);
  assert.deepEqual((discovery as any).code_challenge_methods_supported, ['S256']);
  for (const s of ['openid', 'email', 'profile', 'organization', 'roles', 'offline_access']) assert.ok((discovery as any).scopes_supported.includes(s), s);
  const jwks = await api('GET', '/oidc/jwks');
  assert.equal(jwks.status, 200);
  assert.ok(jwks.json.keys.length >= 1);
  assert.ok(!('d' in jwks.json.keys[0]), 'only public keys are published');
});

test('signing in: to the site first, then only with the application turned on; tokens, userinfo, refresh', async () => {
  const app = await makeApp('crm');
  // Someone not signed in to the site goes to its sign-in page and comes back
  const anon = new Browser();
  const first = await signIn(anon, app.clientId);
  assert.ok(first.location, 'redirected away');
  assert.equal(first.location!.origin + first.location!.pathname, 'http://localhost:5173/login');
  const back = first.location!.searchParams.get('continue')!;
  assert.match(back, new RegExp(`^${baseUrl()}/oidc/interaction/[\\w-]+$`));

  // Signed in, but the organization hasn't turned the application on
  const browser = new Browser(memberA);
  const denied = await signIn(browser, app.clientId);
  assert.equal(denied.location?.origin + denied.location!.pathname, REDIRECT);
  assert.equal(denied.location!.searchParams.get('error'), 'access_denied');
  assert.match(denied.location!.searchParams.get('error_description')!, /turned on/);
  assert.equal(denied.location!.searchParams.get('state'), denied.state);

  // Turned on: a code comes back to the application
  await entitle(A.tenantId, app.id);
  const ok = await signIn(browser, app.clientId, { scope: 'openid email profile organization roles offline_access', prompt: 'consent' });
  assert.equal(ok.location?.origin + ok.location!.pathname, REDIRECT, ok.res.status + (await ok.res.text()));
  assert.equal(ok.location!.searchParams.get('state'), ok.state);
  const code = ok.location!.searchParams.get('code')!;
  assert.ok(code);

  // The code needs the client's secret and the PKCE verifier
  assert.equal((await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: ok.verifier }, { id: app.clientId, secret: 'wrong' })).status, 401);
  const noVerifier = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: pkce().verifier }, { id: app.clientId, secret: app.secret! });
  assert.equal(noVerifier.status, 400);

  const ok2 = await signIn(browser, app.clientId, { scope: 'openid email profile organization roles offline_access', prompt: 'consent' });
  const tokens = await token({ grant_type: 'authorization_code', code: ok2.location!.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: ok2.verifier }, { id: app.clientId, secret: app.secret! });
  assert.equal(tokens.status, 200, JSON.stringify(tokens.json));
  assert.ok(tokens.json.id_token && tokens.json.access_token && tokens.json.refresh_token);

  // The ID token: signed with a published key, for this application, this person
  const { payload, protectedHeader } = await jwtVerify(tokens.json.id_token, createRemoteJWKSet(new URL(discovery.jwks_uri)), { issuer: discovery.issuer, audience: app.clientId });
  assert.equal(protectedHeader.alg, 'RS256');
  assert.equal(payload.nonce, ok2.nonce);
  const memberId = await userId(A, A.userEmail);
  assert.equal(payload.sub, `${A.tenantId}.${memberId}`);

  // userinfo: who they are and in which organization
  const info = await fetch(discovery.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.json.access_token}` } });
  assert.equal(info.status, 200);
  const claims = (await info.json()) as Record<string, any>;
  assert.equal(claims.sub, payload.sub);
  assert.equal(claims.email, A.userEmail);
  assert.equal(claims.tenant_id, A.tenantId);
  assert.equal(claims.tenant_slug, A.slug);
  assert.ok(Array.isArray(claims.roles) && Array.isArray(claims.permissions));

  // Refresh: a new pair, the old refresh token spent
  const refreshed = await token({ grant_type: 'refresh_token', refresh_token: tokens.json.refresh_token }, { id: app.clientId, secret: app.secret! });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
  assert.notEqual(refreshed.json.refresh_token, tokens.json.refresh_token);

  // The organization turns the application off: refreshing stops working
  await entitle(A.tenantId, app.id, 'DISABLED');
  const afterOff = await token({ grant_type: 'refresh_token', refresh_token: refreshed.json.refresh_token }, { id: app.clientId, secret: app.secret! });
  assert.equal(afterOff.status, 400);
  assert.equal(afterOff.json.error, 'invalid_grant');

  // ... and so does signing in, even silently with the provider's session
  const silent = await signIn(browser, app.clientId, { prompt: 'none' });
  assert.equal(silent.location!.searchParams.get('error'), 'login_required');

  // The sign-in is in the organization's audit log
  const log = await api('GET', '/audit?event=auth.application_signed_in', { cookie: adminA });
  assert.equal(log.status, 200);
  assert.ok(JSON.stringify(log.json).includes(`App crm`));
});

test('silent sign-in follows the site session: a different or ended session asks again', async () => {
  const app = await makeApp('silent');
  await entitle(A.tenantId, app.id);
  await entitle(B.tenantId, app.id);
  const browser = new Browser(memberA);
  const first = await signIn(browser, app.clientId);
  assert.ok(first.location!.searchParams.get('code'));
  // Again, with prompt=none: no interaction needed
  const again = await signIn(browser, app.clientId, { prompt: 'none' });
  assert.ok(again.location!.searchParams.get('code'), again.location?.href ?? 'no redirect');

  // Someone else signs in to the site in the same browser
  for (const name of ['access_token', 'refresh_token']) browser.jar.delete(name);
  for (const c of adminB.split('; ')) browser.jar.set(c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1));
  const other = await signIn(browser, app.clientId, { prompt: 'none' });
  assert.equal(other.location!.searchParams.get('error'), 'login_required');
  // The provider's session was someone else's: it ends that one first, but
  // that's not the person signing out of the site
  const asB = await signIn(browser, app.clientId);
  assert.ok(browser.jar.has('access_token'), 'still signed in to the site');
  const tokens = await token({ grant_type: 'authorization_code', code: asB.location!.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: asB.verifier }, { id: app.clientId, secret: app.secret! });
  const { payload } = await jwtVerify(tokens.json.id_token, createRemoteJWKSet(new URL(discovery.jwks_uri)), { issuer: discovery.issuer, audience: app.clientId });
  assert.equal(payload.sub, `${B.tenantId}.${await userId(B, B.adminEmail)}`);

  // Signed out of the site: silent sign-in no longer works
  for (const name of ['access_token', 'refresh_token']) browser.jar.delete(name);
  const out = await signIn(browser, app.clientId, { prompt: 'none' });
  assert.equal(out.location!.searchParams.get('error'), 'login_required');
});

test('a public client signs in with PKCE alone; unknown or switched-off clients are refused', async () => {
  const app = await makeApp('spa', { clientType: 'PUBLIC' });
  assert.equal(app.secret, undefined, 'no secret for a public client');
  await entitle(A.tenantId, app.id);
  const browser = new Browser(memberA);
  const res = await signIn(browser, app.clientId);
  const tokens = await token({ grant_type: 'authorization_code', client_id: app.clientId, code: res.location!.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: res.verifier });
  assert.equal(tokens.status, 200, JSON.stringify(tokens.json));

  // PKCE is required
  const u = new URL(authorizeUrl(app.clientId).url);
  u.searchParams.delete('code_challenge');
  u.searchParams.delete('code_challenge_method');
  const noPkce = await browser.follow(u.href);
  assert.equal(new URL(noPkce.location!).searchParams.get('error'), 'invalid_request');

  // An unknown client, or a redirect it didn't register: an error page, not a redirect
  const unknown = await browser.go(authorizeUrl('mtc_nobody').url);
  assert.equal(unknown.status, 400);
  assert.ok(!unknown.headers.get('location'));
  const elsewhere = await browser.go(authorizeUrl(app.clientId, { redirect_uri: 'https://evil.example/cb' }).url);
  assert.equal(elsewhere.status, 400);

  // Sign-in turned off for the application: the client no longer exists
  await api('PUT', `/applications/${app.id}/sign-in`, { cookie: platform, body: { enabled: false, clientType: 'PUBLIC', redirectUris: [REDIRECT] } });
  assert.equal((await browser.go(authorizeUrl(app.clientId).url)).status, 400);
});

test("signing out from the application ends the site session too, when it names the person", async () => {
  const app = await makeApp('logout');
  await entitle(A.tenantId, app.id);
  const { cookie } = await loginSession(A.slug, A.userEmail);
  const browser = new Browser(cookie);
  const res = await signIn(browser, app.clientId);
  const tokens = await token({ grant_type: 'authorization_code', code: res.location!.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: res.verifier }, { id: app.clientId, secret: app.secret! });
  const end = new URL(discovery.end_session_endpoint);
  end.searchParams.set('id_token_hint', tokens.json.id_token);
  end.searchParams.set('post_logout_redirect_uri', 'http://localhost:9/bye');
  const page = await browser.go(end.href);
  assert.equal(page.status, 200);
  // The page submits itself (id_token_hint given): do what the browser would
  const htmlText = await page.text();
  assert.match(htmlText, /\.submit\(\)/);
  const done = await browser.submit(htmlText);
  assert.equal(done.status, 303);
  assert.equal(done.headers.get('location'), 'http://localhost:9/bye');
  assert.ok(!browser.jar.has('access_token') && !browser.jar.has('refresh_token'), 'site cookies cleared');
  // The site's refresh token was revoked too
  const refresh = cookie.split('; ').find((c) => c.startsWith('refresh_token='))!;
  assert.equal((await api('POST', '/bff/auth/refresh', { cookie: refresh })).status, 401);
});

test("who can't sign in: platform staff, people no longer active; signing out without an ID token asks first", async () => {
  const app = await makeApp('who');
  await entitle(A.tenantId, app.id);
  // Platform accounts aren't organization members
  const staff = await signIn(new Browser(platform), app.clientId);
  assert.equal(staff.location!.searchParams.get('error'), 'access_denied');
  assert.match(staff.location!.searchParams.get('error_description')!, /organization account/);

  // A deactivated account: its refresh token stops working
  const { cookie } = await loginSession(A.slug, A.managerEmail);
  const browser = new Browser(cookie);
  const res = await signIn(browser, app.clientId, { scope: 'openid offline_access', prompt: 'consent' });
  const tokens = await token({ grant_type: 'authorization_code', code: res.location!.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: res.verifier }, { id: app.clientId, secret: app.secret! });
  assert.ok(tokens.json.refresh_token);
  const data = A.db;
  const manager = await data.user.findFirstOrThrow({ where: { email: A.managerEmail, tenantId: A.tenantId } });
  await data.user.update({ where: { id: manager.id }, data: { status: 'INACTIVE' } });
  try {
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: tokens.json.refresh_token }, { id: app.clientId, secret: app.secret! });
    assert.equal(refreshed.json.error, 'invalid_grant');
  } finally {
    await data.user.update({ where: { id: manager.id }, data: { status: 'ACTIVE' } });
  }

  // Without id_token_hint, another site could be asking: a page to confirm
  const page = await browser.go(discovery.end_session_endpoint);
  assert.equal(page.status, 200);
  const text = await page.text();
  assert.doesNotMatch(text, /\.submit\(\)/);
  assert.match(text, /Sign out\?/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
});

test('sign-in settings: platform staff only; secrets shown once and replaceable; bad addresses refused', async () => {
  const app = await makeApp('settings');
  // Tenants can't see or change them
  assert.equal((await api('GET', `/applications/${app.id}/sign-in`, { cookie: adminA })).status, 403);
  assert.equal((await api('POST', `/applications/${app.id}/sign-in/secret`, { cookie: adminA })).status, 403);

  const got = await api('GET', `/applications/${app.id}/sign-in`, { cookie: platform });
  assert.equal(got.status, 200);
  assert.equal(got.json.issuer, `${baseUrl()}/oidc`);
  assert.equal(got.json.settings.hasSecret, true);
  assert.ok(!JSON.stringify(got.json).includes(app.secret!), 'the secret is never shown again');

  // Stored encrypted
  const { controlDb } = await db();
  const row = await controlDb.applicationSignIn.findUniqueOrThrow({ where: { applicationId: app.id } });
  assert.match(row.oidcClientSecret!, /^enc:v\d+:/);

  // Replaced: the old one stops working
  await entitle(A.tenantId, app.id);
  const rotated = await api('POST', `/applications/${app.id}/sign-in/secret`, { cookie: platform });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.json.clientSecret, app.secret);
  const browser = new Browser(memberA);
  const res = await signIn(browser, app.clientId);
  const body = { grant_type: 'authorization_code', code: res.location!.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: res.verifier };
  assert.equal((await token(body, { id: app.clientId, secret: app.secret! })).status, 401);
  assert.equal((await token(body, { id: app.clientId, secret: rotated.json.clientSecret })).status, 200);

  for (const bad of ['http://app.example/cb', 'https://app.example/cb#x', 'javascript:alert(1)', 'not a url']) {
    const r = await api('PUT', `/applications/${app.id}/sign-in`, { cookie: platform, body: { enabled: true, clientType: 'CONFIDENTIAL', redirectUris: [bad] } });
    assert.equal(r.status, 400, bad);
  }
  const none = await api('PUT', `/applications/${app.id}/sign-in`, { cookie: platform, body: { enabled: true, clientType: 'CONFIDENTIAL', redirectUris: [] } });
  assert.equal(none.status, 400);
});

test("the organization's applications: those turned on now, with where to open them", async () => {
  const on = await makeApp('launch');
  const off = await makeApp('launch-off');
  const { controlDb } = await db();
  await entitle(B.tenantId, on.id, 'TRIAL');
  await entitle(B.tenantId, off.id, 'DISABLED');
  const expired = await makeApp('launch-expired');
  await controlDb.tenantApplication.create({ data: { tenantId: B.tenantId, applicationId: expired.id, state: 'ENABLED', validTo: new Date(Date.now() - 1000) } });

  const { cookie: member } = await loginSession(B.slug, B.userEmail);
  const res = await api('GET', '/tenant-applications/launchpad', { cookie: member });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const ids = res.json.applications.map((a: { id: string }) => a.id);
  assert.ok(ids.includes(on.id));
  assert.ok(!ids.includes(off.id) && !ids.includes(expired.id));
  const entry = res.json.applications.find((a: { id: string }) => a.id === on.id);
  assert.equal(entry.state, 'TRIAL');
  assert.equal(entry.openUrl, `https://app.example/login?iss=${encodeURIComponent(`${baseUrl()}/oidc`)}`);
});
