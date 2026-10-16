/**
 * Notifications: who gets what, on which channel, the organization's rules,
 * people's preferences, mandatory security notices, the inbox, delivery and
 * retries. Emails go to a file (EMAIL_TRANSPORT=file) read like an inbox.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const outbox = join(tmpdir(), `notifications-${randomUUID()}.jsonl`);
process.env.EMAIL_TRANSPORT = 'file';
process.env.MAIL_OUTBOX_FILE = outbox;

const { api, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp } = await import('./helpers.js');
const { decide, notify, processChain } = await import('../src/lib/notifications.js');
const { KIT_NOTIFICATION_TYPES } = await import('../src/kit/notification-types.js');

type Seed = Awaited<ReturnType<typeof seedTenant>>;
let A: Seed;
let B: Seed;
let P: Awaited<ReturnType<typeof seedPlatformUsers>>;
let controlDb: Awaited<ReturnType<typeof db>>['controlDb'];

before(async () => {
  ({ controlDb } = await db());
  P = await seedPlatformUsers();
  A = await seedTenant('notify-a');
  B = await seedTenant('notify-b');
  await startServer();
});
after(stopServerAndCleanUp);

const mails = (to: string) =>
  existsSync(outbox)
    ? readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { to: string; subject: string; text: string }).filter((m) => m.to === to)
    : [];

/** Wait until `fn` returns something truthy (notifications are processed just after the request). */
async function eventually<T>(fn: () => Promise<T> | T, what: string, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v && (!Array.isArray(v) || v.length)) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const settle = () => sleep(600);

async function inbox(cookie: string, query = '') {
  return (await api('GET', `/notifications${query}`, { cookie })).json as { data: { id: string; type: string; title: string; readAt: string | null }[]; unread: number };
}
const userId = async (t: Seed, email: string) => (await t.db.user.findFirstOrThrow({ where: { tenantId: t.tenantId, email } })).id;
async function someRole(cookie: string) {
  const { roles } = (await api('GET', '/roles', { cookie })).json as { roles: { id: string; name: string; isSystem: boolean }[] };
  return roles.find((r) => /viewer|user/i.test(r.name)) ?? roles[0];
}

// ------------------------------------------------------------ rules

test('channel rules: organization first, then the person, mandatory ignores the person', () => {
  const t = KIT_NOTIFICATION_TYPES['role.assigned'];
  const m = KIT_NOTIFICATION_TYPES['auth.password_reset'];
  assert.deepEqual(decide(t, null, null), { inApp: true, email: true });
  assert.deepEqual(decide(t, null, { inApp: true, email: false }), { inApp: true, email: false });
  assert.deepEqual(decide(t, { enabled: false, inApp: true, email: true, mandatory: false }, null), { inApp: false, email: false });
  assert.deepEqual(decide(t, { enabled: true, inApp: true, email: false, mandatory: false }, { inApp: true, email: true }), { inApp: true, email: false });
  assert.deepEqual(decide(t, { enabled: true, inApp: true, email: true, mandatory: true }, { inApp: false, email: false }), { inApp: true, email: true });
  assert.deepEqual(decide(m, null, { inApp: false, email: false }), { inApp: true, email: true });
  // A built-in security notice can't be switched off by the organization
  assert.deepEqual(decide(m, { enabled: false, inApp: true, email: true, mandatory: false }, null), { inApp: true, email: true });
});

// ------------------------------------------------------------ delivery

test('a role given to someone reaches them in-app and by email, not the admin who gave it', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const user = await loginSession(A.slug, A.userEmail);
  const role = await someRole(admin.cookie);
  const res = await api('POST', '/roles/assign', { cookie: admin.cookie, body: { roleId: role.id, principalType: 'USER', userId: await userId(A, A.userEmail), scopeType: 'TENANT' } });
  assert.equal(res.status, 201, JSON.stringify(res.json));

  const box = await eventually(async () => (await inbox(user.cookie)).data.filter((n) => n.type === 'role.assigned'), 'the in-app notification');
  assert.equal(box[0].title, `You were given the ${role.name} role`);
  const mail = await eventually(() => mails(A.userEmail).filter((m) => m.subject.includes(`${role.name} role`)), 'the email');
  assert.match(mail[0].subject, /^\[Test notify-a\]/);
  assert.match(mail[0].text, /notifications\?tab=preferences/);
  assert.equal((await inbox(admin.cookie)).data.filter((n) => n.type === 'role.assigned').length, 0, 'not the actor');
});

