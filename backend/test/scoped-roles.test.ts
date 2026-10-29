/**
 * Roles given for part of a tenant (lib/scopes.ts): an assignment for one
 * organization or unit grants its permissions there only, never tenant-wide.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, loginSession, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let admin: string;
let viewer: string;
let viewerId: string;
let role: string;
const org: Record<string, string> = {};
const unit: Record<string, string> = {};

const as = (cookie: string, body?: unknown) => ({ cookie, ...(body === undefined ? {} : { body }) });

before(async () => {
  A = await seedTenant('scope');
  await startServer();
  admin = (await loginSession(A.slug, A.adminEmail)).cookie;
  // A viewer: no organization permissions of their own
  const template = await A.db.user.findFirstOrThrow({ where: { tenantId: A.tenantId, email: A.userEmail } });
  const v = await A.db.user.create({ data: { tenantId: A.tenantId, email: `viewer-${A.slug}@test.local`, name: 'Viewer', userType: 'TENANT_VIEWER', status: 'ACTIVE', passwordHash: template.passwordHash } });
  viewerId = v.id;
  viewer = (await loginSession(A.slug, v.email)).cookie;

  for (const name of ['North', 'South']) org[name] = (await api('POST', '/organizations', as(admin, { name }))).json.id;
  const mk = async (name: string, organization: string, parentUnitId?: string) =>
    (await api('POST', `/org-units/organization/${organization}`, as(admin, { name, unitType: 'DEPARTMENT', ...(parentUnitId && { parentUnitId }) }))).json.id as string;
  unit.Sales = await mk('Sales', org.North);
  unit.SalesEast = await mk('Sales East', org.North, unit.Sales);
  unit.Support = await mk('Support', org.North);
  unit.Ops = await mk('Ops', org.South);

  const created = await api('POST', '/roles', as(admin, { name: 'Org Admin', permissions: ['organizations:read', 'organizations:update', 'organizations:delete', 'users:read'] }));
  assert.equal(created.status, 201, JSON.stringify(created.json));
  role = created.json.id;
});
after(stopServerAndCleanUp);

const assign = async (body: object) => {
  const res = await api('POST', '/roles/assign', as(admin, { roleId: role, ...body }));
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id as string;
};
const unassign = async (id: string) => assert.equal((await api('DELETE', `/roles/assignments/${id}`, as(admin))).status, 204);
const orgNames = async () => ((await api('GET', '/organizations', as(viewer))).json.organizations ?? []).map((o: { name: string }) => o.name).sort();

test('without a role: no organizations', async () => {
  assert.equal((await api('GET', '/organizations', as(viewer))).status, 403);
  assert.equal((await api('GET', `/org-units/organization/${org.North}`, as(viewer))).status, 403);
});

test('a role for one organization applies to it, and nowhere else', async () => {
  const id = await assign({ principalType: 'USER', userId: viewerId, scopeType: 'ORGANIZATION', scopeId: org.North });
  try {
    const list = (await api('GET', '/organizations', as(viewer))).json.organizations;
    assert.deepEqual(list.map((o: { name: string }) => o.name), ['North']);
    assert.deepEqual(list[0].can, { update: true, delete: true });
    assert.equal(list[0].access, 'ORGANIZATION');

    assert.equal((await api('GET', `/organizations/${org.North}`, as(viewer))).status, 200);
    assert.equal((await api('GET', `/organizations/${org.South}`, as(viewer))).status, 403);
    assert.equal((await api('PATCH', `/organizations/${org.North}`, as(viewer, { description: 'Ours' }))).status, 200);
    assert.equal((await api('PATCH', `/organizations/${org.South}`, as(viewer, { description: 'Not ours' }))).status, 403);
    assert.equal((await api('POST', `/organizations/${org.South}/members`, as(viewer, { userId: viewerId }))).status, 403);

    // Its units, all of them
    const units = (await api('GET', `/org-units/organization/${org.North}`, as(viewer))).json.units.map((u: { name: string }) => u.name).sort();
    assert.deepEqual(units, ['Sales', 'Sales East', 'Support']);
    assert.equal((await api('GET', `/org-units/organization/${org.South}`, as(viewer))).status, 403);
    const made = await api('POST', `/org-units/organization/${org.North}`, as(viewer, { name: 'Finance', unitType: 'TEAM' }));
    assert.equal(made.status, 201);
    assert.equal((await api('DELETE', `/org-units/${made.json.id}`, as(viewer))).status, 204);
    assert.equal((await api('POST', `/org-units/organization/${org.South}`, as(viewer, { name: 'Nope', unitType: 'TEAM' }))).status, 403);

    // The role's other permissions don't spill over to the whole tenant
    assert.equal((await api('GET', '/users', as(viewer))).status, 403, 'users:read was given for North only');
    assert.equal((await api('POST', '/organizations', as(viewer, { name: 'Mine' }))).status, 403, 'creating organizations is tenant-wide');

    // What the app is told
    const perms = (await api('GET', '/auth/permissions', as(viewer))).json;
    assert.ok(!perms.permissions.includes('organizations:update'));
    assert.ok(perms.scoped.some((g: any) => g.permission === 'organizations:update' && g.scopeType === 'ORGANIZATION' && g.scopeId === org.North));
    // The menu rows: a fresh CI database has them only once something synced
    // them (the release step; here, release.test.ts if it ran first), so sync now
    const { syncMenus } = await import('../src/lib/menus.js');
    await syncMenus();
    const menus = {
      admin: JSON.stringify((await api('GET', '/menu-items/portal/TENANT', as(admin))).json),
      viewer: JSON.stringify((await api('GET', '/menu-items/portal/TENANT', as(viewer))).json),
    };
    assert.ok(menus.admin.includes('/organizations') && menus.admin.includes('"/users"'), 'menus are there');
    assert.ok(menus.viewer.includes('/organizations'), 'the Organizations page shows');
    assert.ok(!menus.viewer.includes('"/users"'), 'the Users page does not');
  } finally {
    await unassign(id);
  }
  assert.equal((await api('GET', '/organizations', as(viewer))).status, 403, 'gone with the assignment');
});

test('a role for one unit applies to it and the units below it', async () => {
  const id = await assign({ principalType: 'USER', userId: viewerId, scopeType: 'ORG_UNIT', scopeId: unit.Sales });
  try {
    const list = (await api('GET', '/organizations', as(viewer))).json.organizations;
    assert.deepEqual(list.map((o: { name: string }) => o.name), ['North']);
    assert.equal(list[0].access, 'UNITS');
    assert.deepEqual(list[0].can, { update: false, delete: false });
    assert.equal((await api('GET', `/organizations/${org.North}`, as(viewer))).status, 403, 'not the whole organization');

    const units = (await api('GET', `/org-units/organization/${org.North}`, as(viewer))).json.units.map((u: { name: string }) => u.name).sort();
    assert.deepEqual(units, ['Sales', 'Sales East']);
    const tree = (await api('GET', `/org-units/organization/${org.North}/hierarchy`, as(viewer))).json.hierarchy;
    assert.deepEqual(tree.map((u: { name: string }) => u.name), ['Sales']);
    assert.deepEqual(tree[0].children.map((u: { name: string }) => u.name), ['Sales East']);

    assert.equal((await api('GET', `/org-units/${unit.SalesEast}`, as(viewer))).status, 200);
    assert.equal((await api('GET', `/org-units/${unit.Support}`, as(viewer))).status, 403);
    assert.equal((await api('PATCH', `/org-units/${unit.SalesEast}`, as(viewer, { description: 'East coast' }))).status, 200);
    assert.equal((await api('PATCH', `/org-units/${unit.Support}`, as(viewer, { description: 'x' }))).status, 403);
    assert.equal((await api('DELETE', `/org-units/${unit.Support}`, as(viewer))).status, 403);

    const child = await api('POST', `/org-units/organization/${org.North}`, as(viewer, { name: 'Sales West', unitType: 'TEAM', parentUnitId: unit.Sales }));
    assert.equal(child.status, 201);
    assert.equal((await api('POST', `/org-units/organization/${org.North}`, as(viewer, { name: 'Top', unitType: 'TEAM' }))).status, 403, 'not at the top of the organization');
    // Nor moving a unit out from under the one they were given
    assert.equal((await api('PATCH', `/org-units/${child.json.id}`, as(viewer, { parentUnitId: unit.Support }))).status, 403);
    assert.equal((await api('PATCH', `/org-units/${child.json.id}`, as(viewer, { parentUnitId: null }))).status, 403);
    assert.equal((await api('PATCH', `/org-units/${child.json.id}`, as(viewer, { parentUnitId: unit.SalesEast }))).status, 200, 'within it is fine');
    assert.equal((await api('DELETE', `/org-units/${child.json.id}`, as(viewer))).status, 204);
  } finally {
    await unassign(id);
  }
});

test("through a group's role, scoped the same way", async () => {
  const group = (await api('POST', '/groups', as(admin, { name: `South team ${A.slug}` }))).json.id;
  assert.equal((await api('POST', `/groups/${group}/members`, as(admin, { userId: viewerId }))).status, 201);
  const id = await assign({ principalType: 'GROUP', groupId: group, scopeType: 'ORGANIZATION', scopeId: org.South });
  try {
    assert.deepEqual(await orgNames(), ['South']);
    assert.equal((await api('GET', `/org-units/${unit.Ops}`, as(viewer))).status, 200);
    assert.equal((await api('GET', `/org-units/${unit.Sales}`, as(viewer))).status, 403);
  } finally {
    await unassign(id);
  }
});

test('a tenant-wide role still covers every organization', async () => {
  const id = await assign({ principalType: 'USER', userId: viewerId });
  try {
    assert.deepEqual(await orgNames(), ['North', 'South']);
    assert.equal((await api('GET', '/users', as(viewer))).status, 200);
  } finally {
    await unassign(id);
  }
});

test('a unit cannot be moved below itself', async () => {
  const res = await api('PATCH', `/org-units/${unit.Sales}`, as(admin, { parentUnitId: unit.SalesEast }));
  assert.equal(res.status, 400);
});

test('the access review shows scoped permissions apart', async () => {
  const id = await assign({ principalType: 'USER', userId: viewerId, scopeType: 'ORGANIZATION', scopeId: org.North });
  try {
    const review = (await api('GET', `/users/${viewerId}/access`, as(admin))).json;
    assert.ok(!review.effective.some((e: any) => e.permission === 'organizations:update'));
    assert.ok(review.scoped.some((e: any) => e.permission === 'organizations:update'));
    // ...and it agrees with what the server enforces
    const enforced = (await api('GET', '/auth/permissions', as(viewer))).json.permissions as string[];
    assert.ok(!enforced.includes('organizations:update'));
  } finally {
    await unassign(id);
  }
});
