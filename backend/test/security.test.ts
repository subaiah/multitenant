/**
 * Security regression tests.
 *
 * Seeds two isolated tenants and exercises the attacks fixed in the security
 * PR through the public HTTP API (see helpers.ts for the harness).
 *
 *   DATABASE_URL=postgresql://... npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, api, db, login, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let B: TenantSeed;
let prisma: Awaited<ReturnType<typeof db>>['prisma'];
const run = Math.random().toString(36).slice(2, 10);

before(async () => {
  ({ prisma } = await db());
  A = await seedTenant('sec-a');
  B = await seedTenant('sec-b');
  await startServer();
});

after(stopServerAndCleanUp);

// ---------------------------------------------------------------- login

test('BFF login requires the correct password', async () => {
  const noPw = await api('POST', '/bff/auth/login', { body: { email: A.userEmail, tenantSlug: A.slug } });
  assert.equal(noPw.status, 400);
  const wrong = await api('POST', '/bff/auth/login', { body: { email: A.userEmail, tenantSlug: A.slug, password: 'nope' } });
  assert.equal(wrong.status, 401);
  await login(A, A.userEmail);
});

test('legacy /auth/login requires the correct password', async () => {
  const noPw = await api('POST', '/auth/login', { body: { email: A.userEmail, tenantId: A.tenantId } });
  assert.equal(noPw.status, 400);
  const wrong = await api('POST', '/auth/login', { body: { email: A.userEmail, tenantId: A.tenantId, password: 'nope' } });
  assert.equal(wrong.status, 401);
  const ok = await api('POST', '/auth/login', { body: { email: A.userEmail, tenantId: A.tenantId, password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token);
});

// ---------------------------------------------------------------- tenant isolation

test('a tenant user cannot read another tenant by switching x-tenant-id', async () => {
  const token = await login(A, A.userEmail);
  const own = await api('GET', '/users', { token, tenant: A.tenantId });
  assert.equal(own.status, 200);
  const other = await api('GET', '/users', { token, tenant: B.tenantId });
  assert.equal(other.status, 403);
});

test('a tenant admin cannot list, re-plan or delete other tenants', async () => {
  const token = await login(A, A.adminEmail);
  assert.equal((await api('GET', '/tenants', { token, tenant: A.tenantId })).status, 403);
  assert.equal((await api('GET', `/tenants/${B.tenantId}`, { token, tenant: A.tenantId })).status, 403);
  assert.equal((await api('DELETE', `/tenants/${B.tenantId}`, { token, tenant: A.tenantId })).status, 403);
  assert.equal((await api('PATCH', `/tenants/${A.tenantId}`, { token, tenant: A.tenantId, body: { plan: 'ENTERPRISE' } })).status, 403);
  const rename = await api('PATCH', `/tenants/${A.tenantId}`, { token, tenant: A.tenantId, body: { name: 'Renamed A' } });
  assert.equal(rename.status, 200);
  assert.ok(await prisma.tenant.findUnique({ where: { id: B.tenantId } }), 'tenant B still exists');
});

test('a tenant admin cannot modify another tenant\'s auth providers', async () => {
  const token = await login(A, A.adminEmail);
  const res = await api('PATCH', `/auth-config/providers/${B.providerId}`, { token, tenant: A.tenantId, body: { enabled: true } });
  assert.equal(res.status, 404);
  const del = await api('DELETE', `/auth-config/providers/${B.providerId}`, { token, tenant: A.tenantId });
  assert.equal(del.status, 404);
  assert.ok(await prisma.authProvider.findUnique({ where: { id: B.providerId } }), 'provider B still exists');
});

test('auth config never returns OAuth client secrets, and is admin-only', async () => {
  const token = await login(A, A.adminEmail);
  const res = await api('GET', '/auth-config', { token, tenant: A.tenantId });
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(res.json).includes('TOP-SECRET'));

  const userToken = await login(A, A.userEmail);
  assert.equal((await api('GET', '/auth-config', { token: userToken, tenant: A.tenantId })).status, 403);
});

// ---------------------------------------------------------------- privilege escalation

test('a manager cannot create platform admins or users above their rank', async () => {
  const token = await login(A, A.managerEmail);
  const platform = await api('POST', '/users', { token, tenant: A.tenantId, body: { email: `pa-${run}@x.test`, name: 'PA', userType: 'PLATFORM_ADMIN' } });
  assert.equal(platform.status, 400);
  const admin = await api('POST', '/users', { token, tenant: A.tenantId, body: { email: `ta-${run}@x.test`, name: 'TA', userType: 'TENANT_ADMIN' } });
  assert.equal(admin.status, 403);
  const user = await api('POST', '/users', { token, tenant: A.tenantId, body: { email: `tu-${run}@x.test`, name: 'TU', userType: 'TENANT_USER' } });
  assert.equal(user.status, 201);
});

test('users cannot change their own user type; admins cannot grant platform types', async () => {
  const adminToken = await login(A, A.adminEmail);
  const me = await prisma.user.findFirstOrThrow({ where: { email: A.adminEmail } });
  const self = await api('PATCH', `/users/${me.id}`, { token: adminToken, tenant: A.tenantId, body: { userType: 'TENANT_VIEWER' } });
  assert.equal(self.status, 403);

  const target = await prisma.user.findFirstOrThrow({ where: { email: A.userEmail } });
  const grant = await api('PATCH', `/users/${target.id}`, { token: adminToken, tenant: A.tenantId, body: { userType: 'PLATFORM_ADMIN' } });
  assert.equal(grant.status, 400);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).userType, 'TENANT_USER');
});

test('a regular user can edit their own name but not their type', async () => {
  const token = await login(A, A.userEmail);
  const me = await prisma.user.findFirstOrThrow({ where: { email: A.userEmail } });
  assert.equal((await api('PATCH', `/users/${me.id}`, { token, tenant: A.tenantId, body: { name: 'New Name' } })).status, 200);
  assert.equal((await api('PATCH', `/users/${me.id}`, { token, tenant: A.tenantId, body: { userType: 'TENANT_ADMIN' } })).status, 403);
});

test('changing an existing password requires the current password', async () => {
  const token = await login(A, A.userEmail);
  const res = await api('POST', '/auth/set-password', { token, body: { password: 'a-brand-new-password' } });
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------- OTP

test('OTP codes are not returned in responses outside development', async () => {
  const res = await api('POST', '/bff/auth/otp/request', { body: { email: B.userEmail, tenantSlug: B.slug } });
  assert.equal(res.status, 200);
  assert.equal(res.json.otp, undefined);
});

test('OTP verification is rate limited per account', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) {
    const code = String(100000 + i);
    statuses.push((await api('POST', '/bff/auth/otp/verify', { body: { email: A.userEmail, tenantSlug: A.slug, code } })).status);
  }
  assert.ok(statuses.slice(0, 5).every((s) => s === 401), `first attempts rejected: ${statuses}`);
  assert.equal(statuses.at(-1), 429, `later attempts throttled: ${statuses}`);
});
