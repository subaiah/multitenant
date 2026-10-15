/**
 * Email-driven account flows, end to end: the server writes outgoing mail to
 * a file (EMAIL_TRANSPORT=file) and the tests read it like an inbox.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outbox = join(mkdtempSync(join(tmpdir(), 'mail-')), 'outbox.jsonl');
process.env.EMAIL_TRANSPORT = 'file';
process.env.MAIL_OUTBOX_FILE = outbox;
process.env.FRONTEND_URL = 'http://app.test';

const { PASSWORD, api, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp } = await import('./helpers.js');
type TenantSeed = Awaited<ReturnType<typeof seedTenant>>;

let A: TenantSeed;
let platformAdmin: string;
let prisma: Awaited<ReturnType<typeof db>>['prisma'];

interface Mail { to: string; subject: string; text: string; html: string }
function inbox(to: string): Mail[] {
  if (!existsSync(outbox)) return [];
  return readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Mail).filter((m) => m.to === to);
}
const lastMail = (to: string) => inbox(to).at(-1);
const tokenFrom = (mail: Mail | undefined) => {
  const m = mail?.text.match(/token=([A-Za-z0-9_-]+)/);
  assert.ok(m, `no link in mail: ${mail?.text}`);
  return decodeURIComponent(m[1]);
};

before(async () => {
  ({ prisma } = await db());
  A = await seedTenant('acct');
  platformAdmin = (await seedPlatformUsers()).adminEmail;
  await startServer();
});
after(stopServerAndCleanUp);

test('OTP codes are emailed and work; unknown emails get the same answer and no mail', async () => {
  const res = await api('POST', '/bff/auth/otp/request', { body: { email: A.userEmail, tenantSlug: A.slug } });
  assert.equal(res.status, 200);
  assert.equal(res.json.otp, undefined, 'code is not in the response');
  const mail = lastMail(A.userEmail);
  const code = mail?.text.match(/\b(\d{6})\b/)?.[1];
  assert.ok(code, 'code is in the email');
  assert.match(mail!.subject, /sign-in code/);

  const verify = await api('POST', '/bff/auth/otp/verify', { body: { email: A.userEmail, tenantSlug: A.slug, code } });
  assert.equal(verify.status, 200);

  const ghost = `nobody-${A.slug}@test.local`;
  const unknown = await api('POST', '/bff/auth/otp/request', { body: { email: ghost, tenantSlug: A.slug } });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.message, res.json.message, 'same message for unknown accounts');
  assert.equal(inbox(ghost).length, 0);
});

test('invite → email → accept → sign in', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const email = `invitee-${A.slug}@test.local`;
  const created = await api('POST', '/users', { cookie: admin.cookie, body: { email, name: 'New Person', userType: 'TENANT_USER' } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.status, 'PENDING');
  assert.equal(created.json.invitationSent, true);

  // Can't sign in before accepting
  assert.equal((await api('POST', '/bff/auth/login', { body: { email, tenantSlug: A.slug, password: PASSWORD } })).status, 401);

  const mail = lastMail(email);
  assert.match(mail!.subject, /invited you/);
  assert.ok(mail!.text.includes('http://app.test/accept-invite?token='));
  const token = tokenFrom(mail);

  const info = await api('GET', `/bff/account/invitations/${token}`);
  assert.equal(info.status, 200);
  assert.equal(info.json.email, email);
  assert.equal(info.json.tenant.slug, A.slug);

  assert.equal((await api('POST', '/bff/account/invitations/accept', { body: { token, password: 'short' } })).status, 400, 'password policy');
  const accepted = await api('POST', '/bff/account/invitations/accept', { body: { token, password: 'a-good-password', name: 'Renamed Person' } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.equal(accepted.json.tenantSlug, A.slug);

  assert.equal((await api('POST', '/bff/account/invitations/accept', { body: { token, password: 'another-password' } })).status, 404, 'single use');
  const login = await api('POST', '/bff/auth/login', { body: { email, tenantSlug: A.slug, password: 'a-good-password' } });
  assert.equal(login.status, 200);
  assert.equal((await prisma.user.findFirstOrThrow({ where: { email } })).name, 'Renamed Person');
});

test('resending an invitation invalidates the previous link', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const email = `resend-${A.slug}@test.local`;
  const created = await api('POST', '/users', { cookie: admin.cookie, body: { email, name: 'Resend Me' } });
  const first = tokenFrom(lastMail(email));

  assert.equal((await api('POST', `/users/${created.json.id}/resend-invite`, { cookie: admin.cookie, body: {} })).status, 200);
  const second = tokenFrom(lastMail(email));
  assert.notEqual(first, second);
  assert.equal((await api('GET', `/bff/account/invitations/${first}`)).status, 404, 'old link no longer works');
  assert.equal((await api('GET', `/bff/account/invitations/${second}`)).status, 200);

  const user = await loginSession(A.slug, A.userEmail);
  assert.equal((await api('POST', `/users/${created.json.id}/resend-invite`, { cookie: user.cookie, body: {} })).status, 403, 'needs users:create');
  const active = await prisma.user.findFirstOrThrow({ where: { email: A.userEmail } });
  assert.equal((await api('POST', `/users/${active.id}/resend-invite`, { cookie: admin.cookie, body: {} })).status, 409, 'already active');
});

test('forgot password → email → reset signs out existing sessions', async () => {
  const session = await loginSession(A.slug, A.managerEmail);
  const unknown = await api('POST', '/bff/account/password/forgot', { body: { email: `ghost-${A.slug}@test.local`, tenantSlug: A.slug } });
  const known = await api('POST', '/bff/account/password/forgot', { body: { email: A.managerEmail, tenantSlug: A.slug } });
  assert.equal(known.status, 200);
  assert.equal(known.json.message, unknown.json.message, 'same answer either way');
  assert.equal(inbox(`ghost-${A.slug}@test.local`).length, 0);

  const mail = lastMail(A.managerEmail);
  assert.ok(mail!.text.includes('http://app.test/reset-password?token='));
  const token = tokenFrom(mail);
  assert.equal((await api('GET', `/bff/account/password/reset/${token}`)).status, 200);

  const reset = await api('POST', '/bff/account/password/reset', { body: { token, password: 'brand-new-pass' } });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  assert.equal((await api('POST', '/bff/account/password/reset', { body: { token, password: 'again-new-pass' } })).status, 404, 'single use');

  assert.equal((await api('POST', '/bff/auth/login', { body: { email: A.managerEmail, tenantSlug: A.slug, password: PASSWORD } })).status, 401, 'old password');
  assert.equal((await api('POST', '/bff/auth/login', { body: { email: A.managerEmail, tenantSlug: A.slug, password: 'brand-new-pass' } })).status, 200);
  assert.equal((await api('POST', '/bff/auth/refresh', { cookie: session.cookie })).status, 401, 'existing sessions revoked');
  assert.equal((await api('GET', '/auth/permissions', { token: session.token })).status, 401, 'access tokens already issued stop working too');
});

test("the tenant's password policy applies to resets", async () => {
  await prisma.authConfig.update({ where: { tenantId: A.tenantId }, data: { passwordPolicy: 'STRONG' } });
  await api('POST', '/bff/account/password/forgot', { body: { email: A.userEmail, tenantSlug: A.slug } });
  const token = tokenFrom(lastMail(A.userEmail));
  const weak = await api('POST', '/bff/account/password/reset', { body: { token, password: 'alllowercase1' } });
  assert.equal(weak.status, 400);
  assert.match(weak.json.message, /upper- and lower-case/);
  assert.equal((await api('POST', '/bff/account/password/reset', { body: { token, password: 'Mixed-Case-123' } })).status, 200);
  await prisma.authConfig.update({ where: { tenantId: A.tenantId }, data: { passwordPolicy: 'STANDARD' } });
});

test('expired links are refused', async () => {
  await api('POST', '/bff/account/password/forgot', { body: { email: A.adminEmail, tenantSlug: A.slug } });
  const token = tokenFrom(lastMail(A.adminEmail));
  const admin = await prisma.user.findFirstOrThrow({ where: { email: A.adminEmail } });
  await prisma.userToken.updateMany({ where: { userId: admin.id, type: 'PASSWORD_RESET', usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await api('POST', '/bff/account/password/reset', { body: { token, password: 'whatever-pass' } })).status, 404);
});

test('tokens are stored hashed, never in plain text', async () => {
  const rows = await prisma.userToken.findMany({ take: 50, orderBy: { createdAt: 'desc' } });
  const mails = readFileSync(outbox, 'utf8');
  for (const r of rows) assert.ok(!mails.includes(r.tokenHash), 'stored value is not the emailed token');
});

test('platform users can reset their password with the platform slug', async () => {
  await api('POST', '/bff/account/password/forgot', { body: { email: platformAdmin, tenantSlug: 'platform' } });
  const token = tokenFrom(lastMail(platformAdmin));
  const info = await api('GET', `/bff/account/password/reset/${token}`);
  assert.equal(info.json.tenantSlug, 'platform');
  assert.equal(info.json.passwordPolicy, 'STRONG');
});
