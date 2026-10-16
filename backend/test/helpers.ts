/**
 * Shared harness for integration tests: starts the real server against real
 * Postgres databases (DATABASE_URL for the control plane, TENANT_DATABASE_URL
 * for the shared tenant database, both schemas already pushed) and seeds
 * isolated data with unique names per run, so test files can run in parallel.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TenantDb } from '../src/lib/tenant-db.js';

process.env.JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret-1234';
process.env.NODE_ENV = 'test';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must point at a test control-plane database');
if (!process.env.TENANT_DATABASE_URL) throw new Error('TENANT_DATABASE_URL must point at a test tenant database (as the migration owner)');
// Background jobs would race the tests' own provisioning and cleanup
process.env.TENANT_USAGE_REFRESH_MS ??= '0';
process.env.AUDIT_ARCHIVE_INTERVAL_MS ??= '0';
process.env.NOTIFICATION_POLL_MS ??= '0';
// Audit archives (also written when test tenants are deleted) go somewhere disposable
process.env.AUDIT_ARCHIVE_DIR ??= join(tmpdir(), 'multitenant-test-audit-archive');

export const PASSWORD = 'correct-horse-battery';
// A port the OS says is free (a fixed range could hit a dev server already
// running, and the health check would then talk to the wrong database)
const PORT = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as AddressInfo;
    probe.close(() => resolve(port));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const run = randomUUID().slice(0, 8);

export type Strategy = 'SHARED_TABLES' | 'SCHEMA_PER_TENANT' | 'DATABASE_PER_TENANT';
export type TenantSeed = {
  tenantId: string;
  slug: string;
  strategy: Strategy;
  /** Postgres schema holding its tables (for raw SQL through db) */
  schema: string;
  adminEmail: string;
  managerEmail: string;
  userEmail: string;
  providerId: string;
  /** Direct access to this tenant's data for fixtures and checks (platform role: bypasses row-level security, so filter by tenantId) */
  db: TenantDb;
};

/**
 * Which isolation mode seeded tenants get. TEST_TENANT_MODE forces one
 * (CI runs the suite once per mode); otherwise successive tenants rotate
 * through all three, so every run also crosses modes.
 */
const STRATEGIES: Strategy[] = ['SHARED_TABLES', 'SCHEMA_PER_TENANT', 'DATABASE_PER_TENANT'];
let rotation = Math.floor(Math.random() * 3);
function nextStrategy(): Strategy {
  const forced = process.env.TEST_TENANT_MODE;
  if (forced && forced !== 'mixed') {
    if (!STRATEGIES.includes(forced as Strategy)) throw new Error(`TEST_TENANT_MODE must be mixed or one of ${STRATEGIES.join(', ')}`);
    return forced as Strategy;
  }
  return STRATEGIES[rotation++ % STRATEGIES.length];
}
export type PlatformSeed = { adminEmail: string; supportEmail: string };

let server: ChildProcess | undefined;
const created = { tenants: [] as string[], platformEmails: [] as string[] };

/** Base URL of the server under test. */
export function baseUrl() {
  return BASE;
}

export async function db() {
  return import('../src/lib/prisma.js');
}

/** Platform-role client on the target holding this tenant's data. */
export async function dataOf(tenantId: string): Promise<TenantDb> {
  const { targetForTenant } = await import('../src/lib/tenant-db.js');
  const { platformDb } = await import('../src/lib/tenant-targets.js');
  return platformDb(await targetForTenant(tenantId));
}

/** A provisioned tenant (its own role, schema or database, row-level security) with three users and an SSO provider. */
export async function seedTenant(label: string, strategy: Strategy = nextStrategy()): Promise<TenantSeed> {
  const { controlDb } = await db();
  const { provisionTenant } = await import('../src/lib/provisioning.js');
  const { dbForTenant } = await import('../src/lib/tenant-db.js');
  const { hashPassword } = await import('../src/utils/auth.js');
  const passwordHash = await hashPassword(PASSWORD);
  const slug = `t-${label}-${run}`;
  const tenant = await controlDb.tenant.create({
    data: {
      name: `Test ${label}`, slug, plan: 'FREE', status: 'ACTIVE',
      databaseConfig: { create: { strategy, region: 'test', storageLimit: '1 GB' } },
    },
  });
  created.tenants.push(tenant.id);
  await provisionTenant(tenant.id);
  const state = await controlDb.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
  assert.equal(state.provisioningStatus, 'READY', `provisioning ${slug} (${strategy}) failed: ${state.provisioningError}`);

  const cfg = await controlDb.databaseConfig.findUniqueOrThrow({ where: { tenantId: tenant.id } });
  const seed = {
    tenantId: tenant.id,
    slug,
    strategy,
    schema: cfg.schemaName ?? 'public',
    adminEmail: `admin-${label}-${run}@test.local`,
    managerEmail: `manager-${label}-${run}@test.local`,
    userEmail: `user-${label}-${run}@test.local`,
  };
  // Fixtures go in as the tenant's own role, like the app writes them
  const own = await dbForTenant(tenant.id);
  await own.user.createMany({
    data: [
      { tenantId: tenant.id, email: seed.adminEmail, name: 'Admin', userType: 'TENANT_ADMIN', passwordHash },
      { tenantId: tenant.id, email: seed.managerEmail, name: 'Manager', userType: 'TENANT_MANAGER', passwordHash },
      { tenantId: tenant.id, email: seed.userEmail, name: 'User', userType: 'TENANT_USER', passwordHash },
    ],
  });
  const authConfig = await own.authConfig.update({ where: { tenantId: tenant.id }, data: { otpEnabled: true } });
  const provider = await own.authProvider.create({
    data: { tenantId: tenant.id, authConfigId: authConfig.id, provider: 'GOOGLE', clientId: 'cid', clientSecret: 'TOP-SECRET', scopes: ['email'] },
  });
  return { ...seed, providerId: provider.id, db: await dataOf(tenant.id) };
}

