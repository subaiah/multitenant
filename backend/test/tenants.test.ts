/**
 * Tenants are created by platform admins (no self sign-up) and provisioned in
 * the background: a database role of their own, their schema or database,
 * tables with row-level security, defaults, then an invitation for the first
 * administrator. Nobody signs in before that's done. Failures can be retried,
 * and deleting a tenant removes its role, schema or database and its data.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outbox = join(mkdtempSync(join(tmpdir(), 'mail-')), 'outbox.jsonl');
process.env.EMAIL_TRANSPORT = 'file';
process.env.MAIL_OUTBOX_FILE = outbox;
process.env.FRONTEND_URL = 'http://app.test';

const {
  PASSWORD, api, dataOf, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, trackTenant, waitForProvisioning,
} = await import('./helpers.js');
const { withConnection } = await import('../src/lib/tenant-migrations.js');
const { config } = await import('../src/config/env.js');

let platformAdmin: string;
let platformSupport: string;
let A: Awaited<ReturnType<typeof seedTenant>>;
const stamp = Date.now().toString(36);
const MODES = ['SHARED_TABLES', 'SCHEMA_PER_TENANT', 'DATABASE_PER_TENANT'] as const;

const lastMail = (to: string) =>
  existsSync(outbox)
    ? readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.to === to).at(-1)
    : undefined;

/** What exists on the database server for a role name */
async function serverHas(name: string) {
  return withConnection(config.tenantDatabaseUrl, async (c) => {
    const one = async (sql: string) => Boolean((await c.query(sql, [name])).rowCount);
    return {
      role: await one('SELECT 1 FROM pg_roles WHERE rolname = $1'),
      schema: await one('SELECT 1 FROM pg_namespace WHERE nspname = $1'),
      database: await one('SELECT 1 FROM pg_database WHERE datname = $1'),
    };
  });
}

before(async () => {
  ({ adminEmail: platformAdmin, supportEmail: platformSupport } = await seedPlatformUsers());
  A = await seedTenant('tcreate');
  await startServer();
});
after(stopServerAndCleanUp);

const asPlatform = async (email: string) => (await loginSession('platform', email)).cookie;

for (const mode of MODES) {
  test(`a platform admin creates a tenant (${mode}); it's provisioned and its first admin invited`, async () => {
    const { controlDb } = await db();
    const cookie = await asPlatform(platformAdmin);
    const slug = `new-${mode.split('_')[0].toLowerCase()}-${stamp}`;
    const adminEmail = `first-admin-${slug}@test.local`;
    const res = await api('POST', '/tenants', {
      cookie,
      body: { name: 'New Co', slug, plan: 'STARTER', strategy: mode, adminName: 'First Admin', adminEmail },
    });
    assert.equal(res.status, 202, JSON.stringify(res.json));
    trackTenant(res.json.id);
    assert.equal(res.json.isolation, mode);
    assert.equal(res.json.adminInvited, adminEmail);
    assert.equal(await waitForProvisioning(res.json.id), 'READY');

    // Control plane: its own role, and its schema or database named after it
    const cfg = await controlDb.databaseConfig.findUniqueOrThrow({ where: { tenantId: res.json.id } });
    const role = `${config.tenantRolePrefix}${slug.replaceAll('-', '_')}`;
    assert.equal(cfg.dbRoleName, role);
    assert.equal(cfg.schemaName, mode === 'SCHEMA_PER_TENANT' ? role : null);
    assert.equal(cfg.databaseName, mode === 'DATABASE_PER_TENANT' ? role : null);
    assert.ok(cfg.lastMigration, 'migrations recorded');
    const has = await serverHas(role);
    assert.deepEqual(has, { role: true, schema: mode === 'SCHEMA_PER_TENANT', database: mode === 'DATABASE_PER_TENANT' });

    // Tenant plane: defaults and a pending administrator
    const data = await dataOf(res.json.id);
    assert.ok(await data.authConfig.findUnique({ where: { tenantId: res.json.id } }));
    const roles = await data.role.findMany({ where: { tenantId: res.json.id }, select: { name: true } });
    assert.ok(roles.some((r) => r.name === 'Tenant Admin'), 'built-in roles created');
    const admin = await data.user.findFirstOrThrow({ where: { tenantId: res.json.id, email: adminEmail } });
    assert.equal(admin.status, 'PENDING');
    assert.equal(admin.userType, 'TENANT_ADMIN');

    // The invitation works and the new admin can use their tenant
    const token = lastMail(adminEmail)?.text.match(/token=([A-Za-z0-9_.-]+)/)?.[1];
    assert.ok(token?.startsWith(`${slug}.`), 'invitation token names the tenant');
    const accepted = await api('POST', '/bff/account/invitations/accept', { body: { token, password: PASSWORD } });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    const session = await loginSession(slug, adminEmail);
    const users = await api('GET', '/users', { cookie: session.cookie });
    assert.equal(users.status, 200);
    assert.deepEqual(users.json.data.map((u: { email: string }) => u.email), [adminEmail], 'sees only its own people');

    // It shows on the tenants page with its state and (snapshot) counts
    const list = await api('GET', `/tenants?search=${slug}`, { cookie });
    assert.equal(list.json.data[0].provisioningStatus, 'READY');
    assert.equal(list.json.data[0].isolation, mode);
    assert.equal(list.json.data[0]._count.users, 1);
  });
}

