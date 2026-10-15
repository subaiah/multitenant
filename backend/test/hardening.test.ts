/**
 * Hardening of tenant isolation: the database server's setup is checked,
 * one job at a time per tenant across servers, credential rotation, tenants
 * behind on migrations, clear errors from tenant databases, and an audit
 * trail of provisioning. PostgreSQL is the only provider.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { api, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed, type PlatformSeed } from './helpers.js';
import { config } from '../src/config/env.js';
import { checkTenantServer } from '../src/lib/tenant-server-check.js';
import { classifyDatabaseError } from '../src/lib/db-errors.js';
import { dbForTenant } from '../src/lib/tenant-db.js';
import { decryptSecret, secretContext } from '../src/lib/secrets.js';
import { latestMigration } from '../src/lib/tenant-migrations.js';
import { provisionTenant } from '../src/lib/provisioning.js';

let A: TenantSeed;
let B: TenantSeed;
let P: PlatformSeed;
let platform: string;

const connectionUrl = async (tenantId: string) => {
  const { controlDb } = await db();
  const cfg = await controlDb.databaseConfig.findUniqueOrThrow({ where: { tenantId } });
  return decryptSecret(cfg.connectionString!, secretContext('connectionString'));
};

/** Hold a tenant's job lock from outside, as another app server would. */
async function holdJobLock(tenantId: string) {
  const c = new pg.Client({ connectionString: config.databaseUrl });
  await c.connect();
  await c.query('SELECT pg_advisory_lock(hashtext($1))', [`tenant-job:${tenantId}`]);
  return async () => {
    await c.query('SELECT pg_advisory_unlock(hashtext($1))', [`tenant-job:${tenantId}`]);
    await c.end();
  };
}

before(async () => {
  A = await seedTenant('hard-a');
  B = await seedTenant('hard-b');
  P = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', P.adminEmail)).cookie;
});
after(stopServerAndCleanUp);

test('the database server check passes with the setup roles, and names what is wrong otherwise', async () => {
  assert.deepEqual((await checkTenantServer()).errors, []);
  const settings = config as { -readonly [K in keyof typeof config]: (typeof config)[K] };
  const saved = { ...settings };
  try {
    // The migration owner (not a superuser) standing in for the other two, and an oversized pool
    settings.tenantPlatformUrl = config.tenantDatabaseUrl;
    settings.tenantProvisionerUrl = config.tenantDatabaseUrl;
    settings.tenantPoolMax = config.tenantRoleConnectionLimit + 1;
    const { errors } = await checkTenantServer();
    assert.ok(errors.some((e) => /BYPASSRLS/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /CREATEROLE and CREATEDB/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /TENANT_POOL_MAX/.test(e)), errors.join('\n'));
  } finally {
    Object.assign(settings, saved);
  }
});

test("PostgreSQL is the only provider, and it can't be changed", async () => {
  const { cookie } = await loginSession(A.slug, A.adminEmail);
  assert.equal((await api('GET', '/database', { cookie })).json.provider, 'POSTGRESQL');
  const res = await api('PATCH', '/database', { cookie, body: { provider: 'MYSQL' } });
  assert.equal(res.status, 400);
});

test('only one job at a time per tenant, across servers', async () => {
  const release = await holdJobLock(A.tenantId);
  try {
    const del = await api('DELETE', `/tenants/${A.tenantId}`, { cookie: platform });
    assert.equal(del.status, 409);
    assert.match(del.json.message, /Something else is changing this tenant/);
    assert.equal((await api('POST', `/tenants/${A.tenantId}/rotate-credentials`, { cookie: platform })).status, 409);
  } finally {
    await release();
  }
  const { controlDb } = await db();
  assert.equal((await controlDb.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).provisioningStatus, 'READY', 'untouched');
});

test('provisioning leaves a tenant alone while another server works on it', async () => {
  const { controlDb } = await db();
  await controlDb.tenant.update({ where: { id: B.tenantId }, data: { provisioningStatus: 'FAILED', provisioningError: 'test' } });
  const release = await holdJobLock(B.tenantId);
  try {
    await provisionTenant(B.tenantId);
    assert.equal((await controlDb.tenant.findUniqueOrThrow({ where: { id: B.tenantId } })).provisioningStatus, 'FAILED', 'not started here');
  } finally {
    await release();
  }
  await provisionTenant(B.tenantId);
  assert.equal((await controlDb.tenant.findUniqueOrThrow({ where: { id: B.tenantId } })).provisioningStatus, 'READY');
});

