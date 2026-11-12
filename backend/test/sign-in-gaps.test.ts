/**
 * Sign-in rules that used to have a way round them:
 * - "single sign-on only" also turns off emailed codes;
 * - an email address is the same person whatever capitals it's typed with;
 * - passwords are scrypt hashes, and older hashes are replaced at sign-in;
 * - refresh tokens and emailed codes are stored as hashes;
 * - in production, identity providers must be at public addresses;
 * - every audit chain can be checked in one go (the scheduled check).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PASSWORD, api, db, loginSession, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';
import { checkSignInPassword, hashPassword, passwordNeedsRehash, verifyPassword } from '../src/utils/auth.js';
import { SsoError, assertPublicProviderUrl } from '../src/lib/sso.js';
import { verifyAllChains } from '../src/lib/audit.js';

// Emails the server sends are appended to this file
const outbox = join(mkdtempSync(join(tmpdir(), 'mail-')), 'outbox.jsonl');
process.env.EMAIL_TRANSPORT = 'file';
process.env.MAIL_OUTBOX_FILE = outbox;

/** The sign-in code in the last email sent to an address */
function emailedCode(to: string): string {
  const mails = existsSync(outbox) ? readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { to: string; text: string }) : [];
  const m = mails.filter((mail) => mail.to === to).at(-1)?.text.match(/sign-in code for .* is (\d{6})\./);
  assert.ok(m, `no sign-in code emailed to ${to}`);
  return m[1];
}

let A: TenantSeed;

before(async () => {
  A = await seedTenant('gaps-a');
  await startServer();
});

after(async () => {
  await stopServerAndCleanUp();
});

const passwordLogin = (email: string, password = PASSWORD) => api('POST', '/bff/auth/login', { body: { email, tenantSlug: A.slug, password } });
const sessionCookies = (res: { headers: Headers }) => res.headers.getSetCookie().filter((c) => c.startsWith('access_token=') || c.startsWith('refresh_token='));
/** A PBKDF2 hash as they were made before scrypt */
function oldStyleHash(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex')}`;
}

