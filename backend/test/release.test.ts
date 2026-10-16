/**
 * Production readiness: settings a deployment relies on (proxy, API reference,
 * preview pages), limits shared between servers, the release step's own
 * migration runner, and creating the first administrator.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import {
  PASSWORD, api, db, loginSession, seedPlatformUsers, seedTenant, startExtraServer, startServer, stopServerAndCleanUp,
  type PlatformSeed, type TenantSeed,
} from './helpers.js';

let A: TenantSeed;
let P: PlatformSeed;
let controlDb: Awaited<ReturnType<typeof db>>['controlDb'];
/** Production-like: no preview pages, no API reference, one trusted proxy */
let prod: Awaited<ReturnType<typeof startExtraServer>>;

before(async () => {
  ({ controlDb } = await db());
  await startServer();
  A = await seedTenant('release');
  P = await seedPlatformUsers();
  prod = await startExtraServer({ PREVIEW_FEATURES: 'false', API_DOCS: 'false', TRUST_PROXY: '1' });
});

after(async () => {
  await prod?.stop();
  await stopServerAndCleanUp();
});

// ------------------------------------------------------------ removed demo endpoints

test('the demo BFF endpoints are gone', async () => {
  const s = await loginSession(A.slug, A.adminEmail);
  const p = await loginSession('platform', P.adminEmail);
  // A token for "any service", and another tenant's whole data set to platform staff
  assert.equal((await api('POST', '/bff/token/exchange', { cookie: s.cookie, body: { service: 'reports' } })).status, 404);
  assert.equal((await api('GET', `/bff/tenant/${A.tenantId}/data`, { cookie: p.cookie })).status, 404);
  assert.equal((await api('GET', `/bff/tenant/${A.tenantId}/data`, { cookie: s.cookie })).status, 404);
  assert.equal((await api('GET', '/bff/health', { cookie: s.cookie })).status, 404);
  assert.equal((await api('GET', `/bff/apps/${randomUUID()}/overview`, { cookie: s.cookie })).status, 404);
  // The dashboard aggregation stays
  assert.equal((await api('GET', '/bff/dashboard', { cookie: s.cookie })).status, 200);
});

// ------------------------------------------------------------ limits across servers

test('guesses at a sign-in code are counted across servers', async () => {
  const body = { email: A.userEmail, tenantSlug: A.slug, code: '000000' };
  // Two servers behind a load balancer, three wrong guesses each: the sixth is refused
  for (let i = 0; i < 3; i++) assert.notEqual((await api('POST', '/bff/auth/otp/verify', { body })).status, 429, `main ${i}`);
  for (let i = 0; i < 2; i++) assert.notEqual((await prod.api('POST', '/bff/auth/otp/verify', { body })).status, 429, `prod ${i}`);
  assert.equal((await prod.api('POST', '/bff/auth/otp/verify', { body })).status, 429);
  assert.equal((await api('POST', '/bff/auth/otp/verify', { body })).status, 429);

  // Stored under a hash: no email addresses in the table
  const rows = await controlDb.rateLimitHit.findMany();
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => !r.key.includes('@') && r.key.length === 43), 'keys are SHA-256, base64url');
  assert.ok(rows.some((r) => r.count >= 6));
});

test('expired counters start a new window', async () => {
  const body = { email: A.managerEmail, tenantSlug: A.slug, code: '000000' };
  for (let i = 0; i < 5; i++) await api('POST', '/bff/auth/otp/verify', { body });
  assert.equal((await api('POST', '/bff/auth/otp/verify', { body })).status, 429);
  // Fifteen minutes later (moved back rather than waited for)
  const key = createHash('sha256').update(`otp-verify:bff:${A.slug}:${A.managerEmail.toLowerCase()}`).digest('base64url');
  assert.equal((await controlDb.$executeRaw`UPDATE rate_limit_hits SET expires_at = now() - interval '1 second' WHERE key = ${key}`), 1);
  assert.notEqual((await api('POST', '/bff/auth/otp/verify', { body })).status, 429);
});

