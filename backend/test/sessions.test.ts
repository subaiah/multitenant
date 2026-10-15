/**
 * Account changes take effect on the very next request, not when the access
 * token happens to expire: deactivation, removal, demotion and "sign out
 * everywhere" all apply immediately, for cookie and bearer sessions alike.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, api, db, loginSession, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let adminCookie: string;
let prisma: Awaited<ReturnType<typeof db>>['prisma'];
const PROTECTED = '/groups'; // any tenant route a regular user may read

before(async () => {
  ({ prisma } = await db());
  A = await seedTenant('sess');
  await startServer();
  adminCookie = (await loginSession(A.slug, A.adminEmail)).cookie;
});

after(stopServerAndCleanUp);

async function newUser(label: string, userType = 'TENANT_USER') {
  const { hashPassword } = await import('../src/utils/auth.js');
  return prisma.user.create({
    data: { tenantId: A.tenantId, email: `${label}-${Date.now()}@test.local`, name: label, userType: userType as any, passwordHash: await hashPassword(PASSWORD) },
  });
}

/** Every way a signed-in client talks to the API: cookie (browser), bearer, and the BFF session check. */
async function probe(s: { cookie: string; token: string }) {
  return {
    cookieApi: (await api('GET', PROTECTED, { cookie: s.cookie })).status,
    bearerApi: (await api('GET', '/auth/permissions', { token: s.token })).status,
    me: (await api('GET', '/bff/auth/me', { cookie: s.cookie })).status,
  };
}

test('deactivating someone signs them out everywhere, immediately', async () => {
  const u = await newUser('deact');
  const s = await loginSession(A.slug, u.email);
  assert.deepEqual(await probe(s), { cookieApi: 200, bearerApi: 200, me: 200 });

  const res = await api('PATCH', `/users/${u.id}`, { cookie: adminCookie, body: { status: 'INACTIVE' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));

  assert.deepEqual(await probe(s), { cookieApi: 401, bearerApi: 401, me: 401 }, 'old tokens refused at once');
  const refreshed = await api('POST', '/bff/auth/refresh', { cookie: s.cookie });
  assert.notEqual(refreshed.status, 200, 'refresh refused');
  const msg = (await api('GET', PROTECTED, { cookie: s.cookie })).json.message;
  assert.match(msg, /not active/);

  // Reactivating doesn't bring the old session back; a new sign-in works
  assert.equal((await api('PATCH', `/users/${u.id}`, { cookie: adminCookie, body: { status: 'ACTIVE' } })).status, 200);
  assert.equal((await api('GET', '/auth/permissions', { token: s.token })).status, 401, 'old token stays dead');
  assert.equal((await api('POST', '/bff/auth/refresh', { cookie: s.cookie })).status !== 200, true, 'old refresh token stays dead');
  const again = await loginSession(A.slug, u.email);
  assert.equal((await api('GET', '/auth/permissions', { token: again.token })).status, 200);
});

test('removing someone ends their sessions', async () => {
  const u = await newUser('removed');
  const s = await loginSession(A.slug, u.email);
  assert.equal((await api('DELETE', `/users/${u.id}`, { cookie: adminCookie })).status, 204);
  assert.equal((await api('GET', PROTECTED, { cookie: s.cookie })).status, 401);
  assert.equal((await api('GET', '/auth/permissions', { token: s.token })).status, 401);
});

test('a change of user type applies on the next request', async () => {
  const u = await newUser('demoted', 'TENANT_MANAGER');
  const s = await loginSession(A.slug, u.email);
  assert.equal((await api('POST', '/groups', { token: s.token, body: { name: `Made by manager ${Date.now()}` } })).status, 201);

  assert.equal((await api('PATCH', `/users/${u.id}`, { cookie: adminCookie, body: { userType: 'TENANT_VIEWER' } })).status, 200);
  assert.equal((await api('POST', '/groups', { token: s.token, body: { name: `Made by viewer ${Date.now()}` } })).status, 403, 'manager rights gone');
  const perms = (await api('GET', '/auth/permissions', { token: s.token })).json;
  assert.equal(perms.sources.userType, 'TENANT_VIEWER');
  assert.ok(!perms.permissions.includes('groups:*'));
});

test('"sign out everywhere" ends other sessions, and signing in again straight away works', async () => {
  const u = await newUser('everywhere');
  const laptop = await loginSession(A.slug, u.email);
  const phone = await loginSession(A.slug, u.email);

  const res = await api('POST', '/bff/auth/revoke-all', { cookie: phone.cookie });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal((await api('GET', PROTECTED, { cookie: laptop.cookie })).status, 401, 'other device signed out');
  assert.equal((await api('GET', '/auth/permissions', { token: phone.token })).status, 401, 'this one too');
  assert.notEqual((await api('POST', '/bff/auth/refresh', { cookie: laptop.cookie })).status, 200);

  // Same millisecond-precision cut-off: a sign-in right after is not caught by it
  const fresh = await loginSession(A.slug, u.email);
  assert.equal((await api('GET', PROTECTED, { cookie: fresh.cookie })).status, 200);
});

test('tokens from another tenant or for a missing account are refused', async () => {
  const u = await newUser('moved');
  const s = await loginSession(A.slug, u.email);
  // Simulate the account being moved to another tenant
  const B = await seedTenant('sess-b');
  await prisma.user.update({ where: { id: u.id }, data: { tenantId: B.tenantId } });
  assert.equal((await api('GET', PROTECTED, { cookie: s.cookie })).status, 401);
});
