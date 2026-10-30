/**
 * Changing your own password and email address (routes/my-account.ts), and an
 * administrator correcting someone's address: the new address confirms the
 * change, the old one is told, and sessions end.
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

const { PASSWORD, api, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp } = await import('./helpers.js');
type TenantSeed = Awaited<ReturnType<typeof seedTenant>>;

let A: TenantSeed;
let platformSupport: string;
const stamp = Math.random().toString(36).slice(2, 8);
const NEW_PASSWORD = 'Brand-New-Passw0rd';

interface Mail { to: string; subject: string; text: string }
const inbox = (to: string): Mail[] =>
  !existsSync(outbox) ? [] : readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Mail).filter((m) => m.to === to);
const linkToken = (m: Mail | undefined) => decodeURIComponent(m!.text.match(/token=([^\s]+)/)![1]);
const signIn = (slug: string, email: string, password = PASSWORD) => api('POST', '/bff/auth/login', { body: { tenantSlug: slug, email, password } });
const refreshWith = (cookie: string) => api('POST', '/bff/auth/refresh', { cookie });

before(async () => {
  A = await seedTenant('chg');
  platformSupport = (await seedPlatformUsers()).supportEmail;
  await startServer();
});
after(stopServerAndCleanUp);

test('changing your password: needs the current one and the policy; other sessions end, this one goes on', async () => {
  const here = await loginSession(A.slug, A.managerEmail);
  const elsewhere = await loginSession(A.slug, A.managerEmail);
  const me = await api('GET', '/bff/my-account', { cookie: here.cookie });
  assert.equal(me.json.email, A.managerEmail);
  assert.equal(me.json.hasPassword, true);

  assert.equal((await api('POST', '/bff/my-account/password', { cookie: here.cookie, body: { currentPassword: 'wrong-one', newPassword: NEW_PASSWORD } })).json.code, 'WRONG_PASSWORD');
  assert.equal((await api('POST', '/bff/my-account/password', { cookie: here.cookie, body: { currentPassword: PASSWORD, newPassword: 'short' } })).status, 400);
  const ok = await api('POST', '/bff/my-account/password', { cookie: here.cookie, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));

  assert.equal((await refreshWith(elsewhere.cookie)).status, 401, 'the other session ended');
  assert.equal((await refreshWith(here.cookie)).status, 200, 'this one carries on');
  assert.equal((await signIn(A.slug, A.managerEmail)).status, 401, 'old password');
  assert.equal((await signIn(A.slug, A.managerEmail, NEW_PASSWORD)).status, 200);
  assert.match(inbox(A.managerEmail).at(-1)!.subject, /password was changed/);
  // Back, for the tests that sign in as the manager
  assert.equal((await api('POST', '/bff/my-account/password', { cookie: here.cookie, body: { currentPassword: NEW_PASSWORD, newPassword: PASSWORD } })).status, 200);
});

test('changing your email: confirmed from the new address, announced to the old, then everyone signs in again', async () => {
  const oldEmail = A.userEmail;
  const newEmail = `moved-${stamp}@test.local`;
  const session = await loginSession(A.slug, oldEmail);
  assert.equal((await api('POST', '/bff/my-account/email', { cookie: session.cookie, body: { newEmail } })).json.code, 'WRONG_PASSWORD', 'needs the password');
  assert.equal((await api('POST', '/bff/my-account/email', { cookie: session.cookie, body: { newEmail: A.adminEmail, password: PASSWORD } })).json.code, 'EMAIL_TAKEN');

  const asked = await api('POST', '/bff/my-account/email', { cookie: session.cookie, body: { newEmail: newEmail.toUpperCase(), password: PASSWORD } });
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  assert.equal(asked.json.pendingEmail.newEmail, newEmail);
  assert.equal((await api('GET', '/bff/my-account', { cookie: session.cookie })).json.pendingEmail.newEmail, newEmail);
  assert.match(inbox(oldEmail).at(-1)!.subject, /about to change/);
  const confirm = inbox(newEmail).at(-1);
  assert.ok(confirm!.text.includes('http://app.test/confirm-email?token='), confirm!.text);
  const token = linkToken(confirm);

  // Not changed until confirmed
  assert.equal((await signIn(A.slug, oldEmail)).status, 200);
  const info = await api('GET', `/bff/account/email/confirm/${encodeURIComponent(token)}`);
  assert.deepEqual(info.json, { email: oldEmail, newEmail, organization: 'Test chg' });

  const done = await api('POST', '/bff/account/email/confirm', { body: { token } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual({ slug: done.json.tenantSlug, email: done.json.email }, { slug: A.slug, email: newEmail });
  assert.equal((await api('GET', '/users', { cookie: session.cookie })).status, 401, 'signed out everywhere');
  assert.equal((await signIn(A.slug, oldEmail)).status, 401);
  assert.equal((await signIn(A.slug, newEmail)).status, 200);
  assert.match(inbox(oldEmail).at(-1)!.subject, /email was changed/);
  assert.equal((await api('POST', '/bff/account/email/confirm', { body: { token } })).status, 404, 'once only');

  const entry = (await api('GET', '/audit?event=account.email_changed', { cookie: (await loginSession(A.slug, A.adminEmail)).cookie })).json.data[0];
  assert.ok(entry, 'in the audit log');
  A.userEmail = newEmail;
});

test('a pending change can be cancelled; its link stops working', async () => {
  const session = await loginSession(A.slug, A.userEmail);
  const target = `cancelled-${stamp}@test.local`;
  await api('POST', '/bff/my-account/email', { cookie: session.cookie, body: { newEmail: target, password: PASSWORD } });
  const token = linkToken(inbox(target).at(-1));
  assert.deepEqual((await api('DELETE', '/bff/my-account/email', { cookie: session.cookie })).json, { pendingEmail: null });
  assert.equal((await api('POST', '/bff/account/email/confirm', { body: { token } })).status, 404);
});

test('an administrator corrects an address: confirmed by the new address; an invitee is simply re-invited', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const manager = await loginSession(A.slug, A.managerEmail);
  const users = (await api('GET', '/users?limit=50', { cookie: admin.cookie })).json.data as { id: string; email: string }[];
  const target = users.find((u) => u.email === A.userEmail)!;
  const adminRow = users.find((u) => u.email === A.adminEmail)!;

  assert.equal((await api('POST', `/users/${adminRow.id}/email`, { cookie: admin.cookie, body: { email: `x-${stamp}@test.local` } })).status, 400, 'not your own here');
  const corrected = `corrected-${stamp}@test.local`;
  const res = await api('POST', `/users/${target.id}/email`, { cookie: admin.cookie, body: { email: corrected } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(res.json, { email: A.userEmail, pendingEmail: { newEmail: corrected } });
  assert.match(inbox(A.userEmail).at(-1)!.subject, /about to change/);
  assert.equal((await api('POST', '/bff/account/email/confirm', { body: { token: linkToken(inbox(corrected).at(-1)) } })).status, 200);
  assert.equal((await signIn(A.slug, corrected)).status, 200);

  // An invitation not yet accepted moves to the right address
  const invited = await api('POST', '/users', { cookie: admin.cookie, body: { email: `typo-${stamp}@test.local`, name: 'Typo', userType: 'TENANT_USER' } });
  const oldLink = linkToken(inbox(`typo-${stamp}@test.local`).at(-1));
  const fixed = await api('POST', `/users/${invited.json.id}/email`, { cookie: admin.cookie, body: { email: `right-${stamp}@test.local` } });
  assert.equal(fixed.json.email, `right-${stamp}@test.local`);
  assert.equal(fixed.json.invitationSent, true);
  assert.match(inbox(`right-${stamp}@test.local`).at(-1)!.text, /accept-invite\?token=/);
  assert.equal((await api('GET', `/bff/account/invitations/${encodeURIComponent(oldLink)}`)).status, 404, 'the old invitation stops working');

  // A manager can't change an administrator's address
  assert.equal((await api('POST', `/users/${adminRow.id}/email`, { cookie: manager.cookie, body: { email: `y-${stamp}@test.local` } })).status, 403);
});

test('platform staff change their own email the same way', async () => {
  const session = await loginSession('platform', platformSupport);
  const newEmail = `support-moved-${stamp}@test.local`;
  const asked = await api('POST', '/bff/my-account/email', { cookie: session.cookie, body: { newEmail, password: PASSWORD } });
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  const done = await api('POST', '/bff/account/email/confirm', { body: { token: linkToken(inbox(newEmail).at(-1)) } });
  assert.equal(done.json.tenantSlug, 'platform');
  assert.equal((await signIn('platform', newEmail)).status, 200);
  // Back, so cleanup finds the account
  const again = await loginSession('platform', newEmail);
  await api('POST', '/bff/my-account/email', { cookie: again.cookie, body: { newEmail: platformSupport, password: PASSWORD } });
  assert.equal((await api('POST', '/bff/account/email/confirm', { body: { token: linkToken(inbox(platformSupport).at(-1)) } })).status, 200);
});
