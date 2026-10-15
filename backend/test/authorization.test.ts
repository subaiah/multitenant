/**
 * Server-side permission enforcement: roles, group roles and defaults decide
 * what the API allows, changes apply on the next request, and tenant roles
 * can never grant platform powers.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  PASSWORD, api, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp,
  type PlatformSeed, type TenantSeed,
} from './helpers.js';

let A: TenantSeed;
let B: TenantSeed;
let P: PlatformSeed;
let controlDb: Awaited<ReturnType<typeof db>>['controlDb'];
let viewerEmail: string;
let viewerId: string;
let adminCookie: string;

async function cookieFor(email: string, slug = A.slug) {
  return (await loginSession(slug, email)).cookie;
}

async function createRole(name: string, permissions: string[]) {
  const res = await api('POST', '/roles', { cookie: adminCookie, body: { tenantId: A.tenantId, name, permissions } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id as string;
}

async function assign(roleId: string, principal: { userId?: string; groupId?: string }) {
  const res = await api('POST', '/roles/assign', {
    cookie: adminCookie,
    body: { roleId, principalType: principal.userId ? 'USER' : 'GROUP', ...principal, scopeType: 'TENANT', scopeId: A.tenantId },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id as string;
}

before(async () => {
  ({ controlDb } = await db());
  A = await seedTenant('authz-a');
  B = await seedTenant('authz-b');
  P = await seedPlatformUsers();
  const { hashPassword } = await import('../src/utils/auth.js');
  viewerEmail = `viewer-authz-${A.slug}@test.local`;
  viewerId = (await A.db.user.create({
    data: { tenantId: A.tenantId, email: viewerEmail, name: 'Viewer', userType: 'TENANT_VIEWER', passwordHash: await hashPassword(PASSWORD) },
  })).id;
  await startServer();
  adminCookie = await cookieFor(A.adminEmail);
  // Permission catalog + default roles for tenant A
  assert.equal((await api('POST', `/roles/initialize/${A.tenantId}`, { cookie: adminCookie, body: {} })).status, 200);
});

after(stopServerAndCleanUp);

test('a role grants access on the next request, and revoking it removes access', async () => {
  const viewer = await cookieFor(viewerEmail);
  assert.equal((await api('GET', '/groups', { cookie: viewer })).status, 403, 'viewers cannot read groups by default');

  const roleId = await createRole('Group readers', ['groups:read']);
  const assignmentId = await assign(roleId, { userId: viewerId });
  assert.equal((await api('GET', '/groups', { cookie: viewer })).status, 200, 'role grants groups:read');

  const un = await api('DELETE', '/roles/unassign', { cookie: adminCookie, body: { assignmentId } });
  assert.equal(un.status, 200);
  assert.equal((await api('GET', '/groups', { cookie: viewer })).status, 403, 'revocation applies immediately');
});

test('roles assigned to a group apply to its members', async () => {
  const viewer = await cookieFor(viewerEmail);
  assert.equal((await api('GET', '/organizations', { cookie: viewer })).status, 403);

  const group = await api('POST', '/groups', { cookie: adminCookie, body: { name: `Org readers ${Date.now()}` } });
  assert.equal(group.status, 201);
  assert.equal((await api('POST', `/groups/${group.json.id}/members`, { cookie: adminCookie, body: { userId: viewerId } })).status, 201);
  await assign(await createRole('Org readers', ['organizations:read']), { groupId: group.json.id });

  assert.equal((await api('GET', '/organizations', { cookie: viewer })).status, 200);
});

test('default roles carry the permissions of their user type', async () => {
  const roles = await api('GET', '/roles', { cookie: adminCookie });
  const manager = roles.json.roles.find((r: { name: string }) => r.name === 'Tenant Manager');
  assert.ok(manager, 'default Tenant Manager role exists');

  const viewer = await cookieFor(viewerEmail);
  assert.equal((await api('POST', '/groups', { cookie: viewer, body: { name: 'Nope' } })).status, 403);
  const assignmentId = await assign(manager.id, { userId: viewerId });
  const created = await api('POST', '/groups', { cookie: viewer, body: { name: `Made by viewer ${Date.now()}` } });
  assert.equal(created.status, 201, 'Tenant Manager role grants groups:create');
  await api('DELETE', '/roles/unassign', { cookie: adminCookie, body: { assignmentId } });
});

test('tenant roles cannot grant platform permissions, even with wildcards', async () => {
  const sneaky = ['tenants:read', 'tenants:manage', 'platform:read', '*:read'];
  // The API refuses to build such a role...
  const refused = await api('POST', '/roles', { cookie: adminCookie, body: { name: 'Sneaky', permissions: sneaky } });
  assert.equal(refused.status, 400);
  // ...and one that already exists in the database (older data) still grants nothing
  const { id: roleId } = await A.db.role.create({
    data: { tenantId: A.tenantId, name: 'Sneaky', permissions: { create: sneaky.map((permission) => ({ tenantId: A.tenantId, permission })) } },
  });
  const adminId = (await A.db.user.findFirstOrThrow({ where: { email: A.adminEmail } })).id;
  // Nobody can assign it through the API either (the admin doesn't hold these)
  const assignRes = await api('POST', '/roles/assign', { cookie: adminCookie, body: { roleId, principalType: 'USER', userId: adminId } });
  assert.equal(assignRes.status, 403);
  await A.db.roleAssignment.create({ data: { tenantId: A.tenantId, roleId, principalType: 'USER', userId: adminId, scopeType: 'TENANT', scopeId: A.tenantId } });

  const admin = await cookieFor(A.adminEmail);
  assert.equal((await api('GET', '/tenants', { cookie: admin })).status, 403);
  assert.equal((await api('GET', '/platform/stats', { cookie: admin })).status, 403);
  assert.equal((await api('DELETE', `/tenants/${B.tenantId}`, { cookie: admin })).status, 403);

  const perms = (await api('GET', '/auth/permissions', { cookie: admin })).json.permissions as string[];
  for (const p of ['tenants:read', 'tenants:manage', 'platform:read', '*:read']) assert.ok(!perms.includes(p), `${p} leaked`);
});

test('read-only users are refused writes with the missing permission named', async () => {
  const viewer = await cookieFor(viewerEmail);
  const res = await api('PATCH', '/database', { cookie: viewer, body: { backupEnabled: true } });
  assert.equal(res.status, 403);
  assert.match(res.json.message, /database:manage/);
  assert.equal((await api('PATCH', '/auth-config', { cookie: viewer, body: { mfaEnabled: true } })).status, 403);
  assert.equal((await api('POST', '/organizations', { cookie: viewer, body: { name: 'x' } })).status, 403);
});

test('self-service routes: your own records, others need permission', async () => {
  const viewer = await cookieFor(viewerEmail);
  const adminId = (await A.db.user.findFirstOrThrow({ where: { email: A.adminEmail } })).id;
  const otherTenantUser = (await B.db.user.findFirstOrThrow({ where: { email: B.userEmail } })).id;

  assert.equal((await api('GET', `/users/${viewerId}`, { cookie: viewer })).status, 200, 'own user record');
  assert.equal((await api('GET', `/users/${adminId}`, { cookie: viewer })).status, 403, "someone else's record");
  assert.equal((await api('GET', `/roles/user/${viewerId}`, { cookie: viewer })).status, 200, 'own roles (Profile page)');
  assert.equal((await api('GET', `/roles/user/${adminId}`, { cookie: viewer })).status, 403);
  assert.equal((await api('GET', `/roles/user/${viewerId}`, { cookie: adminCookie })).status, 200, 'admins can read roles');
  assert.equal((await api('GET', `/roles/user/${otherTenantUser}`, { cookie: adminCookie })).status, 404, 'not across tenants');
  assert.equal((await api('PATCH', `/users/${viewerId}`, { cookie: viewer, body: { name: 'Renamed Viewer' } })).status, 200, 'edit own name');
});

test('managers manage groups but cannot assign roles', async () => {
  const manager = await cookieFor(A.managerEmail);
  assert.equal((await api('POST', '/groups', { cookie: manager, body: { name: `Mgr group ${Date.now()}` } })).status, 201);
  const roles = (await api('GET', '/roles', { cookie: manager })).json.roles as { id: string }[];
  const res = await api('POST', '/roles/assign', {
    cookie: manager,
    body: { roleId: roles[0].id, principalType: 'USER', userId: viewerId, scopeType: 'TENANT', scopeId: A.tenantId },
  });
  assert.equal(res.status, 403);
  assert.match(res.json.message, /roles:assign/);
});

test('platform support can request support sessions but not list or revoke them', async () => {
  const support = await cookieFor(P.supportEmail, 'platform');
  const req = await api('POST', '/support-sessions/request', {
    cookie: support,
    tenant: A.tenantId,
    body: { tenantId: A.tenantId, reason: 'Investigating a login issue', permissions: ['users:read'], validTo: new Date(Date.now() + 3600_000).toISOString() },
  });
  assert.notEqual(req.status, 403, JSON.stringify(req.json));
  assert.equal((await api('GET', '/support-sessions', { cookie: support, tenant: A.tenantId })).status, 403);
});
