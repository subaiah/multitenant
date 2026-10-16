/**
 * Two-factor sign-in, session rules (idle and maximum length) and single
 * sign-on against a local OpenID Connect provider.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  PASSWORD, api, baseUrl, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp,
  type PlatformSeed, type TenantSeed,
} from './helpers.js';
import { currentStep, totpAt, verifyTotp } from '../src/lib/mfa.js';
import { isEncrypted } from '../src/lib/secrets.js';

let A: TenantSeed;
let P: PlatformSeed;
let controlDb: Awaited<ReturnType<typeof db>>['controlDb'];

// ------------------------------------------------------------ fake OpenID provider

interface Identity { sub: string; email?: string; email_verified?: boolean; name?: string }
const idp = {
  server: undefined as Server | undefined,
  issuer: '',
  next: { sub: 'x' } as Identity,
  /** Tamper with the ID token (tests that it's checked) */
  badNonce: false,
  codes: new Map<string, { identity: Identity; nonce?: string; challenge: string; clientId: string }>(),
};

before(async () => {
  ({ controlDb } = await db());
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idp.server = createServer(async (req, res) => {
    const url = new URL(req.url!, idp.issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        jwks_uri: `${idp.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const code = crypto.randomBytes(16).toString('hex');
      idp.codes.set(code, {
        identity: idp.next,
        nonce: url.searchParams.get('nonce') ?? undefined,
        challenge: url.searchParams.get('code_challenge') ?? '',
        clientId: url.searchParams.get('client_id') ?? '',
      });
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const grant = idp.codes.get(form.get('code') ?? '');
      idp.codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (!grant || challenge !== grant.challenge || form.get('client_secret') !== 'idp-secret') {
        return json(400, { error: 'invalid_grant' });
      }
      const idToken = await new SignJWT({
        ...grant.identity,
        nonce: idp.badNonce ? 'something-else' : grant.nonce,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(idp.issuer)
        .setAudience(grant.clientId)
        .setSubject(grant.identity.sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return json(200, { access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => idp.server!.listen(0, '127.0.0.1', resolve));
  idp.issuer = `http://127.0.0.1:${(idp.server!.address() as AddressInfo).port}`;

  A = await seedTenant('auth-a');
  P = await seedPlatformUsers();
  await startServer();
});

after(async () => {
  idp.server?.close();
  await stopServerAndCleanUp();
});

const cookiesOf = (res: { headers: Headers }) => res.headers.getSetCookie().map((c) => c.split(';')[0]);
const cookieHeader = (res: { headers: Headers }) => cookiesOf(res).join('; ');
const accessOf = (res: { headers: Headers }) => cookiesOf(res).find((c) => c.startsWith('access_token='))?.slice('access_token='.length);

async function userId(email: string) {
  return (await A.db.user.findFirstOrThrow({ where: { tenantId: A.tenantId, email } })).id;
}
async function setAuth(data: { mfaEnabled?: boolean; sessionTimeout?: number; maxSessionHours?: number }) {
  await A.db.authConfig.update({ where: { tenantId: A.tenantId }, data });
}

/** Sign in with a password; returns the response (a session, or the two-factor step). */
const passwordLogin = (email: string, tenantSlug = A.slug) => api('POST', '/bff/auth/login', { body: { email, tenantSlug, password: PASSWORD } });

/** Set up an authenticator for a signed-in user; returns the secret and recovery codes. */
async function enroll(session: { cookie: string }, tenant?: string) {
  const start = await api('POST', '/bff/two-factor/enroll/start', { cookie: session.cookie, tenant });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  assert.match(start.json.otpauthUrl, /^otpauth:\/\/totp\//);
  const code = totpAt(start.json.secret, currentStep());
  const confirm = await api('POST', '/bff/two-factor/enroll/confirm', { cookie: session.cookie, tenant, body: { enrollToken: start.json.enrollToken, code } });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.json));
  assert.equal(confirm.json.recoveryCodes.length, 10);
  return { secret: start.json.secret as string, recoveryCodes: confirm.json.recoveryCodes as string[] };
}

/** A code for the next unused step (the current one may have been used). */
const nextCode = (secret: string) => totpAt(secret, currentStep() + 1);

// ------------------------------------------------------------ TOTP

test('TOTP matches the RFC 6238 test vector and refuses replays', () => {
  // RFC 6238 appendix B, SHA-1, T = 59s: 94287082 (8 digits) -> last 6 digits
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  assert.equal(totpAt(secret, 1), '287082');
  const now = 59_000;
  assert.equal(verifyTotp(secret, '287082', null, now), 1);
  assert.equal(verifyTotp(secret, '287082', 1, now), null, 'same step twice');
  assert.equal(verifyTotp(secret, '000000', null, now), null);
  assert.equal(verifyTotp(secret, 'abc', null, now), null);
});

// ------------------------------------------------------------ two-factor

test('with two-factor on, a password alone gets no session; the code does', async () => {
  const session = await loginSession(A.slug, A.userEmail);
  const { secret } = await enroll(session);

  const stored = await A.db.user.findFirstOrThrow({ where: { tenantId: A.tenantId, email: A.userEmail } });
  assert.ok(stored.totpSecret && isEncrypted(stored.totpSecret), 'secret encrypted at rest');
  assert.equal(stored.mfaRecoveryCodes.length, 10);

  const first = await passwordLogin(A.userEmail);
  assert.equal(first.status, 200);
  assert.equal(first.json.mfa, 'verify');
  assert.equal(accessOf(first), undefined, 'no session before the code');
  // The MFA token is not a session token
  assert.equal((await api('GET', '/bff/auth/me', { token: first.json.mfaToken })).status, 401);

  const wrong = await api('POST', '/bff/auth/mfa/verify', { body: { mfaToken: first.json.mfaToken, code: '000000' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.code, 'MFA_INVALID');

  const code = nextCode(secret);
  const ok = await api('POST', '/bff/auth/mfa/verify', { body: { mfaToken: first.json.mfaToken, code } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.user.email, A.userEmail);
  const access = accessOf(ok);
  assert.ok(access);
  assert.equal((await api('GET', '/bff/auth/me', { token: access })).status, 200);

  // The same code can't be used again
  const again = await passwordLogin(A.userEmail);
  const replay = await api('POST', '/bff/auth/mfa/verify', { body: { mfaToken: again.json.mfaToken, code } });
  assert.equal(replay.status, 401);
});

test('a recovery code works once', async () => {
  const session = await loginSession(A.slug, A.managerEmail);
  const { recoveryCodes } = await enroll(session);
  const use = async () => {
    const step = await passwordLogin(A.managerEmail);
    return api('POST', '/bff/auth/mfa/verify', { body: { mfaToken: step.json.mfaToken, code: recoveryCodes[0].toLowerCase() } });
  };
  const ok = await use();
  assert.equal(ok.status, 200);
  assert.equal(ok.json.recoveryCodesLeft, 9);
  assert.equal((await use()).status, 401);

  // Turning it off needs a current code
  const s = { cookie: cookieHeader(ok) };
  assert.equal((await api('POST', '/bff/two-factor/disable', { cookie: s.cookie, body: { code: '000000' } })).status, 400);
  const off = await api('POST', '/bff/two-factor/disable', { cookie: s.cookie, body: { code: recoveryCodes[1] } });
  assert.equal(off.status, 200);
  assert.ok(accessOf(await passwordLogin(A.managerEmail)), 'password alone again');
});

test('when the organization requires two-factor, users without it set it up while signing in', async () => {
  const email = `mfa-req-${Date.now()}@test.local`;
  const { hashPassword } = await import('../src/utils/auth.js');
  await A.db.user.create({ data: { tenantId: A.tenantId, email, name: 'Req', userType: 'TENANT_USER', passwordHash: await hashPassword(PASSWORD) } });
  // Signed in before the requirement, so this admin has a session to work with
  const admin = await loginSession(A.slug, A.adminEmail);
  await setAuth({ mfaEnabled: true });
  try {
    const step = await passwordLogin(email);
    assert.equal(step.json.mfa, 'enroll');
    assert.equal(accessOf(step), undefined);
    // A verify token can't be swapped in
    assert.equal((await api('POST', '/bff/auth/mfa/verify', { body: { mfaToken: step.json.mfaToken, code: '123456' } })).status, 401);

    const start = await api('POST', '/bff/auth/mfa/enroll/start', { body: { mfaToken: step.json.mfaToken } });
    assert.equal(start.status, 200);
    const wrong = await api('POST', '/bff/auth/mfa/enroll/confirm', { body: { enrollToken: start.json.enrollToken, code: '000000' } });
    assert.equal(wrong.status, 400);
    const done = await api('POST', '/bff/auth/mfa/enroll/confirm', {
      body: { enrollToken: start.json.enrollToken, code: totpAt(start.json.secret, currentStep()) },
    });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(done.json.recoveryCodes.length, 10);
    const cookie = cookieHeader(done);
    assert.equal((await api('GET', '/bff/auth/me', { cookie })).status, 200);

    // Required: can't be turned off
    const status = await api('GET', '/bff/two-factor', { cookie });
    assert.deepEqual([status.json.enabled, status.json.required], [true, true]);
    assert.equal((await api('POST', '/bff/two-factor/disable', { cookie, body: { code: done.json.recoveryCodes[0] } })).status, 403);

    // An admin resets it (lost phone): set up again at the next sign-in
    const id = await userId(email);
    const list = await api('GET', `/users?search=${encodeURIComponent(email)}`, { cookie: admin.cookie });
    assert.equal(list.json.data[0].mfaEnabled, true);
    assert.ok(!JSON.stringify(list.json).includes('totp'), 'no secrets in the list');
    const reset = await api('POST', `/users/${id}/mfa/reset`, { cookie: admin.cookie });
    assert.equal(reset.status, 200);
    assert.equal((await passwordLogin(email)).json.mfa, 'enroll');
  } finally {
    await setAuth({ mfaEnabled: false });
  }
});

test('a user without users:update cannot reset someone else’s two-factor', async () => {
  const email = `plain-${Date.now()}@test.local`;
  const { hashPassword } = await import('../src/utils/auth.js');
  await A.db.user.create({ data: { tenantId: A.tenantId, email, name: 'Plain', userType: 'TENANT_USER', passwordHash: await hashPassword(PASSWORD) } });
  const s = await loginSession(A.slug, email);
  const res = await api('POST', `/users/${await userId(A.adminEmail)}/mfa/reset`, { cookie: s.cookie });
  assert.equal(res.status, 403);
});

test('platform users can use two-factor too, and a platform admin can reset it', async () => {
  const support = await loginSession('platform', P.supportEmail);
  const { secret } = await enroll(support);
  const step = await passwordLogin(P.supportEmail, 'platform');
  assert.equal(step.json.mfa, 'verify');
  const ok = await api('POST', '/bff/auth/mfa/verify', { body: { mfaToken: step.json.mfaToken, code: nextCode(secret) } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.portal, 'PLATFORM');

  const stored = await controlDb.platformUser.findUniqueOrThrow({ where: { email: P.supportEmail } });
  assert.ok(stored.platformTotpSecret && isEncrypted(stored.platformTotpSecret));

  const admin = await loginSession('platform', P.adminEmail);
  // Support can't reset; the admin can
  assert.equal((await api('POST', `/platform/users/${stored.id}/mfa/reset`, { cookie: cookieHeader(ok) })).status, 403);
  assert.equal((await api('POST', `/platform/users/${stored.id}/mfa/reset`, { cookie: admin.cookie })).status, 200);
  assert.ok(accessOf(await passwordLogin(P.supportEmail, 'platform')));
});

// ------------------------------------------------------------ sessions

async function refresh(cookie: string) {
  return api('POST', '/bff/auth/refresh', { cookie });
}

test('a session idle longer than the timeout ends at the next refresh', async () => {
  await setAuth({ sessionTimeout: 5 });
  try {
    const s = await loginSession(A.slug, A.adminEmail);
    // The access token never outlives the idle timeout
    const claims = JSON.parse(Buffer.from(s.token.split('.')[1], 'base64url').toString());
    assert.ok(claims.exp - claims.iat <= 300, `access token lives ${claims.exp - claims.iat}s`);
    assert.ok(claims.sid);

    const fine = await refresh(s.cookie);
    assert.equal(fine.status, 200);
    const cookie = cookieHeader(fine);

    await A.db.refreshToken.updateMany({ where: { familyId: claims.sid }, data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } });
    const idle = await refresh(cookie);
    assert.equal(idle.status, 401);
    assert.equal(idle.json.code, 'SESSION_IDLE');
    const left = await A.db.refreshToken.count({ where: { familyId: claims.sid, revokedAt: null } });
    assert.equal(left, 0, 'the session is revoked');
  } finally {
    await setAuth({ sessionTimeout: 60 });
  }
});

test('activity keeps a session alive', async () => {
  const s = await loginSession(A.slug, A.adminEmail);
  const sid = JSON.parse(Buffer.from(s.token.split('.')[1], 'base64url').toString()).sid;
  const old = new Date(Date.now() - 30 * 60_000);
  await A.db.refreshToken.updateMany({ where: { familyId: sid }, data: { lastSeenAt: old } });
  assert.equal((await api('GET', '/bff/auth/me', { cookie: s.cookie })).status, 200);
  const row = await A.db.refreshToken.findFirstOrThrow({ where: { familyId: sid } });
  assert.ok(row.lastSeenAt > old, 'last seen moved forward');
});

test('a session ends at its maximum length however active, and refresh keeps the start time', async () => {
  await setAuth({ maxSessionHours: 1 });
  try {
    const s = await loginSession(A.slug, A.adminEmail);
    const sid = JSON.parse(Buffer.from(s.token.split('.')[1], 'base64url').toString()).sid;
    const started = new Date(Date.now() - 50 * 60_000);
    await A.db.refreshToken.updateMany({ where: { familyId: sid }, data: { sessionStartedAt: started } });
    const r = await refresh(s.cookie);
    assert.equal(r.status, 200);
    const rows = await A.db.refreshToken.findMany({ where: { familyId: sid } });
    assert.ok(rows.every((x) => x.sessionStartedAt.getTime() === started.getTime()), 'start carried over');
    // The new access token stops at the session's end (10 minutes left)
    const claims = JSON.parse(Buffer.from(accessOf(r)!.split('.')[1], 'base64url').toString());
    assert.ok(claims.exp * 1000 <= started.getTime() + 3_600_000 + 1000);

    await A.db.refreshToken.updateMany({ where: { familyId: sid }, data: { sessionStartedAt: new Date(Date.now() - 2 * 3_600_000) } });
    const over = await refresh(cookieHeader(r));
    assert.equal(over.status, 401);
    assert.equal(over.json.code, 'SESSION_MAX');
  } finally {
    await setAuth({ maxSessionHours: 12 });
  }
});

test('session settings are validated and saved', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  assert.equal((await api('PATCH', '/auth-config', { cookie: admin.cookie, body: { maxSessionHours: 0 } })).status, 400);
  const ok = await api('PATCH', '/auth-config', { cookie: admin.cookie, body: { sessionTimeout: 45, maxSessionHours: 8 } });
  assert.equal(ok.status, 200);
  const cfg = await api('GET', '/auth-config', { cookie: admin.cookie });
  assert.deepEqual([cfg.json.sessionTimeout, cfg.json.maxSessionHours], [45, 8]);
  assert.match(cfg.json.ssoRedirectUri, /\/bff\/auth\/sso\/callback$/);
  await setAuth({ sessionTimeout: 60, maxSessionHours: 12 });
});

// ------------------------------------------------------------ single sign-on

let providerId: string;

async function ssoProvider(changes: { autoProvision?: boolean; enabled?: boolean } = {}) {
  if (!providerId) {
    const cfg = await A.db.authConfig.findUniqueOrThrow({ where: { tenantId: A.tenantId } });
    const { dbForTenant } = await import('../src/lib/tenant-db.js');
    const p = await (await dbForTenant(A.tenantId)).authProvider.create({
      data: {
        tenantId: A.tenantId, authConfigId: cfg.id, provider: 'CUSTOM_OIDC', enabled: true,
        clientId: 'idp-client', clientSecret: 'idp-secret', domain: idp.issuer, scopes: [],
      },
    });
    providerId = p.id;
  }
  if (Object.keys(changes).length) await A.db.authProvider.update({ where: { id: providerId }, data: changes });
}

/** The browser's trip: start → provider → callback. Returns the final redirect and cookies. */
async function ssoSignIn(identity: Identity) {
  idp.next = identity;
  const start = await fetch(`${baseUrl()}/bff/auth/sso/start?tenantSlug=${A.slug}&providerId=${providerId}`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const toIdp = start.headers.get('location')!;
  if (!toIdp.startsWith(idp.issuer)) return { location: new URL(toIdp), cookie: '', callback: '' };
  const atIdp = await fetch(toIdp, { redirect: 'manual' });
  // The provider sends the browser to the registered callback (BFF_URL); call our server instead
  const cb = new URL(atIdp.headers.get('location')!);
  const callback = `${baseUrl()}${cb.pathname}${cb.search}`;
  const done = await fetch(callback, { redirect: 'manual' });
  assert.equal(done.status, 302);
  return { location: new URL(done.headers.get('location')!), cookie: cookieHeader(done), callback };
}

test('SSO signs in an existing user by verified email, then by subject', async () => {
  await ssoProvider();
  const sub = `sub-${crypto.randomUUID()}`;
  const first = await ssoSignIn({ sub, email: A.adminEmail.toUpperCase(), email_verified: true, name: 'Admin' });
  assert.equal(first.location.pathname, `/${A.slug}/login`);
  assert.equal(first.location.searchParams.get('sso_error'), null, first.location.search);
  const me = await api('GET', '/bff/auth/me', { cookie: first.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, A.adminEmail);

  const link = await A.db.externalIdentity.findFirstOrThrow({ where: { tenantId: A.tenantId, subject: sub } });
  assert.equal(link.userId, await userId(A.adminEmail));

  // Later: the same subject signs in even if the provider's email changed
  const again = await ssoSignIn({ sub, email: 'renamed@elsewhere.test', email_verified: true });
  assert.equal((await api('GET', '/bff/auth/me', { cookie: again.cookie })).json.user.email, A.adminEmail);

  // A callback can't be replayed
  const replay = await fetch(again.callback, { redirect: 'manual' });
  assert.equal(new URL(replay.headers.get('location')!).searchParams.get('sso_error'), 'SSO_EXPIRED');
});

test('SSO refuses unverified emails, unknown users and bad ID tokens', async () => {
  await ssoProvider({ autoProvision: false });
  const unverified = await ssoSignIn({ sub: `s-${crypto.randomUUID()}`, email: A.userEmail, email_verified: false });
  assert.equal(unverified.location.searchParams.get('sso_error'), 'SSO_UNVERIFIED');
  assert.equal(unverified.cookie, '');

  const unknown = await ssoSignIn({ sub: `s-${crypto.randomUUID()}`, email: `nobody-${Date.now()}@test.local`, email_verified: true });
  assert.equal(unknown.location.searchParams.get('sso_error'), 'SSO_NO_ACCOUNT');

  idp.badNonce = true;
  try {
    const bad = await ssoSignIn({ sub: `s-${crypto.randomUUID()}`, email: A.userEmail, email_verified: true });
    assert.equal(bad.location.searchParams.get('sso_error'), 'SSO_FAILED');
    assert.equal(bad.cookie, '');
  } finally {
    idp.badNonce = false;
  }
});

test('SSO creates the user when the provider auto-provisions; a disabled provider is refused', async () => {
  await ssoProvider({ autoProvision: true });
  const email = `new-${Date.now()}@test.local`;
  const res = await ssoSignIn({ sub: `s-${crypto.randomUUID()}`, email, email_verified: true, name: 'New Person' });
  assert.equal(res.location.searchParams.get('sso_error'), null);
  const created = await A.db.user.findFirstOrThrow({ where: { tenantId: A.tenantId, email } });
  assert.deepEqual([created.userType, created.status, created.name, created.passwordHash], ['TENANT_USER', 'ACTIVE', 'New Person', null]);

  await ssoProvider({ enabled: false });
  const off = await ssoSignIn({ sub: 'x', email, email_verified: true });
  assert.equal(off.location.searchParams.get('sso_error'), 'SSO_UNAVAILABLE');
  await ssoProvider({ enabled: true, autoProvision: false });
});