test('a role given to a group reaches its members', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const manager = await loginSession(A.slug, A.managerEmail);
  const group = (await api('POST', '/groups', { cookie: admin.cookie, body: { name: `Notified ${Date.now()}` } })).json;
  await api('POST', `/groups/${group.id}/members`, { cookie: admin.cookie, body: { userId: await userId(A, A.managerEmail) } });
  const added = await eventually(async () => (await inbox(manager.cookie)).data.filter((n) => n.type === 'group.member_added'), 'added-to-group');
  assert.match(added[0].title, /You were added to Notified/);

  const role = await someRole(admin.cookie);
  await api('POST', '/roles/assign', { cookie: admin.cookie, body: { roleId: role.id, principalType: 'GROUP', groupId: group.id, scopeType: 'TENANT' } });
  await eventually(async () => (await inbox(manager.cookie)).data.filter((n) => n.type === 'role.assigned'), 'the group role notification');
});

test('preferences turn a channel off; mandatory security notices still arrive', async () => {
  const user = await loginSession(A.slug, A.userEmail);
  const prefs = (await api('GET', '/notifications/preferences', { cookie: user.cookie })).json as { type: string; mandatory: boolean; current: { email: boolean } }[];
  assert.ok(prefs.find((p) => p.type === 'auth.password_reset')?.mandatory);
  assert.ok(!prefs.some((p) => p.type.startsWith('platform.')), 'only tenant types');

  const saved = await api('PUT', '/notifications/preferences', {
    cookie: user.cookie,
    body: { preferences: { 'role.unassigned': { inApp: true, email: false }, 'user.mfa_reset': { inApp: false, email: false } } },
  });
  assert.equal(saved.status, 200);
  assert.equal((await api('PUT', '/notifications/preferences', { cookie: user.cookie, body: { preferences: { 'nope.x': { inApp: true, email: true } } } })).status, 400);

  // Mandatory: still both channels
  const admin = await loginSession(A.slug, A.adminEmail);
  const before = mails(A.userEmail).length;
  await api('POST', `/users/${await userId(A, A.userEmail)}/mfa/reset`, { cookie: admin.cookie });
  await eventually(async () => (await inbox(user.cookie)).data.filter((n) => n.type === 'user.mfa_reset'), 'mandatory in-app');
  await eventually(() => mails(A.userEmail).slice(before).filter((m) => /two-factor sign-in was reset/.test(m.subject)), 'mandatory email');
  assert.match(mails(A.userEmail).at(-1)!.text, /security notice/);

  // Not mandatory: email off as chosen
  const role = await someRole(admin.cookie);
  const assignments = (await api('GET', '/roles/assignments', { cookie: admin.cookie })).json as { assignments: { id: string; userId: string | null; roleId: string }[] };
  const uid = await userId(A, A.userEmail);
  const mine = assignments.assignments.find((a) => a.userId === uid && a.roleId === role.id);
  assert.ok(mine);
  const count = mails(A.userEmail).length;
  await api('DELETE', `/roles/assignments/${mine.id}`, { cookie: admin.cookie });
  await eventually(async () => (await inbox(user.cookie)).data.filter((n) => n.type === 'role.unassigned'), 'in-app removal');
  await settle();
  assert.equal(mails(A.userEmail).length, count, 'no email');
});

