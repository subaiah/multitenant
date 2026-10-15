/**
 * Shared harness for integration tests: starts the real server against real
 * Postgres databases (DATABASE_URL for the control plane, TENANT_DATABASE_URL
 * for the shared tenant database, both schemas already pushed) and seeds
 * isolated data with unique names per run, so test files can run in parallel.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

process.env.JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret-1234';
process.env.NODE_ENV = 'test';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must point at a test control-plane database');
if (!process.env.TENANT_DATABASE_URL) throw new Error('TENANT_DATABASE_URL must point at a test tenant database');

export const PASSWORD = 'correct-horse-battery';
const PORT = 4000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const run = randomUUID().slice(0, 8);

export type TenantSeed = {
  tenantId: string;
  slug: string;
  adminEmail: string;
  managerEmail: string;
  userEmail: string;
  providerId: string;
};
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

export async function seedTenant(label: string): Promise<TenantSeed> {
  const { controlDb, tenantDb } = await db();
  const { hashPassword } = await import('../src/utils/auth.js');
  const passwordHash = await hashPassword(PASSWORD);
  const slug = `t-${label}-${run}`;
  const tenant = await controlDb.tenant.create({ data: { name: `Test ${label}`, slug, plan: 'FREE', status: 'ACTIVE' } });
  created.tenants.push(tenant.id);
  const seed = {
    tenantId: tenant.id,
    slug,
    adminEmail: `admin-${label}-${run}@test.local`,
    managerEmail: `manager-${label}-${run}@test.local`,
    userEmail: `user-${label}-${run}@test.local`,
  };
  await tenantDb.user.createMany({
    data: [
      { tenantId: tenant.id, email: seed.adminEmail, name: 'Admin', userType: 'TENANT_ADMIN', passwordHash },
      { tenantId: tenant.id, email: seed.managerEmail, name: 'Manager', userType: 'TENANT_MANAGER', passwordHash },
      { tenantId: tenant.id, email: seed.userEmail, name: 'User', userType: 'TENANT_USER', passwordHash },
    ],
  });
  const authConfig = await tenantDb.authConfig.create({ data: { tenantId: tenant.id, otpEnabled: true } });
  const provider = await tenantDb.authProvider.create({
    data: { tenantId: tenant.id, authConfigId: authConfig.id, provider: 'GOOGLE', clientId: 'cid', clientSecret: 'TOP-SECRET', scopes: ['email'] },
  });
  return { ...seed, providerId: provider.id };
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
  for (let i = 0; i < 100; i++) {
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
  const { deleteTenantData } = await import('../src/lib/tenant-data.js');
  const platformUsers = await controlDb.platformUser.findMany({ where: { email: { in: created.platformEmails } }, select: { id: true } });
  const platformIds = platformUsers.map((u) => u.id);
  await controlDb.platformRefreshToken.deleteMany({ where: { userId: { in: platformIds } } });
  await controlDb.platformActivity.deleteMany({ where: { OR: [{ userId: { in: platformIds } }, { tenantId: { in: created.tenants } }] } });
  await controlDb.platformUser.deleteMany({ where: { id: { in: platformIds } } });
  // The tenant plane has no foreign keys to tenants: delete its rows explicitly
  for (const id of created.tenants) await deleteTenantData(id);
  const tenantIds = { tenantId: { in: created.tenants } };
  await controlDb.supportSession.deleteMany({ where: tenantIds });
  await controlDb.tenantApplication.deleteMany({ where: tenantIds });
  await controlDb.databaseConfig.deleteMany({ where: tenantIds });
  await controlDb.tenant.deleteMany({ where: { id: { in: created.tenants } } });
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