// ------------------------------------------------------------ proxy

test('behind a trusted proxy the client address comes from X-Forwarded-For', async () => {
  const signIn = (server: typeof api) =>
    server('POST', '/bff/auth/login', { body: { email: A.userEmail, tenantSlug: A.slug, password: PASSWORD }, headers: { 'x-forwarded-for': '203.0.113.7' } });
  const lastSignIn = async () =>
    (await A.db.auditEvent.findFirstOrThrow({ where: { tenantId: A.tenantId, event: 'auth.signed_in' }, orderBy: { seq: 'desc' } })).ip;

  assert.equal((await signIn(prod.api)).status, 200);
  assert.equal(await lastSignIn(), '203.0.113.7');
  // Without TRUST_PROXY the header is ignored: anyone can send it
  assert.equal((await signIn(api)).status, 200);
  assert.equal(await lastSignIn(), '127.0.0.1');
});

// ------------------------------------------------------------ headers and the API reference

test('the API sends a content policy that allows nothing', async () => {
  const res = await fetch(`${prod.base}/health`);
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(res.headers.get('strict-transport-security'));
});

test('the API reference is off in production unless turned on', async () => {
  assert.equal((await fetch(`${prod.base}/docs`)).status, 404);
  assert.equal((await fetch(`${prod.base}/docs/json`)).status, 404);
  // Outside production it's on, with its own content policy
  const dev = await api('GET', '/docs/static/index.html');
  assert.equal(dev.status, 200);
  assert.match(dev.headers.get('content-security-policy') ?? '', /script-src 'self'/);
});

// ------------------------------------------------------------ preview pages

test('pages with sample data are hidden when preview features are off', async (t) => {
  const s = await loginSession(A.slug, A.adminEmail);
  // Menu entries (the test databases have no seeded menu)
  const label = `release-${randomUUID().slice(0, 8)}`;
  const items = await Promise.all(
    ['/infrastructure', '/users'].map((path) => controlDb.menuItem.create({ data: { portal: 'TENANT', label, path, order: 999 } })),
  );
  t.after(() => controlDb.menuItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } }));
  const paths = (menu: { menuItems: { path: string; children: { path: string }[] }[] }) =>
    menu.menuItems.flatMap((m) => [m.path, ...m.children.map((c) => c.path)]);

  // Production-like
  assert.equal((await prod.api('GET', '/bff/auth/me', { cookie: s.cookie })).json.features.preview, false);
  assert.equal((await prod.api('GET', '/deployments', { cookie: s.cookie })).status, 404);
  assert.equal((await prod.api('GET', '/api-config', { cookie: s.cookie })).status, 404);
  const dash = await prod.api('GET', '/bff/dashboard', { cookie: s.cookie });
  assert.equal(dash.status, 200);
  assert.equal(dash.json.applications, null);
  const prodMenu = paths((await prod.api('GET', '/menu-items/portal/TENANT', { cookie: s.cookie })).json);
  assert.ok(!prodMenu.includes('/infrastructure'));
  assert.ok(prodMenu.includes('/users'));
  // Backup and encryption are switches only; the storage note still saves
  assert.equal((await prod.api('PATCH', '/database', { cookie: s.cookie, body: { backupEnabled: false } })).status, 400);
  assert.equal((await prod.api('PATCH', '/database', { cookie: s.cookie, body: { storageLimit: '10GB' } })).status, 200);

  // Development and tests: shown
  assert.equal((await api('GET', '/bff/auth/me', { cookie: s.cookie })).json.features.preview, true);
  assert.equal((await api('GET', '/deployments', { cookie: s.cookie })).status, 200);
  assert.ok((await api('GET', '/bff/dashboard', { cookie: s.cookie })).json.applications);
  assert.ok(paths((await api('GET', '/menu-items/portal/TENANT', { cookie: s.cookie })).json).includes('/infrastructure'));
});

// ------------------------------------------------------------ the release step

