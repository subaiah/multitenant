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
let controlDb: Awaited<ReturnType<typeof db>>['controlDb'];
let appB: string;

before(async () => {
  ({ controlDb } = await db());
  A = await seedTenant('data-a');
  B = await seedTenant('data-b');
  P = await seedPlatformUsers();
  for (const [t, prefix] of [[A, 'Alpha'], [B, 'Beta']] as const) {
    await t.db.application.createMany({
      data: [
        { tenantId: t.tenantId, name: `${prefix} Web`, status: 'RUNNING', version: '1.0.0', environment: 'PRODUCTION', url: 'https://x.test', cpu: 40, memory: 50, requests: 100 },
        { tenantId: t.tenantId, name: `${prefix} Worker`, status: 'ERROR', version: '1.0.1', environment: 'STAGING', url: 'https://y.test', cpu: 90, memory: 95, requests: 5 },
      ],
    });
    await t.db.activity.create({ data: { tenantId: t.tenantId, action: 'deployed', target: `${prefix} Web`, type: 'DEPLOY' } });
  }
  appB = (await B.db.application.findFirstOrThrow({ where: { tenantId: B.tenantId } })).id;
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

test('tenant list includes status counts and usage from the periodic snapshot', async () => {
  const { cookie } = await loginSession('platform', P.adminEmail);
  const before = (await api('GET', `/tenants?search=${A.slug}`, { cookie })).json.data[0];
  assert.equal(before._count.applications, 0, 'snapshot taken when provisioned, before the apps were added');

  // What the background job does every few minutes
  const { refreshTenantUsage } = await import('../src/lib/tenant-usage.js');
  await refreshTenantUsage([A.tenantId, B.tenantId]);

  const res = await api('GET', `/tenants?search=${A.slug}`, { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.length, 1);
  assert.equal(res.json.statusCounts.ACTIVE, 1);
  const a = res.json.data[0];
  assert.ok(a.lastActiveAt, 'lastActiveAt from activity');
  assert.deepEqual(a._count, { users: 3, applications: 2 });
  assert.ok(a.usageRefreshedAt);

  // The snapshot of B, which the platform dashboard adds up with everyone else's
  // (other test files run in parallel, so the dashboard's latest-8 list may not show it)
  const usageB = await controlDb.tenantUsage.findUniqueOrThrow({ where: { tenantId: B.tenantId } });
  assert.deepEqual(usageB.appsByStatus, { RUNNING: 1, ERROR: 1 });
  assert.ok((usageB.recentActivity as { target: string }[]).some((r) => r.target === 'Beta Web'));
  const stats = (await api('GET', '/platform/stats', { cookie })).json;
  assert.ok(stats.applications.byStatus.ERROR >= 2, 'both tenants have an app in error');
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

test("the tenant role's connection string is never returned; where data lives can't be changed", async () => {
  const { cookie } = await loginSession(A.slug, A.adminEmail);
  const { decryptSecret } = await import('../src/lib/secrets.js');
  const cfg = await controlDb.databaseConfig.findUniqueOrThrow({ where: { tenantId: A.tenantId } });
  const password = new URL(decryptSecret(cfg.connectionString!, 'database_configs.connection_string')).password;

  const get = await api('GET', '/database', { cookie });
  assert.equal(get.status, 200);
  assert.equal(get.json.hasConnectionString, true);
  assert.equal(get.json.strategy, A.strategy);
  assert.ok(!JSON.stringify(get.json).includes(password));

  const patch = await api('PATCH', '/database', { cookie, body: { backupEnabled: true } });
  assert.equal(patch.status, 200, JSON.stringify(patch.json));
  assert.ok(!JSON.stringify(patch.json).includes(password));

  for (const body of [{ strategy: 'SHARED_TABLES' }, { connectionString: 'postgresql://x:y@evil/db' }, { schemaName: 'public' }]) {
    const res = await api('PATCH', '/database', { cookie, body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.json.message, /fixed once/);
  }
  assert.equal((await controlDb.databaseConfig.findUniqueOrThrow({ where: { tenantId: A.tenantId } })).connectionString, cfg.connectionString);
});

test('OAuth client secrets are write-only and never logged', async () => {
  const { cookie } = await loginSession(A.slug, A.adminEmail);
  const created = await api('POST', '/auth-config/providers', { cookie, body: { provider: 'OKTA', clientId: 'okta-id', clientSecret: 'okta-SECRET-1' } });
  assert.equal(created.status, 201);
  assert.ok(!JSON.stringify(created.json).includes('okta-SECRET-1'));

  const updated = await api('PATCH', `/auth-config/providers/${created.json.id}`, { cookie, body: { clientSecret: 'okta-SECRET-2', enabled: true } });
  assert.equal(updated.status, 200);
  assert.ok(!JSON.stringify(updated.json).includes('okta-SECRET-2'));

  const stored = await A.db.authProvider.findUniqueOrThrow({ where: { id: created.json.id } });
  const { decryptSecret, isEncrypted } = await import('../src/lib/secrets.js');
  assert.ok(isEncrypted(stored.clientSecret!), 'secret is stored encrypted');
  assert.equal(decryptSecret(stored.clientSecret!, 'auth_providers.client_secret'), 'okta-SECRET-2', 'secret was saved');

  const logs = await A.db.activity.findMany({ where: { tenantId: A.tenantId } });
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