test("nobody signs in to a tenant that isn't provisioned yet", async () => {
  const { controlDb } = await db();
  const slug = `pending-${stamp}`;
  const t = await controlDb.tenant.create({
    data: {
      name: 'Pending Co', slug, plan: 'FREE', status: 'ACTIVE', provisioningStatus: 'PENDING',
      databaseConfig: { create: { strategy: 'SHARED_TABLES', region: 'x', storageLimit: '1 GB' } },
    },
  });
  trackTenant(t.id);
  const login = await api('POST', '/bff/auth/login', { body: { email: 'x@test.local', tenantSlug: slug, password: PASSWORD } });
  assert.equal(login.status, 409);
  assert.match(login.json.message, /being set up/);
  assert.equal((await api('POST', '/bff/auth/otp/request', { body: { email: 'x@test.local', tenantSlug: slug } })).status, 409);
  // Platform admins can't work inside it either
  const platform = await asPlatform(platformAdmin);
  assert.equal((await api('GET', '/users', { cookie: platform, tenant: t.id })).status, 409);
});

test('a failed provisioning shows its error and can be retried', async () => {
  const { controlDb } = await db();
  const cookie = await asPlatform(platformAdmin);
  const slug = `retry-${stamp}`;
  const role = `${config.tenantRolePrefix}${slug.replaceAll('-', '_')}`;
  // Something already in the way: a schema of that name with a clashing table
  await withConnection(config.tenantDatabaseUrl, async (c) => {
    await c.query(`CREATE SCHEMA "${role}"`);
    await c.query(`CREATE TABLE "${role}".users (id int)`);
  });
  const res = await api('POST', '/tenants', {
    cookie,
    body: { name: 'Retry Co', slug, strategy: 'SCHEMA_PER_TENANT', adminName: 'Retry Admin', adminEmail: `retry-${stamp}@test.local` },
  });
  assert.equal(res.status, 202);
  trackTenant(res.json.id);
  assert.equal(await waitForProvisioning(res.json.id), 'FAILED');
  const failed = (await api('GET', `/tenants/${res.json.id}`, { cookie })).json;
  assert.equal(failed.provisioningStatus, 'FAILED');
  assert.match(failed.provisioningError, /already exists/);
  assert.ok(!/postgres(ql)?:\/\//.test(failed.provisioningError), 'no connection details in the error');
  assert.equal((await api('POST', '/bff/auth/login', { body: { email: `retry-${stamp}@test.local`, tenantSlug: slug, password: PASSWORD } })).status, 409);

  // Clear the obstacle and retry: it picks up where it stopped
  await withConnection(config.tenantDatabaseUrl, (c) => c.query(`DROP SCHEMA "${role}" CASCADE`));
  assert.equal((await api('POST', `/tenants/${res.json.id}/provision`, { cookie })).status, 202);
  assert.equal(await waitForProvisioning(res.json.id), 'READY');
  assert.ok(lastMail(`retry-${stamp}@test.local`), 'first admin invited once ready');
  assert.equal((await controlDb.tenant.findUniqueOrThrow({ where: { id: res.json.id } })).provisioningError, null);
  assert.equal((await api('POST', `/tenants/${res.json.id}/provision`, { cookie })).status, 409, 'nothing to retry once ready');
});

test('slugs are validated, unique, and the platform slugs are reserved', async () => {
  const cookie = await asPlatform(platformAdmin);
  const body = { name: 'Xylo', adminName: 'X Admin', adminEmail: `x-${stamp}@test.local` };
  assert.equal((await api('POST', '/tenants', { cookie, body: { ...body, slug: 'platform' } })).status, 409);
  assert.equal((await api('POST', '/tenants', { cookie, body: { ...body, slug: 'admin' } })).status, 409);
  assert.equal((await api('POST', '/tenants', { cookie, body: { ...body, slug: 'shared' } })).status, 409, 'the shared-tables group role');
  assert.equal((await api('POST', '/tenants', { cookie, body: { ...body, slug: A.slug } })).status, 409);
  assert.equal((await api('POST', '/tenants', { cookie, body: { ...body, slug: 'Not OK!' } })).status, 400);
  assert.equal((await api('POST', '/tenants', { cookie, body: { ...body, slug: `ok-${stamp}`, strategy: 'BRING_YOUR_OWN' } })).status, 400);
});

test('only platform admins can create tenants', async () => {
  const body = { name: 'Nope', slug: `nope-${stamp}`, adminName: 'N', adminEmail: `n-${stamp}@test.local` };
  assert.equal((await api('POST', '/tenants', { cookie: await asPlatform(platformSupport), body })).status, 403);
  const tenantAdmin = (await loginSession(A.slug, A.adminEmail)).cookie;
  assert.equal((await api('POST', '/tenants', { cookie: tenantAdmin, body })).status, 403);
});

for (const mode of MODES) {
  test(`deleting a tenant (${mode}) removes its role, schema or database, and data`, async () => {
    const { controlDb } = await db();
    const cookie = await asPlatform(platformAdmin);
    const slug = `gone-${mode.split('_')[0].toLowerCase()}-${stamp}`;
    const res = await api('POST', '/tenants', {
      cookie,
      body: { name: 'Gone Co', slug, strategy: mode, adminName: 'Gone Admin', adminEmail: `gone-${slug}@test.local` },
    });
    assert.equal(res.status, 202);
    const id = res.json.id;
    trackTenant(id);
    assert.equal(await waitForProvisioning(id), 'READY');
    const role = (await controlDb.databaseConfig.findUniqueOrThrow({ where: { tenantId: id } })).dbRoleName!;
    const shared = mode === 'SHARED_TABLES' ? await dataOf(id) : null;

    assert.equal((await api('DELETE', `/tenants/${id}`, { cookie })).status, 204);
    assert.equal(await controlDb.tenant.findUnique({ where: { id } }), null);
    assert.equal(await controlDb.databaseConfig.findUnique({ where: { tenantId: id } }), null);
    assert.deepEqual(await serverHas(role), { role: false, schema: false, database: false });
    if (shared) {
      // Its rows are gone from the shared tables
      assert.equal(await shared.user.count({ where: { tenantId: id } }), 0);
      assert.equal(await shared.role.count({ where: { tenantId: id } }), 0);
      assert.equal(await shared.authConfig.count({ where: { tenantId: id } }), 0);
    }
  });
}