test('the control-plane migration runner agrees with Prisma', async () => {
  const { migrateControlPlane, pendingControlMigrations } = await import('../src/lib/control-migrations.js');
  assert.deepEqual(await pendingControlMigrations(), []);

  // A fresh database, migrated by our runner, records what prisma migrate deploy recorded
  const name = `release_${randomUUID().slice(0, 8)}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  try {
    const first = await migrateControlPlane(url.toString());
    assert.ok(first.applied.length > 0);
    assert.deepEqual(await pendingControlMigrations(url.toString()), []);
    // Again: nothing to do
    assert.deepEqual((await migrateControlPlane(url.toString())).applied, []);

    const recorded = async (connectionString: string) => {
      const c = new pg.Client({ connectionString });
      await c.connect();
      try {
        return (await c.query('SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name')).rows;
      } finally {
        await c.end();
      }
    };
    assert.deepEqual(await recorded(url.toString()), await recorded(process.env.DATABASE_URL!));
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});

test('the first administrator is invited to set a password', async () => {
  const email = `first-admin-${randomUUID().slice(0, 8)}@platform.test`;
  const run = (args: string[]) =>
    promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli/create-admin.ts', ...args], { env: { ...process.env, EMAIL_TRANSPORT: 'log' } });
  try {
    const { stdout } = await run([email, 'First Admin']);
    const link = /accept-invite\?token=(\S+)/.exec(stdout);
    assert.ok(link, stdout);
    const user = await controlDb.platformUser.findUniqueOrThrow({ where: { email } });
    assert.equal(user.userType, 'PLATFORM_ADMIN');
    assert.equal(user.status, 'PENDING');
    assert.equal(user.passwordHash, null);

    const token = decodeURIComponent(link[1]);
    const accepted = await api('POST', '/bff/account/invitations/accept', { body: { token, password: 'A-much-longer-passphrase-9!' } });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    const signIn = await api('POST', '/bff/auth/login', { body: { email, tenantSlug: 'platform', password: 'A-much-longer-passphrase-9!' } });
    assert.equal(signIn.status, 200);

    // Not twice: an active account is left alone
    await assert.rejects(run([email]), /already has an active platform account/);
  } finally {
    const u = await controlDb.platformUser.findUnique({ where: { email } });
    if (u) {
      await controlDb.platformRefreshToken.deleteMany({ where: { userId: u.id } });
      await controlDb.platformUserToken.deleteMany({ where: { userId: u.id } });
      await controlDb.platformActivity.deleteMany({ where: { userId: u.id } });
      await controlDb.platformUser.delete({ where: { id: u.id } });
    }
  }
});

test('the release step adds new menu entries and keeps changes to existing ones', async () => {
  const { syncMenus } = await import('../src/lib/menus.js');
  await syncMenus();
  // Someone renamed an entry; a new version added one (here: one went missing)
  const users = await controlDb.menuItem.findFirstOrThrow({ where: { portal: 'PLATFORM', parentId: null, path: '/platform/users' } });
  await controlDb.menuItem.update({ where: { id: users.id }, data: { label: 'Staff' } });
  await controlDb.menuItem.deleteMany({ where: { portal: 'PLATFORM', path: '/platform/support' } });

  // (At least: other test files add and remove menu rows of their own meanwhile)
  assert.ok((await syncMenus()) >= 1);
  await syncMenus();
  assert.equal((await controlDb.menuItem.findUniqueOrThrow({ where: { id: users.id } })).label, 'Staff');
  assert.equal(await controlDb.menuItem.count({ where: { portal: 'PLATFORM', path: '/platform/support' } }), 1);
  // Nested entries are matched under their parent (Access and Users share a path)
  const access = await controlDb.menuItem.findFirstOrThrow({ where: { portal: 'TENANT', parentId: null, path: '/users' } });
  assert.equal(await controlDb.menuItem.count({ where: { portal: 'TENANT', parentId: access.id, path: '/users' } }), 1);
  await controlDb.menuItem.update({ where: { id: users.id }, data: { label: 'Platform Users' } });
});
