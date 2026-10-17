/**
 * Tenants over time (lib/tenant-lifecycle.ts): trials that end and become
 * read-only, organizations their admins close (and platform staff restore, or
 * the job deletes), sign-up protection (bot check, throwaway addresses), and
 * old sign-up requests cleaned away. The job runs here on demand.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const outbox = join(mkdtempSync(join(tmpdir(), 'mail-')), 'outbox.jsonl');
process.env.EMAIL_TRANSPORT = 'file';
process.env.MAIL_OUTBOX_FILE = outbox;
process.env.FRONTEND_URL = 'http://app.test';

const { PASSWORD, api, db, loginSession, seedPlatformUsers, seedTenant, startExtraServer, startServer, stopServerAndCleanUp } = await import('./helpers.js');
const { runTenantLifecycle } = await import('../src/lib/tenant-lifecycle.js');
type TenantSeed = Awaited<ReturnType<typeof seedTenant>>;

let controlDb: Awaited<ReturnType<typeof db>>['controlDb'];
let platformAdmin: string;
const run = Math.random().toString(36).slice(2, 8);
const DAY = 86_400_000;

interface Mail { to: string; subject: string; text: string }
const inbox = (to: string): Mail[] =>
  !existsSync(outbox) ? [] : readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Mail).filter((m) => m.to === to);

before(async () => {
  ({ controlDb } = await db());
  platformAdmin = (await seedPlatformUsers()).adminEmail;
  await startServer();
});
after(async () => {
  await controlDb.signupRequest.deleteMany({ where: { email: { endsWith: `-${run}@signup.test` } } });
  await stopServerAndCleanUp();
});

test('a trial is reminded, then ends: read-only for its people until platform staff change it', async () => {
  const T: TenantSeed = await seedTenant('trial');
  await controlDb.tenant.update({ where: { id: T.tenantId }, data: { status: 'TRIAL', trialEndsAt: new Date(Date.now() + 2 * DAY) } });
  const admin = await loginSession(T.slug, T.adminEmail);
  const me = await api('GET', '/bff/auth/me', { cookie: admin.cookie });
  assert.equal(me.json.tenant.status, 'TRIAL');
  assert.ok(me.json.tenant.trialEndsAt);

  // Two days left: one reminder, once
  let r = await runTenantLifecycle();
  assert.ok(r.reminded.includes(T.slug));
  assert.ok(!r.trialsEnded.includes(T.slug));
  await runTenantLifecycle();
  const reminders = inbox(T.adminEmail).filter((m) => /trial ends on/.test(m.subject));
  assert.equal(reminders.length, 1);
  assert.equal(inbox(T.userEmail).length, 0, 'admins only');
  // Still writable
  assert.equal((await api('POST', '/groups', { cookie: admin.cookie, body: { name: `Before ${run}` } })).status, 201);

  // Ended
  await controlDb.tenant.update({ where: { id: T.tenantId }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
  r = await runTenantLifecycle();
  assert.ok(r.trialsEnded.includes(T.slug));
  assert.equal(inbox(T.adminEmail).filter((m) => /trial has ended/.test(m.subject)).length, 1);
  const entry = await controlDb.platformAuditEvent.findFirst({ where: { event: 'tenant.trial_ended', tenantId: T.tenantId } });
  assert.equal(entry?.actorType, 'SYSTEM');

  const refused = await api('POST', '/groups', { cookie: admin.cookie, body: { name: `After ${run}` } });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, 'TRIAL_ENDED');
  assert.equal((await api('GET', '/groups', { cookie: admin.cookie })).status, 200, 'reading still works');
  // Signing in still works
  await loginSession(T.slug, T.userEmail);

  // Platform staff extend it: writable again, and it'll remind again
  const platform = await loginSession('platform', platformAdmin);
  const extended = await api('PATCH', `/tenants/${T.tenantId}`, { cookie: platform.cookie, body: { trialEndsAt: new Date(Date.now() + 10 * DAY).toISOString() } });
  assert.equal(extended.status, 200, JSON.stringify(extended.json));
  assert.equal(extended.json.trialReminderSentAt, null);
  assert.equal((await api('POST', '/groups', { cookie: admin.cookie, body: { name: `Extended ${run}` } })).status, 201);

  // Ended again, then made active: no trial rules apply
  await controlDb.tenant.update({ where: { id: T.tenantId }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
  assert.equal((await api('POST', '/groups', { cookie: admin.cookie, body: { name: `Lapsed ${run}` } })).status, 403);
  assert.equal((await api('PATCH', `/tenants/${T.tenantId}`, { cookie: platform.cookie, body: { status: 'ACTIVE' } })).status, 200);
  assert.equal((await api('POST', '/groups', { cookie: admin.cookie, body: { name: `Active ${run}` } })).status, 201);
  // A tenant admin can't extend their own trial
  assert.equal((await api('PATCH', `/tenants/${T.tenantId}`, { cookie: admin.cookie, body: { trialEndsAt: null } })).status, 403);
});

test('an admin closes the organization; platform staff restore it, or it is deleted after the grace period', async () => {
  const C: TenantSeed = await seedTenant('close');
  const admin = await loginSession(C.slug, C.adminEmail);
  const manager = await loginSession(C.slug, C.managerEmail);

  const closure = await api('GET', '/organization/closure', { cookie: admin.cookie });
  assert.deepEqual(closure.json, { canClose: true, graceDays: 30, needsPassword: true });
  // Admins only, with the address and their password
  assert.equal((await api('POST', '/organization/close', { cookie: manager.cookie, body: { confirm: C.slug, password: PASSWORD } })).status, 403);
  assert.equal((await api('POST', '/organization/close', { cookie: admin.cookie, body: { confirm: 'something-else', password: PASSWORD } })).json.code, 'CONFIRMATION_MISMATCH');
  assert.equal((await api('POST', '/organization/close', { cookie: admin.cookie, body: { confirm: C.slug, password: 'wrong-password' } })).json.code, 'WRONG_PASSWORD');

  const closed = await api('POST', '/organization/close', { cookie: admin.cookie, body: { confirm: C.slug, password: PASSWORD } });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));
  const deleteAfter = new Date(closed.json.deleteAfter);
  assert.ok(Math.abs(deleteAfter.getTime() - (Date.now() + 30 * DAY)) < 60_000);
  assert.ok(inbox(C.adminEmail).some((m) => m.subject.includes('was closed') && m.text.includes('Admin')));

  // Nobody gets in: open sessions stop, sign-in is refused
  const after = await api('GET', '/users', { cookie: manager.cookie });
  assert.equal(after.status, 403);
  assert.match(after.json.message, /closed/);
  const login = await api('POST', '/bff/auth/login', { body: { tenantSlug: C.slug, email: C.adminEmail, password: PASSWORD } });
  assert.equal(login.status, 403);
  const entry = await controlDb.platformAuditEvent.findFirst({ where: { event: 'tenant.closed', tenantId: C.tenantId } });
  assert.equal(entry?.actorEmail, C.adminEmail);

  // Not yet due: the job leaves it alone
  assert.ok(!(await runTenantLifecycle()).deleted.includes(C.slug));

  // Platform staff restore it
  const platform = await loginSession('platform', platformAdmin);
  const restored = await api('POST', `/tenants/${C.tenantId}/restore`, { cookie: platform.cookie });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(restored.json.status, 'ACTIVE');
  assert.equal(restored.json.deleteAfter, null);
  await loginSession(C.slug, C.adminEmail);
  assert.equal((await api('POST', `/tenants/${C.tenantId}/restore`, { cookie: platform.cookie })).status, 409);

  // Closed again and the grace period is over: deleted
  const again = await loginSession(C.slug, C.adminEmail);
  assert.equal((await api('POST', '/organization/close', { cookie: again.cookie, body: { confirm: C.slug, password: PASSWORD } })).status, 200);
  await controlDb.tenant.update({ where: { id: C.tenantId }, data: { deleteAfter: new Date(Date.now() - 1000) } });
  const r = await runTenantLifecycle();
  assert.ok(r.deleted.includes(C.slug), JSON.stringify(r));
  assert.equal(await controlDb.tenant.findUnique({ where: { id: C.tenantId } }), null);
});

test('platform staff in a support session cannot close an organization', async () => {
  const S: TenantSeed = await seedTenant('close2');
  const { grantSupportSession } = await import('./helpers.js');
  await grantSupportSession(platformAdmin, S.tenantId, 'READ_WRITE', ['settings:manage']);
  const platform = await loginSession('platform', platformAdmin);
  const res = await api('POST', '/organization/close', { cookie: platform.cookie, tenant: S.tenantId, body: { confirm: S.slug, password: PASSWORD } });
  assert.equal(res.status, 403);
  assert.equal((await controlDb.tenant.findUniqueOrThrow({ where: { id: S.tenantId } })).closedAt, null);
});

test('old sign-up requests are cleaned away; ones still needed are kept', async () => {
  const base = { name: 'X', organization: 'X', slug: `x-${run}`, passwordHash: 'h', ip: null };
  const row = (email: string, extra: object) => controlDb.signupRequest.create({ data: { ...base, email, tokenHash: createHash('sha256').update(email).digest('hex'), expiresAt: new Date(Date.now() + DAY), ...extra } });
  const expired = await row(`expired-${run}@signup.test`, { expiresAt: new Date(Date.now() - 1000) });
  const pending = await row(`pending-${run}@signup.test`, {});
  const used = await row(`used-${run}@signup.test`, { verifiedAt: new Date(Date.now() - 3 * DAY), passwordHash: null });
  const unused = await row(`unused-${run}@signup.test`, { verifiedAt: new Date(Date.now() - 3 * DAY) });
  await runTenantLifecycle();
  const left = new Set((await controlDb.signupRequest.findMany({ where: { id: { in: [expired.id, pending.id, used.id, unused.id] } } })).map((r) => r.id));
  assert.deepEqual([left.has(expired.id), left.has(pending.id), left.has(used.id), left.has(unused.id)], [false, true, false, true]);
});

test('sign-up refuses throwaway addresses and, when configured, requires the bot check', async () => {
  const body = (email: string, extra: object = {}) => ({ organization: 'Bot Co', slug: `bot-${run}`, name: 'Bot', email, password: 'Sign-up-Passw0rd', ...extra });
  const resetLimit = () => controlDb.rateLimitHit.deleteMany({ where: { key: { in: ['127.0.0.1', '::ffff:127.0.0.1'].map((ip) => createHash('sha256').update(`signup:${ip}`).digest('base64url')) } } });
  await resetLimit();
  const site = await api('GET', '/bff/site');
  assert.equal(site.json.signup.captchaSiteKey, null);
  assert.equal(site.json.signup.trialDays, 14);
  for (const email of [`a-${run}@mailinator.com`, `a-${run}@eu.yopmail.com`]) {
    const res = await api('POST', '/bff/signup', { body: body(email) });
    assert.equal(res.status, 400, email);
    assert.equal(res.json.code, 'EMAIL_NOT_ALLOWED');
  }

  // A stand-in for Cloudflare's verification endpoint
  const seen: string[] = [];
  const turnstile: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const form = new URLSearchParams(raw);
      seen.push(`${form.get('secret')}:${form.get('response')}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: form.get('secret') === 'test-secret' && form.get('response') === 'good-token' }));
    });
  });
  await new Promise<void>((resolve) => turnstile.listen(0, '127.0.0.1', resolve));
  const guarded = await startExtraServer({
    TURNSTILE_SITE_KEY: 'test-site-key',
    TURNSTILE_SECRET_KEY: 'test-secret',
    TURNSTILE_VERIFY_URL: `http://127.0.0.1:${(turnstile.address() as AddressInfo).port}/siteverify`,
    SIGNUP_BLOCKED_EMAIL_DOMAINS: 'blocked.example',
  });
  try {
    assert.equal((await guarded.api('GET', '/bff/site')).json.signup.captchaSiteKey, 'test-site-key');
    assert.equal((await guarded.api('POST', '/bff/signup', { body: body(`b-${run}@blocked.example`, { captchaToken: 'good-token' }) })).json.code, 'EMAIL_NOT_ALLOWED');
    assert.equal((await guarded.api('POST', '/bff/signup', { body: body(`b-${run}@signup.test`) })).json.code, 'CAPTCHA_FAILED');
    assert.equal((await guarded.api('POST', '/bff/signup', { body: body(`b-${run}@signup.test`, { captchaToken: 'bad-token' }) })).json.code, 'CAPTCHA_FAILED');
    const ok = await guarded.api('POST', '/bff/signup', { body: body(`b-${run}@signup.test`, { captchaToken: 'good-token' }) });
    assert.equal(ok.status, 202, JSON.stringify(ok.json));
    assert.deepEqual(seen, ['test-secret:bad-token', 'test-secret:good-token'], 'no token: Cloudflare is not asked');
  } finally {
    await guarded.stop();
    turnstile.close();
    await resetLimit();
  }
});
