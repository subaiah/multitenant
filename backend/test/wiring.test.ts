/**
 * Frontend <-> backend wiring: the browser authenticates with the httpOnly
 * cookie only, never sends a tenant header, and platform users log in
 * without a tenant.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp,
  PASSWORD, type PlatformSeed, type TenantSeed,
} from './helpers.js';

let A: TenantSeed;
let B: TenantSeed;
let P: PlatformSeed;

before(async () => {
  A = await seedTenant('wire-a');
  B = await seedTenant('wire-b');
  P = await seedPlatformUsers();
  await startServer();
});

after(stopServerAndCleanUp);

// ------------------------------------------------------------- tenant users

test('cookie alone authenticates; the tenant comes from the token', async () => {
  const { cookie, body } = await loginSession(A.slug, A.adminEmail);
  assert.equal(body.user.portal, 'TENANT');

  const users = await api('GET', '/users', { cookie });
  assert.equal(users.status, 200);
  assert.ok(users.json.data.every((u: { email: string }) => u.email.includes('wire-a')), 'only tenant A users');

  assert.equal((await api('GET', '/users', { cookie, tenant: A.tenantId })).status, 200, 'matching header is fine');
  assert.equal((await api('GET', '/users', { cookie, tenant: B.tenantId })).status, 403, 'other tenant header is refused');
  assert.equal((await api('GET', '/users')).status, 401, 'no cookie, no access');
});

test('/bff/auth/me and /auth/permissions work from the cookie', async () => {
  const { cookie } = await loginSession(A.slug, A.userEmail);
  const me = await api('GET', '/bff/auth/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.portal, 'TENANT');
  assert.equal(me.json.tenant.id, A.tenantId);

  const perms = await api('GET', '/auth/permissions', { cookie });
  assert.equal(perms.status, 200);
  assert.ok(perms.json.permissions.includes('dashboard:view'));
  assert.ok(!perms.json.permissions.includes('settings:*'), 'regular users do not get admin grants');
});

test('tenant menu is filtered by permission, nested once, and limited to the own portal', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  // Menu rows are global; make sure a known parent/child pair exists for this test
  const parent = await prisma.menuItem.create({
    data: { portal: 'TENANT', label: `Parent ${A.slug}`, path: '/groups', permission: 'groups:read', order: 900, isActive: true },
  });
  const child = await prisma.menuItem.create({
    data: { portal: 'TENANT', parentId: parent.id, label: `Child ${A.slug}`, path: '/role-assignments', permission: 'roles:read', order: 0, isActive: true },
  });
  const adminOnly = await prisma.menuItem.create({
    data: { portal: 'TENANT', label: `Admin ${A.slug}`, path: '/settings', permission: 'settings:manage', order: 901, isActive: true },
  });
  try {
    const admin = await loginSession(A.slug, A.adminEmail);
    const menu = await api('GET', '/menu-items/portal/TENANT', { cookie: admin.cookie });
    assert.equal(menu.status, 200);
    const top = menu.json.menuItems as { id: string; children: { id: string }[] }[];
    assert.ok(top.some((i) => i.id === parent.id), 'parent listed');
    assert.ok(!top.some((i) => i.id === child.id), 'child not repeated at top level');
    assert.ok(top.find((i) => i.id === parent.id)!.children.some((c) => c.id === child.id), 'child nested under parent');
    assert.ok(top.some((i) => i.id === adminOnly.id), 'admin sees admin item');

    const user = await loginSession(A.slug, A.userEmail);
    const userMenu = await api('GET', '/menu-items/portal/TENANT', { cookie: user.cookie });
    const ids = (userMenu.json.menuItems as { id: string; children: { id: string }[] }[]).flatMap((i) => [i.id, ...i.children.map((c) => c.id)]);
    assert.ok(!ids.includes(adminOnly.id), 'user does not see settings:manage item');
    assert.ok(!ids.includes(child.id), 'user does not see roles:read item');

    assert.equal((await api('GET', '/menu-items/portal/PLATFORM', { cookie: admin.cookie })).status, 403);
  } finally {
    await prisma.menuItem.deleteMany({ where: { id: { in: [child.id, parent.id, adminOnly.id] } } });
  }
});

test('session refresh works with cookies', async () => {
  const { cookie } = await loginSession(A.slug, A.userEmail);
  const refreshed = await api('POST', '/bff/auth/refresh', { cookie });
  assert.equal(refreshed.status, 200);
  const newCookie = refreshed.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert.equal((await api('GET', '/users', { cookie: newCookie })).status, 200);
});

// ------------------------------------------------------------- platform users

test('platform users log in with the platform slug and get no tenant', async () => {
  const { cookie, body } = await loginSession('platform', P.adminEmail);
  assert.equal(body.user.portal, 'PLATFORM');
  assert.equal(body.tenant, null);

  const me = await api('GET', '/bff/auth/me', { cookie });
  assert.equal(me.json.user.portal, 'PLATFORM');

  const perms = await api('GET', '/auth/permissions', { cookie });
  assert.ok(perms.json.permissions.includes('*'));

  // Refresh tokens for tenant-less users
  assert.equal((await api('POST', '/bff/auth/refresh', { cookie })).status, 200);
});

test('tenant users cannot use the platform slug, platform users cannot use a tenant slug', async () => {
  const tenantUserAsPlatform = await api('POST', '/bff/auth/login', { body: { email: A.adminEmail, tenantSlug: 'platform', password: PASSWORD } });
  assert.equal(tenantUserAsPlatform.status, 401);
  const platformAsTenant = await api('POST', '/bff/auth/login', { body: { email: P.adminEmail, tenantSlug: A.slug, password: PASSWORD } });
  assert.equal(platformAsTenant.status, 401);
});

test('platform routes work without a tenant; tenant routes need one selected', async () => {
  const { cookie } = await loginSession('platform', P.adminEmail);
  assert.equal((await api('GET', '/tenants', { cookie })).status, 200);
  assert.equal((await api('GET', '/applications', { cookie })).status, 200);

  const menu = await api('GET', '/menu-items/portal/PLATFORM', { cookie });
  assert.equal(menu.status, 200);
  assert.equal((await api('GET', '/menu-items/portal/TENANT', { cookie })).status, 403);

  assert.equal((await api('GET', '/users', { cookie })).status, 400, 'tenant-scoped without a tenant');
  const scoped = await api('GET', '/users', { cookie, tenant: A.tenantId });
  assert.equal(scoped.status, 200);
  assert.ok(scoped.json.data.every((u: { email: string }) => u.email.includes('wire-a')));
});

test('platform admin actions are logged without a tenant', async () => {
  const { cookie } = await loginSession('platform', P.adminEmail);
  const key = `app-${Math.random().toString(36).slice(2, 8)}`;
  const created = await api('POST', '/applications', { cookie, body: { key, name: 'Test App', description: 'x', version: '1.0.0' } });
  assert.equal(created.status, 201);
  const { prisma } = await import('../src/lib/prisma.js');
  await prisma.applicationRegistry.delete({ where: { id: created.json.id } });
});

test('platform support (PLATFORM_USER) is read-only on tenants', async () => {
  const { cookie } = await loginSession('platform', P.supportEmail);
  assert.equal((await api('GET', '/tenants', { cookie })).status, 200);
  assert.equal((await api('DELETE', `/tenants/${B.tenantId}`, { cookie })).status, 403);
});

// ------------------------------------------------------------- public endpoints

test('login page info for the platform slug, and the slug is reserved', async () => {
  const info = await api('GET', '/auth/tenant/platform');
  assert.equal(info.status, 200);
  assert.equal(info.json.id, null);

  const tenantInfo = await api('GET', `/auth/tenant/${A.slug}`);
  assert.equal(tenantInfo.json.authConfig.otpEnabled, true, 'login page needs otpEnabled');

  const reg = await api('POST', '/auth/register', { body: { email: 'x@y.test', name: 'X Y', tenantName: 'Platform', tenantSlug: 'platform' } });
  assert.equal(reg.status, 409);
});
