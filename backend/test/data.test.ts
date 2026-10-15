/**
 * Real-data endpoints behind the dashboards and settings pages: correct
 * scoping, shapes the frontend relies on, and secrets that must never leave
 * the server.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp,
  type PlatformSeed, type TenantSeed,
} from './helpers.js';

let A: TenantSeed;
let B: TenantSeed;
let P: PlatformSeed;
let prisma: Awaited<ReturnType<typeof db>>['prisma'];
let appB: string;

before(async () => {
  ({ prisma } = await db());
  A = await seedTenant('data-a');
  B = await seedTenant('data-b');
  P = await seedPlatformUsers();
  for (const [t, prefix] of [[A, 'Alpha'], [B, 'Beta']] as const) {
    await prisma.application.createMany({
      data: [
        { tenantId: t.tenantId, name: `${prefix} Web`, status: 'RUNNING', version: '1.0.0', environment: 'PRODUCTION', url: 'https://x.test', cpu: 40, memory: 50, requests: 100 },
        { tenantId: t.tenantId, name: `${prefix} Worker`, status: 'ERROR', version: '1.0.1', environment: 'STAGING', url: 'https://y.test', cpu: 90, memory: 95, requests: 5 },
      ],
    });
    await prisma.databaseConfig.create({
      data: { tenantId: t.tenantId, strategy: 'DATABASE_PER_TENANT', provider: 'POSTGRESQL', region: 'eu', storageLimit: '10 GB', connectionString: 'postgresql://secret-user:secret-pass@db/x' },
    });
    await prisma.activity.create({ data: { tenantId: t.tenantId, action: 'deployed', target: `${prefix} Web`, type: 'DEPLOY' } });
  }
  appB = (await prisma.application.findFirstOrThrow({ where: { tenantId: B.tenantId } })).id;
  await startServer();
});

after(stopServerAndCleanUp);

test('platform stats are platform-only and shaped for the dashboard', async () => {
  const platform = await loginSession('platform', P.adminEmail);
  const res = await api('GET', '/platform/stats', { cookie: platform.cookie });
  assert.equal(res.status, 200);
  assert.ok(res.json.tenants.total >= 2);
  assert.equal(res.json.activityByDay.length, 14);
  assert.ok(Array.isArray(res.json.topTenants) && Array.isArray(res.json.recentActivity));

  const tenantAdmin = await loginSession(A.slug, A.adminEmail);
  assert.equal((await api('GET', '/platform/stats', { cookie: tenantAdmin.cookie })).status, 403);
  assert.equal((await api('GET', '/platform/users', { cookie: tenantAdmin.cookie })).status, 403);
});

test('platform users list contains only tenant-less users and no password hashes', async () => {
  const { cookie } = await loginSession('platform', P.supportEmail);
  const res = await api('GET', '/platform/users', { cookie });
  assert.equal(res.status, 200);
  const emails = res.json.users.map((u: { email: string }) => u.email);
  assert.ok(emails.includes(P.adminEmail) && emails.includes(P.supportEmail));
  assert.ok(!emails.includes(A.adminEmail));
  assert.ok(!JSON.stringify(res.json).includes('passwordHash'));
});

test('tenant list includes status counts and last activity', async () => {
  const { cookie } = await loginSession('platform', P.adminEmail);
  const res = await api('GET', `/tenants?search=${A.slug}`, { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.length, 1);
  assert.equal(res.json.statusCounts.ACTIVE, 1);
  assert.ok(res.json.data[0].lastActiveAt, 'lastActiveAt from activity');
});

test('deployed apps are scoped to the tenant, filterable and counted', async () => {
  const { cookie } = await loginSession(A.slug, A.userEmail);
  const all = await api('GET', '/deployments', { cookie });
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.deployments.map((d: { name: string }) => d.name).sort(), ['Alpha Web', 'Alpha Worker']);
  assert.deepEqual(all.json.counts.byStatus, { RUNNING: 1, ERROR: 1 });

  const errors = await api('GET', '/deployments?status=ERROR', { cookie });
  assert.deepEqual(errors.json.deployments.map((d: { name: string }) => d.name), ['Alpha Worker']);
  assert.equal(errors.json.counts.byStatus.RUNNING, 1, 'status counts ignore the status filter');

  assert.equal((await api('GET', `/deployments/${appB}`, { cookie })).status, 404, "another tenant's app");
});

test('tenant dashboard aggregates only this tenant', async () => {
  const { cookie } = await loginSession(A.slug, A.userEmail);
  const res = await api('GET', '/bff/dashboard', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.applications.total, 2);
  assert.equal(res.json.applications.byStatus.ERROR, 1);
  assert.equal(res.json.users.total, 3);
  assert.equal(res.json.activityByDay.length, 14);
  assert.ok(res.json.activityByDay.at(-1).count >= 1, "today's activity counted");
  assert.equal(res.json.activityByType.DEPLOY, 1);
});

test('activity search filters by action and target', async () => {
  const { cookie } = await loginSession(A.slug, A.adminEmail);
  const res = await api('GET', '/activities?search=alpha%20web', { cookie });
  assert.equal(res.status, 200);
  assert.ok(res.json.data.length >= 1);
  assert.ok(res.json.data.every((a: { target: string }) => a.target === 'Alpha Web'));
});

test('tenant admins can edit their branding; others cannot; bad input is rejected', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const ok = await api('PATCH', `/tenants/${A.tenantId}`, {
    cookie: admin.cookie,
    body: { primaryColor: '#123abc', loginTitle: 'Hello', logoUrl: 'https://cdn.test/logo.png', loginSubtitle: '' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.primaryColor, '#123abc');
  assert.equal(ok.json.loginSubtitle, null, 'empty string clears the field');

  assert.equal((await api('PATCH', `/tenants/${A.tenantId}`, { cookie: admin.cookie, body: { primaryColor: 'blue' } })).status, 400);
  assert.equal((await api('PATCH', `/tenants/${B.tenantId}`, { cookie: admin.cookie, body: { loginTitle: 'x' } })).status, 403);

  const user = await loginSession(A.slug, A.userEmail);
  assert.equal((await api('PATCH', `/tenants/${A.tenantId}`, { cookie: user.cookie, body: { loginTitle: 'x' } })).status, 403);
});

test('database connection strings are never returned, and saving works without resending one', async () => {
  const { cookie } = await loginSession(A.slug, A.adminEmail);
  const get = await api('GET', '/database', { cookie });
  assert.equal(get.status, 200);
  assert.equal(get.json.hasConnectionString, true);
  assert.ok(!JSON.stringify(get.json).includes('secret-pass'));

  const patch = await api('PATCH', '/database', { cookie, body: { strategy: 'DATABASE_PER_TENANT', backupEnabled: true } });
  assert.equal(patch.status, 200, JSON.stringify(patch.json));
  assert.ok(!JSON.stringify(patch.json).includes('secret-pass'));
});

test('OAuth client secrets are write-only and never logged', async () => {
  const { cookie } = await loginSession(A.slug, A.adminEmail);
  const created = await api('POST', '/auth-config/providers', { cookie, body: { provider: 'OKTA', clientId: 'okta-id', clientSecret: 'okta-SECRET-1' } });
  assert.equal(created.status, 201);
  assert.ok(!JSON.stringify(created.json).includes('okta-SECRET-1'));

  const updated = await api('PATCH', `/auth-config/providers/${created.json.id}`, { cookie, body: { clientSecret: 'okta-SECRET-2', enabled: true } });
  assert.equal(updated.status, 200);
  assert.ok(!JSON.stringify(updated.json).includes('okta-SECRET-2'));

  const stored = await prisma.authProvider.findUniqueOrThrow({ where: { id: created.json.id } });
  assert.equal(stored.clientSecret, 'okta-SECRET-2', 'secret was saved');

  const logs = await prisma.activity.findMany({ where: { tenantId: A.tenantId } });
  assert.ok(!JSON.stringify(logs).includes('okta-SECRET'), 'secret not in the activity log');

  const config = await api('GET', '/auth-config', { cookie });
  assert.ok(!JSON.stringify(config.json).includes('okta-SECRET'));
});

test('OTP settings can be changed from the authentication page', async () => {
  const { cookie } = await loginSession(A.slug, A.adminEmail);
  const res = await api('PATCH', '/auth-config', { cookie, body: { otpEnabled: false, otpExpiry: 10 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.otpEnabled, false);
  assert.equal((await api('GET', `/auth/tenant/${A.slug}`)).json.authConfig.otpEnabled, false);
});
