/**
 * Groups and role assignments: access granted through them takes effect,
 * nobody can hand out (or take away) access they don't hold themselves, and
 * everything stays inside the caller's tenant.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, login, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let B: TenantSeed;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};
const roles: Record<string, string> = {};

const as = (who: string) => ({ token: tok[who] });

before(async () => {
  A = await seedTenant('acm');
  B = await seedTenant('acm-b');
  await startServer();
  tok.admin = await login(A, A.adminEmail);
  tok.manager = await login(A, A.managerEmail);
  tok.user = await login(A, A.userEmail);
  tok.adminB = await login(B, B.adminEmail);

  for (const [t, k] of [[A, 'admin'], [B, 'adminB']] as const) {
    const init = await api('POST', `/roles/initialize/${t.tenantId}`, as(k));
    assert.equal(init.status, 200, JSON.stringify(init.json));
  }
  const { tenantDb, controlDb } = await db();
  for (const u of await tenantDb.user.findMany({ where: { tenantId: A.tenantId } })) ids[u.email] = u.id;
  const list = await api('GET', '/roles', as('admin'));
  for (const r of list.json.roles) roles[r.name] = r.id;
  assert.ok(roles['Tenant Admin'] && roles['Tenant Manager'] && roles['Viewer']);
});

after(stopServerAndCleanUp);

async function createGroup(name: string, who = 'admin') {
  const res = await api('POST', '/groups', { ...as(who), body: { name } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id as string;
}

test('a role assigned to a group reaches its members, and stops when the group is deactivated', async () => {
  const group = await createGroup('Reviewers');
  assert.equal((await api('GET', '/roles', as('user'))).status, 403, 'regular user starts without roles:read');

  assert.equal((await api('POST', `/groups/${group}/members`, { ...as('admin'), body: { userId: ids[A.userEmail] } })).status, 201);
  const assign = await api('POST', '/roles/assign', { ...as('admin'), body: { roleId: roles['Tenant Manager'], principalType: 'GROUP', groupId: group } });
  assert.equal(assign.status, 201, JSON.stringify(assign.json));
  assert.equal(assign.json.scopeId, A.tenantId, 'tenant scope defaults to the current tenant');

  assert.equal((await api('GET', '/roles', as('user'))).status, 200, 'member gains the role');

  const detail = await api('GET', `/groups/${group}`, as('admin'));
  assert.equal(detail.json.members.length, 1);
  assert.equal(detail.json.roleAssignments[0].roleName, 'Tenant Manager');
  assert.equal(detail.json.roleAssignments[0].state, 'ACTIVE');
  assert.ok(detail.json.grants.includes('users:create'));

  const listed = (await api('GET', '/groups', as('admin'))).json.groups.find((g: any) => g.id === group);
  assert.deepEqual(listed.roles, ['Tenant Manager']);

  assert.equal((await api('PATCH', `/groups/${group}`, { ...as('admin'), body: { status: 'INACTIVE' } })).status, 200);
  assert.equal((await api('GET', '/roles', as('user'))).status, 403, 'inactive group grants nothing');
  assert.equal((await api('PATCH', `/groups/${group}`, { ...as('admin'), body: { status: 'ACTIVE' } })).status, 200);
  assert.equal((await api('GET', '/roles', as('user'))).status, 200);

  // Removing the member takes it away again
  assert.equal((await api('DELETE', `/groups/${group}/members/${ids[A.userEmail]}`, as('admin'))).status, 204);
  assert.equal((await api('GET', '/roles', as('user'))).status, 403);
  assert.equal((await api('DELETE', `/groups/${group}/members/${ids[A.userEmail]}`, as('admin'))).status, 404, 'not a member any more');
});

test("a manager can manage groups but can't use them to gain admin rights", async () => {
  const admins = await createGroup('Admins');
  assert.equal((await api('POST', '/roles/assign', { ...as('admin'), body: { roleId: roles['Tenant Admin'], principalType: 'GROUP', groupId: admins } })).status, 201);

  const self = await api('POST', `/groups/${admins}/members`, { ...as('manager'), body: { userId: ids[A.managerEmail] } });
  assert.equal(self.status, 403, 'manager cannot join the admin group');
  assert.match(self.json.message, /permissions you don't have/);
  assert.equal((await api('POST', `/groups/${admins}/members`, { ...as('manager'), body: { userId: ids[A.userEmail] } })).status, 403, 'nor add others');
  assert.equal((await api('PATCH', `/groups/${admins}`, { ...as('manager'), body: { status: 'INACTIVE' } })).status, 403, 'nor switch it off');

  assert.equal((await api('POST', `/groups/${admins}/members`, { ...as('admin'), body: { userId: ids[A.userEmail] } })).status, 201);
  assert.equal((await api('DELETE', `/groups/${admins}/members/${ids[A.userEmail]}`, as('manager'))).status, 403, 'nor remove admins');
  assert.equal((await api('DELETE', `/groups/${admins}/members/${ids[A.userEmail]}`, as('admin'))).status, 204);

  // Groups whose roles the manager already covers are fine
  const plain = await createGroup('Project X', 'manager');
  assert.equal((await api('POST', `/groups/${plain}/members`, { ...as('manager'), body: { userId: ids[A.userEmail] } })).status, 201);
  assert.equal((await api('POST', '/roles/assign', { ...as('manager'), body: { roleId: roles['Viewer'], principalType: 'GROUP', groupId: plain } })).status, 403, 'manager lacks roles:assign');
});

test("roles:assign can't hand out more than the assigner holds", async () => {
  // A delegated "assigner" role, given to the regular user
  const created = await api('POST', '/roles', { ...as('admin'), body: { name: 'Access Coordinator', permissions: ['roles:read', 'roles:assign'] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal((await api('POST', '/roles/assign', { ...as('admin'), body: { roleId: created.json.id, principalType: 'USER', userId: ids[A.userEmail] } })).status, 201);

  const escalate = await api('POST', '/roles/assign', { ...as('user'), body: { roleId: roles['Tenant Admin'], principalType: 'USER', userId: ids[A.userEmail] } });
  assert.equal(escalate.status, 403, 'cannot make themselves admin');

  const viewer = await api('POST', '/roles/assign', { ...as('user'), body: { roleId: roles['Viewer'], principalType: 'USER', userId: ids[A.managerEmail] } });
  assert.equal(viewer.status, 201, 'can assign a role within their own permissions');
  assert.equal((await api('DELETE', `/roles/assignments/${viewer.json.id}`, as('user'))).status, 204);

  // ...and can't take away admin either
  const adminAssignment = await api('POST', '/roles/assign', { ...as('admin'), body: { roleId: roles['Tenant Admin'], principalType: 'USER', userId: ids[A.managerEmail] } });
  assert.equal((await api('DELETE', `/roles/assignments/${adminAssignment.json.id}`, as('user'))).status, 403);
  assert.equal((await api('DELETE', `/roles/assignments/${adminAssignment.json.id}`, as('admin'))).status, 204);
});

test('assignment validation: scope, dates, duplicates', async () => {
  const body = { roleId: roles['Viewer'], principalType: 'USER', userId: ids[A.managerEmail] };
  const { tenantDb, controlDb } = await db();
  const orgB = await tenantDb.organization.create({ data: { tenantId: B.tenantId, name: 'B Org' } });
  const orgA = await tenantDb.organization.create({ data: { tenantId: A.tenantId, name: 'A Org' } });

  assert.equal((await api('POST', '/roles/assign', { ...as('admin'), body: { ...body, scopeType: 'ORGANIZATION', scopeId: orgB.id } })).status, 404, "another tenant's organization");
  assert.equal((await api('POST', '/roles/assign', { ...as('admin'), body: { ...body, scopeType: 'ORGANIZATION' } })).status, 400, 'scope id required');
  assert.equal((await api('POST', '/roles/assign', { ...as('admin'), body: { ...body, scopeType: 'TENANT', scopeId: B.tenantId } })).status, 400);
  const org = await api('POST', '/roles/assign', { ...as('admin'), body: { ...body, scopeType: 'ORGANIZATION', scopeId: orgA.id } });
  assert.equal(org.status, 201);

  const past = { validFrom: '2030-02-01T00:00:00.000Z', validTo: '2030-01-01T00:00:00.000Z' };
  assert.equal((await api('POST', '/roles/assign', { ...as('admin'), body: { ...body, ...past } })).status, 400, 'end before start');

  const scheduled = await api('POST', '/roles/assign', { ...as('admin'), body: { ...body, validFrom: '2030-01-01T00:00:00.000Z' } });
  assert.equal(scheduled.status, 201);
  assert.equal((await api('POST', '/roles/assign', { ...as('admin'), body })).status, 409, 'duplicate');

  const list = (await api('GET', '/roles/assignments', as('admin'))).json.assignments;
  assert.equal(list.find((a: any) => a.id === org.json.id).scopeName, 'A Org');
  assert.equal(list.find((a: any) => a.id === scheduled.json.id).state, 'SCHEDULED');

  const scopes = await api('GET', '/roles/scopes', as('admin'));
  assert.equal(scopes.json.tenant.id, A.tenantId);
  assert.deepEqual(scopes.json.organizations.map((o: any) => o.name), ['A Org']);
});

test("roles can't include platform permissions or permissions the editor lacks", async () => {
  const platform = await api('POST', '/roles', { ...as('admin'), body: { name: 'Sneaky', permissions: ['tenants:delete'] } });
  assert.equal(platform.status, 400);
  const wildcard = await api('POST', '/roles', { ...as('admin'), body: { name: 'Sneaky 2', permissions: ['*:*'] } });
  assert.equal(wildcard.status, 400);
});

test('everything stays inside the tenant', async () => {
  const group = await createGroup('A only');
  assert.equal((await api('GET', `/groups/${group}`, as('adminB'))).status, 404);
  assert.equal((await api('PATCH', `/groups/${group}`, { ...as('adminB'), body: { name: 'Taken over' } })).status, 404);
  assert.equal((await api('DELETE', `/groups/${group}`, as('adminB'))).status, 404);
  assert.equal((await api('GET', `/roles/${roles['Tenant Admin']}`, as('adminB'))).status, 404);
  assert.equal((await api('PATCH', `/roles/${roles['Viewer']}`, { ...as('adminB'), body: { description: 'x' } })).status, 404);
  const bRoles = (await api('GET', '/roles', as('adminB'))).json.roles;
  assert.ok(bRoles.every((r: any) => r.tenantId === B.tenantId));
  assert.equal((await api('GET', `/roles?tenantId=${A.tenantId}`, as('adminB'))).status, 403);
});

test('groups: unique names, delete only when empty', async () => {
  const group = await createGroup('Temp');
  assert.equal((await api('POST', '/groups', { ...as('admin'), body: { name: 'Temp' } })).status, 409);
  const other = await createGroup('Temp 2');
  assert.equal((await api('PATCH', `/groups/${other}`, { ...as('admin'), body: { name: 'Temp' } })).status, 409);

  assert.equal((await api('POST', `/groups/${group}/members`, { ...as('admin'), body: { userId: ids[A.userEmail] } })).status, 201);
  assert.equal((await api('DELETE', `/groups/${group}`, as('admin'))).status, 400);
  assert.equal((await api('DELETE', `/groups/${group}/members/${ids[A.userEmail]}`, as('admin'))).status, 204);
  assert.equal((await api('DELETE', `/groups/${group}`, as('admin'))).status, 204);
});
