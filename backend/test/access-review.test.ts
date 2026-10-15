/**
 * Access review: GET /users/:id/access explains every permission a user has
 * and where it comes from, including sources that currently grant nothing,
 * and agrees with what the server actually enforces.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, login, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';
import { PERMISSIONS, permissionMatches } from '../src/utils/permissions.js';

let A: TenantSeed;
let B: TenantSeed;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};
const roles: Record<string, string> = {};
const as = (who: string) => ({ token: tok[who] });
const DAY = 24 * 3600 * 1000;
let tenantDb: Awaited<ReturnType<typeof db>>['tenantDb'];
let controlDb: Awaited<ReturnType<typeof db>>['controlDb'];

before(async () => {
  ({ tenantDb, controlDb } = await db());
  A = await seedTenant('rev');
  B = await seedTenant('rev-b');
  await startServer();
  tok.admin = await login(A, A.adminEmail);
  tok.manager = await login(A, A.managerEmail);
  tok.adminB = await login(B, B.adminEmail);
  assert.equal((await api('POST', `/roles/initialize/${A.tenantId}`, as('admin'))).status, 200);
  for (const u of await tenantDb.user.findMany({ where: { tenantId: A.tenantId } })) ids[u.email] = u.id;
  for (const r of (await api('GET', '/roles', as('admin'))).json.roles) roles[r.name] = r.id;

  const user = ids[A.userEmail];
  const now = Date.now();
  const t = A.tenantId;
  const assign = (data: Record<string, unknown>) =>
    tenantDb.roleAssignment.create({ data: { tenantId: t, scopeType: 'TENANT', scopeId: t, ...data } as any });

  // Direct: Viewer now, Developer from next week
  await assign({ roleId: roles['Viewer'], principalType: 'USER', userId: user });
  await assign({ roleId: roles['Developer'], principalType: 'USER', userId: user, validFrom: new Date(now + 7 * DAY) });

  // Groups: an active one with Tenant Manager, an inactive one, and an ended membership
  const mk = (name: string, status = 'ACTIVE') => tenantDb.group.create({ data: { tenantId: t, name, status } });
  const support = await mk('Support');
  const paused = await mk('Paused', 'INACTIVE');
  const former = await mk('Former team');
  const empty = await mk('No roles');
  await assign({ roleId: roles['Tenant Manager'], principalType: 'GROUP', groupId: support.id });
  await assign({ roleId: roles['Tenant Admin'], principalType: 'GROUP', groupId: paused.id });
  await assign({ roleId: roles['Tenant Admin'], principalType: 'GROUP', groupId: former.id });
  await tenantDb.groupMembership.createMany({
    data: [
      { tenantId: t, groupId: support.id, userId: user },
      { tenantId: t, groupId: paused.id, userId: user },
      { tenantId: t, groupId: former.id, userId: user, validFrom: new Date(now - 30 * DAY), validTo: new Date(now - DAY) },
      { tenantId: t, groupId: empty.id, userId: user },
    ],
  });

  // Delegations from the admin: one active, one that hasn't started yet
  const grant = (...names: string[]) => ({ create: names.map((permission) => ({ tenantId: t, permission })) });
  const auditor = await tenantDb.role.create({ data: { tenantId: t, name: 'Auditor', permissions: grant('activity:read') } });
  const dba = await tenantDb.role.create({ data: { tenantId: t, name: 'DBA', permissions: grant('database:manage') } });
  const admin = ids[A.adminEmail];
  const auditorA = await assign({ roleId: auditor.id, principalType: 'USER', userId: admin });
  const dbaA = await assign({ roleId: dba.id, principalType: 'USER', userId: admin });
  await tenantDb.delegation.create({ data: { tenantId: t, delegatorId: admin, delegateId: user, roleAssignmentId: auditorA.id, validTo: new Date(now + 3 * DAY) } });
  await tenantDb.delegation.create({ data: { tenantId: t, delegatorId: admin, delegateId: user, roleAssignmentId: dbaA.id, validFrom: new Date(now + 2 * DAY), validTo: new Date(now + 9 * DAY) } });

  // Older data: a role carrying a platform permission
  const legacy = await tenantDb.role.create({ data: { tenantId: t, name: 'Legacy', permissions: grant('tenants:manage', 'activity:read') } });
  await assign({ roleId: legacy.id, principalType: 'USER', userId: user });

  tok.user = await login(A, A.userEmail);

  // A plain viewer, without roles:read
  const { hashPassword } = await import('../src/utils/auth.js');
  const { PASSWORD } = await import('./helpers.js');
  const viewer = await tenantDb.user.create({
    data: { tenantId: t, email: `viewer-rev-${now}@test.local`, name: 'Viewer', userType: 'TENANT_VIEWER', passwordHash: await hashPassword(PASSWORD) },
  });
  ids.viewer = viewer.id;
  tok.viewer = await login(A, viewer.email);
});

after(stopServerAndCleanUp);

const review = async (who = 'admin', userEmail = A.userEmail) => api('GET', `/users/${ids[userEmail]}/access`, as(who));

test('lists every source with whether it applies now, and why not', async () => {
  const res = await review();
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const { sources, user } = res.json;
  assert.equal(user.email, A.userEmail);
  const find = (pred: (s: any) => boolean) => {
    const s = sources.find(pred);
    assert.ok(s, 'source missing');
    return s;
  };

  assert.equal(find((s: any) => s.kind === 'USER_TYPE').active, true);
  assert.equal(find((s: any) => s.kind === 'ROLE' && s.roleName === 'Viewer').active, true);
  const dev = find((s: any) => s.kind === 'ROLE' && s.roleName === 'Developer');
  assert.equal(dev.active, false);
  assert.match(dev.inactiveReason, /starts/);

  const support = find((s: any) => s.kind === 'GROUP' && s.groupName === 'Support');
  assert.equal(support.active, true);
  assert.equal(support.roleName, 'Tenant Manager');
  assert.equal(find((s: any) => s.groupName === 'Paused').inactiveReason, 'The group is inactive');
  assert.match(find((s: any) => s.groupName === 'Former team').inactiveReason, /Membership ended/);
  assert.equal(find((s: any) => s.groupName === 'No roles').inactiveReason, 'The group has no roles');

  const delegations = sources.filter((s: any) => s.kind === 'DELEGATION');
  assert.equal(delegations.find((s: any) => s.roleName === 'Auditor').active, true);
  assert.equal(delegations.find((s: any) => s.roleName === 'Auditor').delegatorName, 'Admin');
  assert.match(delegations.find((s: any) => s.roleName === 'DBA').inactiveReason, /starts/);

  const legacy = find((s: any) => s.roleName === 'Legacy');
  assert.deepEqual(legacy.ignored, ['tenants:manage']);
  assert.deepEqual(legacy.permissions, ['activity:read']);
});

test('effective permissions name their sources and only count active ones', async () => {
  const { effective, sources } = (await review()).json;
  const of = (p: string) => effective.find((e: any) => e.permission === p);
  const label = (id: string) => sources.find((s: any) => s.id === id);

  assert.deepEqual(of('users:create').sources.map((id: string) => label(id).groupName), ['Support'], 'from the group only');
  assert.deepEqual(new Set(of('activity:read').sources.map((id: string) => label(id).roleName)), new Set(['Tenant Manager', 'Auditor', 'Legacy']));
  assert.ok(of('dashboard:view').sources.includes('type'));
  const dev = sources.find((s: any) => s.roleName === 'Developer');
  assert.ok(!effective.some((e: any) => e.sources.includes(dev.id)), 'Developer has not started');
  assert.equal(of('database:manage'), undefined, 'delegation has not started');
  assert.equal(of('roles:manage'), undefined, 'inactive group / ended membership grant nothing');
  assert.ok(!effective.some((e: any) => e.permission === 'tenants:manage'));
});

test('agrees with what the server enforces', async () => {
  const { effective } = (await review()).json;
  const enforced = (await api('GET', '/auth/permissions', as('user'))).json.permissions as string[];
  const expanded = PERMISSIONS.filter((p) => permissionMatches(enforced, p));
  assert.deepEqual(effective.map((e: any) => e.permission).sort(), [...expanded].sort());
  // The scheduled delegation used to apply immediately
  assert.ok(!expanded.includes('database:manage'));
});

test('who can see it', async () => {
  assert.equal((await review('user')).status, 200, 'your own access');
  assert.equal((await api('GET', `/users/${ids[A.adminEmail]}/access`, as('viewer'))).status, 403, "someone else's needs roles:read");
  assert.equal((await api('GET', `/users/${ids.viewer}/access`, as('viewer'))).status, 200);
  assert.equal((await review('manager', A.userEmail)).status, 200, 'managers have roles:read');
  assert.equal((await api('GET', `/users/${ids[A.userEmail]}/access`, as('adminB'))).status, 404, 'not across tenants');
});
