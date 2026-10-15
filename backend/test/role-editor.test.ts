/**
 * Role editor API: the permission catalog, creating and editing custom roles,
 * built-in roles staying fixed, and editors limited to their own access.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, login, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};
const roles: Record<string, string> = {};
const as = (who: string) => ({ token: tok[who] });

before(async () => {
  A = await seedTenant('roled');
  await startServer();
  tok.admin = await login(A, A.adminEmail);
  tok.manager = await login(A, A.managerEmail);
  tok.user = await login(A, A.userEmail);
  assert.equal((await api('POST', `/roles/initialize/${A.tenantId}`, as('admin'))).status, 200);
  for (const u of await A.db.user.findMany({ where: { tenantId: A.tenantId } })) ids[u.email] = u.id;
  for (const r of (await api('GET', '/roles', as('admin'))).json.roles) roles[r.name] = r.id;
});

after(stopServerAndCleanUp);

const permsOf = async (id: string) =>
  ((await api('GET', `/roles/${id}`, as('admin'))).json.permissions as any[]).map((p) => p.permission).sort();

test('catalog lists only tenant permissions, grouped and described', async () => {
  const res = await api('GET', '/roles/catalog', as('manager'));
  assert.equal(res.status, 200);
  const all = res.json.resources.flatMap((r: any) => r.permissions.map((p: any) => p.name));
  assert.ok(all.includes('users:create') && all.includes('roles:assign'));
  for (const p of ['tenants:read', 'platform:read', 'support:request', 'menus:manage']) assert.ok(!all.includes(p), `${p} offered`);
  const users = res.json.resources.find((r: any) => r.resource === 'users');
  assert.equal(users.label, 'Users');
  assert.equal(users.permissions.find((p: any) => p.name === 'users:create').description, 'Invite people');
  assert.equal((await api('GET', '/roles/catalog', as('user'))).status, 200, 'descriptions only; any signed-in user');
  assert.equal((await api('GET', '/roles/catalog')).status, 401);
});

test('create, edit and delete a custom role; holders see changes immediately', async () => {
  const created = await api('POST', '/roles', { ...as('admin'), body: { name: '  Auditor ', description: 'Reads the audit trail', permissions: ['activity:read', 'dashboard:view'] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.name, 'Auditor');
  const id = created.json.id;
  assert.deepEqual(await permsOf(id), ['activity:read', 'dashboard:view']);

  assert.equal((await api('POST', '/roles', { ...as('admin'), body: { name: 'auditor' } })).status, 409, 'names are unique, ignoring case');
  assert.equal((await api('POST', '/roles', { ...as('admin'), body: { name: 'Typo', permissions: ['users:fly'] } })).status, 400);

  // Give it to the regular user, then add roles:read to the role
  assert.equal((await api('POST', '/roles/assign', { ...as('admin'), body: { roleId: id, principalType: 'USER', userId: ids[A.userEmail] } })).status, 201);
  assert.equal((await api('GET', '/roles', as('user'))).status, 403);
  const edited = await api('PATCH', `/roles/${id}`, { ...as('admin'), body: { name: 'Auditor (read-only)', description: '', permissions: ['activity:read', 'roles:read'] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(edited.json.description, null);
  assert.deepEqual(await permsOf(id), ['activity:read', 'roles:read']);
  assert.equal((await api('GET', '/roles', as('user'))).status, 200, 'holder gains the added permission');

  // The change is in the activity log with what was added and removed
  const log = await A.db.activity.findFirst({ where: { tenantId: A.tenantId, action: 'updated role' }, orderBy: { createdAt: 'desc' } });
  assert.match(log!.target, /\+roles:read/);
  assert.match(log!.target, /-dashboard:view/);

  // Can't rename onto another role
  assert.equal((await api('PATCH', `/roles/${id}`, { ...as('admin'), body: { name: 'viewer' } })).status, 409);

  // Delete only once unassigned
  assert.equal((await api('DELETE', `/roles/${id}`, as('admin'))).status, 400);
  const assignment = (await api('GET', '/roles/assignments', as('admin'))).json.assignments.find((a: any) => a.roleId === id);
  assert.equal((await api('DELETE', `/roles/assignments/${assignment.id}`, as('admin'))).status, 204);
  assert.equal((await api('DELETE', `/roles/${id}`, as('admin'))).status, 204);
  assert.equal((await api('GET', `/roles/${id}`, as('admin'))).status, 404);
});

test('built-in roles cannot be changed or deleted', async () => {
  const res = await api('PATCH', `/roles/${roles['Viewer']}`, { ...as('admin'), body: { permissions: ['users:delete'] } });
  assert.equal(res.status, 403);
  assert.match(res.json.message, /Duplicate/);
  assert.equal((await api('DELETE', `/roles/${roles['Viewer']}`, as('admin'))).status, 403);
});

test("a delegated role editor can't build or edit roles beyond their own access", async () => {
  const editor = await api('POST', '/roles', { ...as('admin'), body: { name: 'Role Editor', permissions: ['roles:read', 'roles:manage', 'users:read', 'groups:read'] } });
  assert.equal((await api('POST', '/roles/assign', { ...as('admin'), body: { roleId: editor.json.id, principalType: 'USER', userId: ids[A.userEmail] } })).status, 201);

  const ok = await api('POST', '/roles', { ...as('user'), body: { name: 'Directory reader', permissions: ['users:read', 'groups:read'] } });
  assert.equal(ok.status, 201, 'within their access');
  const tooMuch = await api('POST', '/roles', { ...as('user'), body: { name: 'Deleter', permissions: ['users:delete'] } });
  assert.equal(tooMuch.status, 403);
  assert.match(tooMuch.json.message, /users:delete/);
  assert.equal((await api('PATCH', `/roles/${ok.json.id}`, { ...as('user'), body: { permissions: ['users:read', 'users:delete'] } })).status, 403, "can't add what they lack");

  const adminMade = await api('POST', '/roles', { ...as('admin'), body: { name: 'Billing', permissions: ['settings:manage'] } });
  assert.equal((await api('PATCH', `/roles/${adminMade.json.id}`, { ...as('user'), body: { permissions: [] } })).status, 403, "can't strip a role that grants more than they have");
  assert.equal((await api('PATCH', `/roles/${adminMade.json.id}`, { ...as('user'), body: { description: 'Billing admins' } })).status, 200, 'renaming/describing is fine');

  assert.equal((await api('POST', '/roles', { ...as('manager'), body: { name: 'Nope' } })).status, 403, 'managers lack roles:manage');
});

test('setting up default roles is safe to run concurrently', async () => {
  const C = await seedTenant('roled-race');
  const t = await login(C, C.adminEmail);
  const results = await Promise.all(Array.from({ length: 4 }, () => api('POST', `/roles/initialize/${C.tenantId}`, { token: t })));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200], JSON.stringify(results.map((r) => r.json)));
  const names = (await api('GET', '/roles', { token: t })).json.roles.map((r: any) => r.name).sort();
  assert.deepEqual(names, ['Developer', 'Tenant Admin', 'Tenant Manager', 'User', 'Viewer']);
});