test("rotating credentials: the old password stops working, the tenant doesn't notice", async () => {
  const before = await connectionUrl(A.tenantId);
  const { cookie } = await loginSession(A.slug, A.adminEmail);
  assert.equal((await api('GET', '/users', { cookie })).status, 200, "warm the server's client");

  const res = await api('POST', `/tenants/${A.tenantId}/rotate-credentials`, { cookie: platform });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const after = await connectionUrl(A.tenantId);
  assert.notEqual(new URL(after).password, new URL(before).password);
  assert.equal(new URL(after).username, new URL(before).username, 'same role');

  // The old password no longer opens connections; the new one does
  const old = new pg.Client({ connectionString: before });
  await assert.rejects(old.connect(), /password authentication failed/);
  const fresh = new pg.Client({ connectionString: after });
  await fresh.connect();
  await fresh.end();

  // The server switches at once (the config's version changed), and sign-in still works
  assert.equal((await api('GET', '/users', { cookie })).status, 200);
  assert.equal((await loginSession(A.slug, A.userEmail)).body.message, 'Login successful');

  const { controlDb } = await db();
  assert.ok(await controlDb.platformActivity.findFirst({ where: { tenantId: A.tenantId, action: 'rotated database credentials' } }));
});

test('tenants on an older schema are flagged, and Run migrations brings them up to date', async () => {
  const { controlDb } = await db();
  const latest = latestMigration();
  assert.ok(latest);
  await controlDb.databaseConfig.update({ where: { tenantId: B.tenantId }, data: { lastMigration: '00000000000000_older' } });

  const list = (await api('GET', `/tenants?search=${B.slug}`, { cookie: platform })).json;
  assert.equal(list.data[0].migration.behind, true);
  assert.equal(list.migrations.latest, latest);
  assert.ok(list.migrations.tenantsBehind >= 1);

  const run = await api('POST', '/platform/tenant-migrations', { cookie: platform });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  assert.equal((await controlDb.databaseConfig.findUniqueOrThrow({ where: { tenantId: B.tenantId } })).lastMigration, latest);
  assert.equal((await api('GET', `/tenants?search=${B.slug}`, { cookie: platform })).json.data[0].migration.behind, false);
  assert.ok(await controlDb.platformActivity.findFirst({ where: { userId: { not: null }, action: 'ran tenant migrations' } }));

  // Tenant admins can't run it
  const { cookie } = await loginSession(A.slug, A.adminEmail);
  assert.equal((await api('POST', '/platform/tenant-migrations', { cookie })).status, 403);
});

test("an unreachable tenant database is a 503 naming the organization, not a 500", async () => {
  const { controlDb } = await db();
  const good = await connectionUrl(B.tenantId);
  const { cookie } = await loginSession(B.slug, B.adminEmail);
  const broken = new URL(good);
  broken.password = 'not-the-password';
  await controlDb.databaseConfig.update({ where: { tenantId: B.tenantId }, data: { connectionString: broken.toString() } });
  try {
    const res = await api('GET', '/users', { cookie });
    assert.equal(res.status, 503);
    assert.match(res.json.message, /Test hard-b's data is temporarily unavailable/);
    assert.ok(!JSON.stringify(res.json).includes('not-the-password'));
  } finally {
    await controlDb.databaseConfig.update({ where: { tenantId: B.tenantId }, data: { connectionString: good } });
  }
  assert.equal((await api('GET', '/users', { cookie })).status, 200, 'back once fixed');
});

test('a row-level security refusal is recognised as a denial (403), not a server error', async () => {
  const own = await dbForTenant(A.tenantId);
  const err = await own.user.create({ data: { tenantId: B.tenantId, email: 'x@x.test', userType: 'TENANT_USER' } }).catch((e) => e);
  assert.equal(classifyDatabaseError(err), 'denied');
  assert.equal(classifyDatabaseError(new Error('something else')), null);
});

test('provisioning outcomes are in the platform activity log', async () => {
  const { controlDb } = await db();
  const entry = await controlDb.platformActivity.findFirst({ where: { tenantId: A.tenantId, action: 'tenant set up' } });
  assert.ok(entry, 'tenant set up');
  assert.deepEqual(entry!.metadata, { isolation: A.strategy });
  assert.ok(await controlDb.platformActivity.findFirst({ where: { tenantId: B.tenantId, action: 'tenant set up' } }));
});