test('the organization decides which notifications go out, and how', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const user = await loginSession(A.slug, A.userEmail);
  assert.equal((await api('GET', '/notification-settings', { cookie: user.cookie })).status, 403);

  const current = (await api('GET', '/notification-settings', { cookie: admin.cookie })).json;
  assert.ok(current.types.find((t: { type: string; required: boolean }) => t.type === 'auth.mfa_failed').required);
  const off = await api('PUT', '/notification-settings', { cookie: admin.cookie, body: { settings: { 'auth.mfa_failed': { enabled: false, inApp: true, email: true, mandatory: false } } } });
  assert.equal(off.status, 400, 'security notices stay on');

  const ok = await api('PUT', '/notification-settings', { cookie: admin.cookie, body: { settings: { 'group.member_added': { enabled: false, inApp: true, email: true, mandatory: false } } } });
  assert.equal(ok.status, 200);
  const logged = (await api('GET', '/audit?event=notification_settings.updated', { cookie: admin.cookie })).json.data[0];
  assert.deepEqual(logged.changes.enabled, [true, false]);

  const group = (await api('POST', '/groups', { cookie: admin.cookie, body: { name: `Quiet ${Date.now()}` } })).json;
  const before = (await inbox(user.cookie)).data.length;
  await api('POST', `/groups/${group.id}/members`, { cookie: admin.cookie, body: { userId: await userId(A, A.userEmail) } });
  await settle();
  assert.equal((await inbox(user.cookie)).data.length, before, 'turned off');
  // Not offered in the person's preferences either
  const prefs = (await api('GET', '/notifications/preferences', { cookie: user.cookie })).json as { type: string }[];
  assert.ok(!prefs.some((p) => p.type === 'group.member_added'));
  await api('PUT', '/notification-settings', { cookie: admin.cookie, body: { settings: { 'group.member_added': { enabled: true, inApp: true, email: true, mandatory: false } } } });
});

test('notifications for “everyone who can approve” go to holders of that permission', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const user = await loginSession(A.slug, A.userEmail);
  const role = await someRole(admin.cookie);
  const res = await api('POST', '/access-requests', { cookie: user.cookie, body: { roleId: role.id, scopeType: 'TENANT', scopeId: A.tenantId, reason: 'I need this for the audit', duration: 4 } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const got = await eventually(async () => (await inbox(admin.cookie)).data.filter((n) => n.type === 'access_request.created'), 'the approver notification');
  assert.match(got[0].title, new RegExp(`${A.userEmail.replace('.', '\\.')} asked for`));
  assert.equal((await inbox(user.cookie)).data.filter((n) => n.type === 'access_request.created').length, 0, 'not the requester');
});

// ------------------------------------------------------------ inbox

test('the inbox: unread count, mark read, mark all read; only your own', async () => {
  const user = await loginSession(A.slug, A.userEmail);
  const other = await loginSession(A.slug, A.managerEmail);
  const box = await inbox(user.cookie, '?unread=true');
  assert.ok(box.unread > 0);
  assert.equal((await api('GET', '/notifications/unread-count', { cookie: user.cookie })).json.count, box.unread);

  // Someone else's ids do nothing
  assert.equal((await api('POST', '/notifications/read', { cookie: other.cookie, body: { ids: [box.data[0].id] } })).json.updated, 0);
  assert.equal((await api('POST', '/notifications/read', { cookie: user.cookie, body: { ids: [box.data[0].id] } })).json.updated, 1);
  assert.equal((await inbox(user.cookie)).unread, box.unread - 1);
  await api('POST', '/notifications/read', { cookie: user.cookie, body: {} });
  assert.equal((await inbox(user.cookie)).unread, 0);

  const b = await loginSession(B.slug, B.adminEmail);
  assert.ok((await inbox(b.cookie)).data.every((n) => !n.title.includes('Notified')));
});

test('polling the count does not keep an idle session alive', async () => {
  const s = await loginSession(A.slug, A.userEmail);
  const sid = JSON.parse(Buffer.from(s.token.split('.')[1], 'base64url').toString()).sid;
  const old = new Date(Date.now() - 20 * 60_000);
  await A.db.refreshToken.updateMany({ where: { familyId: sid }, data: { lastSeenAt: old } });
  const res = await fetch(`${(await import('./helpers.js')).baseUrl()}/notifications/unread-count`, { headers: { cookie: s.cookie, 'x-background-request': '1' } });
  assert.equal(res.status, 200);
  const row = await A.db.refreshToken.findFirstOrThrow({ where: { familyId: sid } });
  assert.equal(row.lastSeenAt.getTime(), old.getTime());
});

// ------------------------------------------------------------ delivery machinery

test('failed work is retried later, then given up on; failed emails can be resent', async () => {
  // An event that can't be processed (no event in it): retried with backoff
  const own = A.db;
  const row = await own.notificationOutbox.create({ data: { tenantId: A.tenantId, kind: 'EVENT', payload: { type: 'role.assigned' } } });
  await processChain(A.tenantId);
  const after1 = await own.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } });
  assert.deepEqual([after1.status, after1.attempts], ['PENDING', 1]);
  assert.ok(after1.nextAttemptAt.getTime() > Date.now() + 30_000, 'next try later');
  assert.ok(after1.lastError);
  await own.notificationOutbox.delete({ where: { id: row.id } });

  // A failed email shows on the settings page and can be sent again
  const admin = await loginSession(A.slug, A.adminEmail);
  const failed = await own.notificationOutbox.create({
    data: { tenantId: A.tenantId, kind: 'EMAIL', status: 'FAILED', attempts: 6, lastError: 'SMTP down', payload: { to: 'retry@test.local', subject: 'Retried', text: 'x', html: '<p>x</p>' } },
  });
  const list = (await api('GET', '/notification-settings/failed-emails', { cookie: admin.cookie })).json;
  assert.ok(list.some((f: { id: string; lastError: string }) => f.id === failed.id && f.lastError === 'SMTP down'));
  assert.equal((await api('GET', '/notification-settings', { cookie: admin.cookie })).json.delivery.failedEmails >= 1, true);
  assert.equal((await api('POST', '/notification-settings/failed-emails/retry', { cookie: admin.cookie })).json.retried >= 1, true);
  await eventually(() => mails('retry@test.local'), 'the resent email');
  await eventually(async () => !(await own.notificationOutbox.findUnique({ where: { id: failed.id } })), 'the row gone');
});