test('single sign-on only refuses emailed codes as well as passwords', async () => {
  const body = { email: A.userEmail, tenantSlug: A.slug };
  // A code asked for while codes were still allowed
  const asked = await api('POST', '/bff/auth/otp/request', { body });
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  const code = emailedCode(A.userEmail);
  // Kept as a keyed hash, not the code
  const stored = await A.db.otpCode.findFirstOrThrow({ where: { tenantId: A.tenantId, email: A.userEmail } });
  assert.match(stored.code, /^[0-9a-f]{64}$/);
  assert.equal((await api('POST', '/bff/auth/otp/verify', { body: { ...body, code: code === '000000' ? '000001' : '000000' } })).status, 401, 'a wrong code');

  await A.db.authConfig.update({ where: { tenantId: A.tenantId }, data: { ssoOnly: true } });
  try {
    assert.equal((await passwordLogin(A.userEmail)).status, 403, 'password');
    assert.equal((await api('POST', '/bff/auth/otp/request', { body })).status, 403, 'asking for a code');
    const used = await api('POST', '/bff/auth/otp/verify', { body: { ...body, code } });
    assert.equal(used.status, 403, 'a code sent before the change');
    assert.equal(sessionCookies(used).length, 0, 'no session');
  } finally {
    await A.db.authConfig.update({ where: { tenantId: A.tenantId }, data: { ssoOnly: false } });
  }

  // Codes turned off (single sign-on not required): the code is no use either
  await A.db.authConfig.update({ where: { tenantId: A.tenantId }, data: { otpEnabled: false } });
  try {
    assert.equal((await api('POST', '/bff/auth/otp/verify', { body: { ...body, code } })).status, 400);
  } finally {
    await A.db.authConfig.update({ where: { tenantId: A.tenantId }, data: { otpEnabled: true } });
  }

  // Allowed again: the same code signs in
  const ok = await api('POST', '/bff/auth/otp/verify', { body: { ...body, code } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(sessionCookies(ok).length, 2);
});

test('an email address is the same person whatever capitals it is typed with', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const stamp = Date.now();

  // Invitations keep the address in lower case, and the same address can't be invited twice
  const invited = await api('POST', '/users', { cookie: admin.cookie, body: { email: `Mixed.Case-${stamp}@Test.Local`, name: 'Mixed Case' } });
  assert.equal(invited.status, 201, JSON.stringify(invited.json));
  assert.equal(invited.json.email, `mixed.case-${stamp}@test.local`);
  const twice = await api('POST', '/users', { cookie: admin.cookie, body: { email: `MIXED.CASE-${stamp}@test.local`, name: 'Mixed Case' } });
  assert.equal(twice.status, 409, JSON.stringify(twice.json));

  // Capitals typed at sign-in
  assert.equal((await passwordLogin(A.userEmail.toUpperCase())).status, 200);

  // An account stored with capitals before addresses were lower-cased
  const legacy = `Legacy-${stamp}@Test.Local`;
  await A.db.user.create({ data: { tenantId: A.tenantId, email: legacy, name: 'Legacy', userType: 'TENANT_USER', passwordHash: await hashPassword(PASSWORD) } });
  assert.equal((await passwordLogin(legacy)).status, 200, 'as stored');
  assert.equal((await passwordLogin(legacy.toLowerCase())).status, 200, 'in lower case');
  const again = await api('POST', '/users', { cookie: admin.cookie, body: { email: legacy.toLowerCase(), name: 'Legacy' } });
  assert.equal(again.status, 409, 'already a user');

  // Comparing without case is a pattern match in the database: `_` must not stand for any character
  await A.db.user.create({ data: { tenantId: A.tenantId, email: `aXb-${stamp}@test.local`, name: 'Other', userType: 'TENANT_USER', passwordHash: await hashPassword(PASSWORD) } });
  assert.equal((await passwordLogin(`a_b-${stamp}@test.local`)).status, 401);
});

test('passwords are scrypt hashes; older hashes still work and are replaced at sign-in', async () => {
  const hash = await hashPassword(PASSWORD);
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(hash, await hashPassword(PASSWORD), 'a new salt each time');
  assert.equal(await verifyPassword(PASSWORD, hash), true);
  assert.equal(await verifyPassword(`${PASSWORD}x`, hash), false);
  assert.equal(passwordNeedsRehash(hash), false);

  const old = oldStyleHash(PASSWORD);
  assert.equal(await verifyPassword(PASSWORD, old), true);
  assert.equal(await verifyPassword('wrong-password', old), false);
  assert.equal(passwordNeedsRehash(old), true);

  for (const bad of ['', 'nonsense', 'scrypt$1$8$1$YQ==$YQ==', 'scrypt$32768$8$3$$', 'scrypt$1073741824$8$1$YQ==$YQ==']) {
    assert.equal(await verifyPassword(PASSWORD, bad), false, bad);
  }
  // No account, or one without a password: never right
  assert.equal(await checkSignInPassword(PASSWORD, null), false);
  assert.equal(await checkSignInPassword(PASSWORD, hash), true);

  // Signing in with an old hash replaces it
  const email = `old-hash-${Date.now()}@test.local`;
  const user = await A.db.user.create({ data: { tenantId: A.tenantId, email, name: 'Old Hash', userType: 'TENANT_USER', passwordHash: old } });
  assert.equal((await passwordLogin(email, 'wrong-password')).status, 401);
  assert.equal((await A.db.user.findFirstOrThrow({ where: { id: user.id, tenantId: A.tenantId } })).passwordHash, old, 'a wrong password changes nothing');
  assert.equal((await passwordLogin(email)).status, 200);
  const stored = (await A.db.user.findFirstOrThrow({ where: { id: user.id, tenantId: A.tenantId } })).passwordHash!;
  assert.ok(stored.startsWith('scrypt$'), stored.slice(0, 12));
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  assert.equal((await passwordLogin(email)).status, 200, 'and the password still works');
});

test('refresh tokens are stored as hashes; sessions from before still refresh', async () => {
  const s = await loginSession(A.slug, A.managerEmail);
  const value = decodeURIComponent(s.cookie.split('; ').find((c) => c.startsWith('refresh_token='))!.slice('refresh_token='.length));
  const sid = JSON.parse(Buffer.from(s.token.split('.')[1], 'base64url').toString()).sid as string;
  const row = await A.db.refreshToken.findFirstOrThrow({ where: { tenantId: A.tenantId, familyId: sid } });
  assert.equal(row.token, crypto.createHash('sha256').update(value).digest('hex'));
  assert.ok(!row.token.includes(value));

  // It still works as a session, and a rotated-out token is still noticed
  assert.equal((await api('POST', '/bff/auth/refresh', { cookie: s.cookie })).status, 200);
  assert.equal((await api('POST', '/bff/auth/refresh', { cookie: s.cookie })).status, 401, 'the old token again');

  // A session whose token was stored as sent, before this
  const manager = await A.db.user.findFirstOrThrow({ where: { tenantId: A.tenantId, email: A.managerEmail } });
  const plain = `${A.slug}.${crypto.randomBytes(48).toString('base64url')}`;
  await A.db.refreshToken.create({
    data: { tenantId: A.tenantId, userId: manager.id, token: plain, familyId: crypto.randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 3_600_000) },
  });
  const renewed = await api('POST', '/bff/auth/refresh', { cookie: `refresh_token=${plain}` });
  assert.equal(renewed.status, 200, JSON.stringify(renewed.json));
  assert.equal(sessionCookies(renewed).length, 2);
});

test('in production, identity providers must be at public https addresses', async () => {
  for (const bad of ['http://idp.example.com', 'https://127.0.0.1/', 'https://10.0.0.5', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/', 'https://localhost', 'https://db.internal', 'not a url']) {
    await assert.rejects(assertPublicProviderUrl(bad, true), SsoError, bad);
  }
  await assertPublicProviderUrl('https://8.8.8.8/', true);
  // Nothing to check, or not enforced (outside production, or SSO_ALLOW_PRIVATE=true)
  await assertPublicProviderUrl(null, true);
  await assertPublicProviderUrl('http://127.0.0.1:9/', false);
});

test('checking every audit chain finds the one that was cut short', async () => {
  const { controlDb } = await db();
  // Other test files' tenants share the database: only this tenant's chain is looked at
  const mine = async () => (await verifyAllChains({ recheckAfterMs: 0 })).find((r) => r.chain === A.tenantId);
  const head = await controlDb.auditHead.findUniqueOrThrow({ where: { chain: A.tenantId } });
  assert.equal(await mine(), undefined, 'the chain verifies as it is');

  // The recorded head says there were more entries than the log holds
  await controlDb.auditHead.update({ where: { chain: A.tenantId }, data: { seq: head.seq + 5 } });
  try {
    const report = await mine();
    assert.ok(report && !report.ok, 'reported');
    assert.match(report.problems[0].problem, /missing from the end/);
  } finally {
    await controlDb.auditHead.update({ where: { chain: A.tenantId }, data: { seq: head.seq, hash: head.hash } });
  }
});