export async function seedPlatformUsers(): Promise<PlatformSeed> {
  const { controlDb } = await db();
  const { hashPassword } = await import('../src/utils/auth.js');
  const passwordHash = await hashPassword(PASSWORD);
  const seed = { adminEmail: `padmin-${run}@platform.test`, supportEmail: `psupport-${run}@platform.test` };
  await controlDb.platformUser.createMany({
    data: [
      { email: seed.adminEmail, name: 'Platform Admin', userType: 'PLATFORM_ADMIN', passwordHash },
      { email: seed.supportEmail, name: 'Platform Support', userType: 'PLATFORM_USER', passwordHash },
    ],
  });
  created.platformEmails.push(seed.adminEmail, seed.supportEmail);
  return seed;
}

export async function startServer() {
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LOG_LEVEL: 'error' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let exited = false;
  server.once('exit', () => (exited = true));
  for (let i = 0; i < 100; i++) {
    // Our server must be the one answering
    if (exited) throw new Error('server exited during startup');
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('server did not start');
}

export async function stopServerAndCleanUp() {
  server?.kill();
  const { controlDb, disconnectDatabases } = await db();
  const { deprovisionTenant } = await import('../src/lib/provisioning.js');
  const platformUsers = await controlDb.platformUser.findMany({ where: { email: { in: created.platformEmails } }, select: { id: true } });
  const platformIds = platformUsers.map((u) => u.id);
  // Each tenant's role, schema or database, rows and control-plane records
  for (const id of created.tenants) {
    if (await controlDb.tenant.findUnique({ where: { id } })) await deprovisionTenant(id);
  }
  await controlDb.platformRefreshToken.deleteMany({ where: { userId: { in: platformIds } } });
  await controlDb.platformActivity.deleteMany({ where: { OR: [{ userId: { in: platformIds } }, { tenantId: { in: created.tenants } }] } });
  // Notifications this process raised (provisioning, deleting) finish first
  await (await import('../src/lib/notifications.js')).notificationsSettled();
  await controlDb.platformNotification.deleteMany({ where: { userId: { in: platformIds } } });
  await controlDb.platformNotificationPreference.deleteMany({ where: { userId: { in: platformIds } } });
  await controlDb.platformUser.deleteMany({ where: { id: { in: platformIds } } });
  await disconnectDatabases();
}

/** Remember a tenant created through the API so cleanup removes it. */
export function trackTenant(id: string) {
  created.tenants.push(id);
}

export interface ApiOptions {
  /** Bearer token (API clients) */
  token?: string;
  /** Cookie header (browsers) */
  cookie?: string;
  tenant?: string;
  body?: unknown;
}

export async function api(method: string, path: string, opts: ApiOptions = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.tenant) headers['x-tenant-id'] = opts.tenant;
  const res = await fetch(BASE + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

/**
 * Log in through /bff/auth/login like the browser does.
 * Returns the access token (for Bearer use) and the Cookie header to replay.
 */
export async function loginSession(slug: string, email: string) {
  const res = await api('POST', '/bff/auth/login', { body: { email, tenantSlug: slug, password: PASSWORD } });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.json)}`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  const access = cookies.find((c) => c.startsWith('access_token='));
  assert.ok(access, 'access_token cookie set');
  return { token: access.slice('access_token='.length), cookie: cookies.join('; '), body: res.json };
}

/** Bearer token only (API-client style). */
export async function login(t: TenantSeed, email: string) {
  return (await loginSession(t.slug, email)).token;
}

/**
 * An active support session for a platform user in a tenant, straight in the
 * database (the approval flow itself is tested in support.test.ts).
 */
export async function grantSupportSession(platformEmail: string, tenantId: string, access: 'READ_ONLY' | 'READ_WRITE' = 'READ_ONLY', permissions: string[] = []) {
  const { controlDb } = await db();
  const user = await controlDb.platformUser.findUniqueOrThrow({ where: { email: platformEmail } });
  const now = new Date();
  return controlDb.supportSession.create({
    data: {
      platformUserId: user.id, tenantId, approvedBy: user.id, approvedAt: now, reason: 'test fixture', access, permissions,
      durationMinutes: 60, validFrom: now, validTo: new Date(now.getTime() + 3_600_000), status: 'ACTIVE',
    },
  });
}

/** Wait until a tenant created through the API is provisioned (or failed). */
export async function waitForProvisioning(tenantId: string, timeoutMs = 30_000): Promise<string> {
  const { controlDb } = await db();
  const until = Date.now() + timeoutMs;
  for (;;) {
    const t = await controlDb.tenant.findUnique({ where: { id: tenantId }, select: { provisioningStatus: true, provisioningError: true } });
    if (!t) throw new Error('tenant disappeared');
    if (t.provisioningStatus === 'READY' || t.provisioningStatus === 'FAILED') return t.provisioningStatus;
    if (Date.now() > until) throw new Error(`still ${t.provisioningStatus} after ${timeoutMs}ms`);
    await sleep(100);
  }
}