test('notify() sends a notification that is not an audit event', async () => {
  const manager = await loginSession(A.slug, A.managerEmail);
  await notify({ tenantId: A.tenantId }, 'group.member_added', { resource: { label: 'Direct' }, details: { userId: await userId(A, A.managerEmail) } });
  await eventually(async () => (await inbox(manager.cookie)).data.filter((n) => n.title === 'You were added to Direct'), 'the direct notification');
  await assert.rejects(notify({ tenantId: A.tenantId }, 'nope.never'), /Unknown notification type/);
});

// ------------------------------------------------------------ platform

test('platform users get platform notifications in their own inbox', async () => {
  const admin = await loginSession('platform', P.adminEmail);
  const support = await loginSession('platform', P.supportEmail);
  // Seeding the tenants above provisioned them: "is ready" for people who manage tenants
  const ready = await eventually(async () => (await inbox(admin.cookie)).data.filter((n) => n.title.startsWith('Test notify-a') && n.title.endsWith('is ready')), 'tenant ready');
  assert.equal(ready[0].type, 'tenant.provisioned');
  assert.equal((await inbox(support.cookie)).data.filter((n) => n.type === 'tenant.provisioned').length, 0, 'support staff do not manage tenants');

  const prefs = (await api('GET', '/notifications/preferences', { cookie: admin.cookie })).json as { type: string }[];
  assert.ok(prefs.every((p) => !p.type.startsWith('role.')));
  assert.ok(prefs.some((p) => p.type === 'tenant.provisioning_failed'));
  // Only what can reach you: support staff don't manage tenants
  const supportPrefs = (await api('GET', '/notifications/preferences', { cookie: support.cookie })).json as { type: string }[];
  assert.ok(!supportPrefs.some((p) => p.type === 'tenant.provisioning_failed'));
  assert.ok(supportPrefs.some((p) => p.type === 'platform.auth.mfa_failed'));
  assert.equal((await api('GET', '/notification-settings', { cookie: admin.cookie })).status, 400, 'platform users have no tenant here');
  void controlDb;
});
