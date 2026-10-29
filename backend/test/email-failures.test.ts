/**
 * When email can't be sent: tenants still finish setting up, invitations
 * still exist (their link is handed to whoever invited), and administrators
 * can send themselves a test email to see what's wrong.
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

const { api, db, loginSession, seedPlatformUsers, seedTenant, startExtraServer, startServer, stopServerAndCleanUp, trackTenant, waitForProvisioning } = await import('./helpers.js');
type TenantSeed = Awaited<ReturnType<typeof seedTenant>>;

let A: TenantSeed;
let platformAdmin: string;
let broken: Awaited<ReturnType<typeof startExtraServer>>;
const stamp = Math.random().toString(36).slice(2, 8);
const inbox = (to: string) =>
  !existsSync(outbox) ? [] : readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.to === to);

before(async () => {
  A = await seedTenant('mailfail');
  platformAdmin = (await seedPlatformUsers()).adminEmail;
  await startServer();
  // A second server whose mail server doesn't exist (a placeholder left in .env)
  broken = await startExtraServer({ EMAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://user:secret-pw@smtp.example.invalid:587' });
});
after(async () => {
  await broken?.stop();
  await stopServerAndCleanUp();
});

test("a tenant is set up even when its first administrator's invitation can't be emailed", async () => {
  const { controlDb } = await db();
  const cookie = (await loginSession('platform', platformAdmin)).cookie;
  const slug = `mailfail-${stamp}`;
  const adminEmail = `first-${stamp}@test.local`;
  const created = await broken.api('POST', '/tenants', { cookie, body: { name: 'Mail Fail Co', slug, adminName: 'First', adminEmail } });
  assert.equal(created.status, 202, JSON.stringify(created.json));
  trackTenant(created.json.id);
  assert.equal(await waitForProvisioning(created.json.id), 'READY', 'not FAILED because of email');

  const t = await controlDb.tenant.findUniqueOrThrow({ where: { id: created.json.id } });
  assert.match(t.adminInviteError ?? '', /could not be found.*SMTP_URL/);
  assert.equal(t.provisioningError, null);
  const shown = await broken.api('GET', `/tenants/${t.id}`, { cookie });
  assert.match(shown.json.adminInviteError, /smtp\.example\.invalid/);
  assert.ok(!JSON.stringify(shown.json).includes('secret-pw'), 'never the SMTP password');

  // Resent while email still fails: the link, to share another way
  const again = await broken.api('POST', `/tenants/${t.id}/resend-invite`, { cookie });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal(again.json.invitationSent, false);
  assert.match(again.json.inviteLink, /^http:\/\/app\.test\/accept-invite\?token=/);
  const token = decodeURIComponent(again.json.inviteLink.split('token=')[1]);
  const lookup = await api('GET', `/bff/account/invitations/${encodeURIComponent(token)}`);
  assert.equal(lookup.status, 200, 'the link works');
  assert.equal(lookup.json.email, adminEmail);

  // Once email works: sent, and the error is gone
  const fixed = await api('POST', `/tenants/${t.id}/resend-invite`, { cookie });
  assert.deepEqual(fixed.json, { invitationSent: true, to: adminEmail });
  assert.equal((await controlDb.tenant.findUniqueOrThrow({ where: { id: t.id } })).adminInviteError, null);
  assert.equal(inbox(adminEmail).length, 1);
  assert.equal((await api('GET', `/bff/account/invitations/${encodeURIComponent(token)}`)).status, 404, 'the older link stops working');

  // Accepted: nothing left to resend
  const accepted = inbox(adminEmail)[0].text.match(/token=([^\s]+)/)[1];
  assert.equal((await api('POST', '/bff/account/invitations/accept', { body: { token: decodeURIComponent(accepted), password: 'First-Admin-Passw0rd' } })).status, 200);
  assert.equal((await api('POST', `/tenants/${t.id}/resend-invite`, { cookie })).status, 409);
});

test("inviting a user when email fails hands the inviter the link", async () => {
  const cookie = (await loginSession(A.slug, A.adminEmail)).cookie;
  const email = `invitee-${stamp}@test.local`;
  const res = await broken.api('POST', '/users', { cookie, body: { email, name: 'Invitee', userType: 'TENANT_USER' } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.invitationSent, false);
  assert.match(res.json.inviteLink, /accept-invite\?token=/);
  assert.match(res.json.emailError, /could not be found/);

  const resent = await api('POST', `/users/${res.json.id}/resend-invite`, { cookie });
  assert.deepEqual(resent.json, { invitationSent: true });
  assert.equal(inbox(email).length, 1);
});

test('administrators send themselves a test email', async () => {
  const tenantAdmin = (await loginSession(A.slug, A.adminEmail)).cookie;
  const ok = await api('POST', '/notification-settings/test-email', { cookie: tenantAdmin });
  assert.deepEqual(ok.json, { sent: true, to: A.adminEmail });
  assert.equal(inbox(A.adminEmail).at(-1).subject, 'Test email');
  const failing = await broken.api('POST', '/notification-settings/test-email', { cookie: tenantAdmin });
  assert.equal(failing.json.sent, false);
  assert.match(failing.json.error, /smtp\.example\.invalid could not be found/);
  const user = (await loginSession(A.slug, A.userEmail)).cookie;
  assert.equal((await api('POST', '/notification-settings/test-email', { cookie: user })).status, 403);

  const platform = (await loginSession('platform', platformAdmin)).cookie;
  const setup = await broken.api('GET', '/platform/email', { cookie: platform });
  assert.deepEqual(setup.json.smtp, { host: 'smtp.example.invalid', port: 587, secure: false, user: 'user' });
  assert.ok(!JSON.stringify(setup.json).includes('secret-pw'));
  assert.equal((await api('POST', '/platform/email/test', { cookie: platform })).json.sent, true);
  assert.equal(inbox(platformAdmin).at(-1).subject, 'Test email');
  assert.equal((await broken.api('POST', '/platform/email/test', { cookie: platform })).json.sent, false);
  assert.equal((await api('POST', '/platform/email/test', { cookie: tenantAdmin })).status, 403);
});
