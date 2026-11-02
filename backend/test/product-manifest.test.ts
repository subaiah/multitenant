/**
 * External products registered from a manifest (lib/product-manifest.ts,
 * docs/PRODUCT_INTEGRATION.md): validation, import (create, then update),
 * export, and the product's pages in organizations' sidebars.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { api, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type PlatformSeed, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let B: TenantSeed;
let P: PlatformSeed;
let platform: string;
let adminA: string;
const productIds: string[] = [];

before(async () => {
  A = await seedTenant('mf-a');
  B = await seedTenant('mf-b');
  P = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', P.adminEmail)).cookie;
  adminA = (await loginSession(A.slug, A.adminEmail)).cookie;
});
after(async () => {
  const { controlDb } = await db();
  const apps = await controlDb.applicationRegistry.findMany({ where: { key: { in: productIds } }, select: { id: true } });
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: { in: apps.map((a) => a.id) } } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: { in: apps.map((a) => a.id) } } });
  await stopServerAndCleanUp();
});

function manifest(overrides: Record<string, unknown> = {}) {
  const productId = (overrides.productId as string) ?? `forge-${randomBytes(3).toString('hex')}`;
  productIds.push(productId);
  return {
    manifestVersion: 1,
    productId,
    name: 'Forge',
    description: 'Build without code',
    version: '1.0.0',
    baseUrl: 'https://forge.example.com',
    signIn: { clientType: 'CONFIDENTIAL', redirectUris: ['https://forge.example.com/auth/callback'], postLogoutRedirectUris: ['https://forge.example.com/'], openPath: '/login' },
    permissions: [
      { name: `${productId}:admin`, description: 'Manage Forge' },
      { name: `${productId}.apps:build`, description: 'Build applications' },
    ],
    menu: [
      { label: 'Home', path: '/home', icon: 'LayoutDashboard' },
      { label: 'Builder', path: '/apps', icon: 'Package', permission: `${productId}.apps:build` },
    ],
    ...overrides,
  };
}
const importIt = (body: unknown, cookie = platform) => api('POST', '/applications/manifest', { cookie, body });

test('a manifest with problems is refused, with every problem named', async () => {
  const m = manifest();
  const bad = {
    ...m,
    productId: 'Forge!',
    baseUrl: 'http://forge.example.com/app',
    signIn: { ...m.signIn, redirectUris: ['https://forge.example.com/cb#x'] },
    permissions: [{ name: 'users:export', description: 'x' }, { name: 'users:export', description: 'y' }],
    menu: [{ label: 'X', path: 'relative', permission: 'forge:nothing' }],
  };
  const res = await importIt(bad);
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'INVALID_MANIFEST');
  for (const field of ['productId', 'baseUrl', 'signIn.redirectUris.0', 'permissions.0.name', 'permissions.1.name', 'menu.0.path', 'menu.0.permission']) {
    assert.match(res.json.message, new RegExp(`${field.replace(/\./g, '\\.')}:`), field);
  }
  assert.equal((await importIt({ ...m, manifestVersion: 2 })).status, 400);
  // Only platform staff
  assert.equal((await importIt(manifest(), adminA)).status, 403);
});

test('importing creates the product with sign-in, permissions and menu; credentials once', async () => {
  const m = manifest();
  const res = await importIt(m);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.created, true);
  assert.match(res.json.clientId, /^mtc_/);
  assert.ok(res.json.clientSecret?.length > 30, 'the secret, once');
  assert.deepEqual(res.json.permissions.added.sort(), m.permissions.map((p) => p.name).sort());
  assert.equal(res.json.menuItems, 2);

  const { controlDb } = await db();
  const app = await controlDb.applicationRegistry.findUniqueOrThrow({ where: { key: m.productId }, include: { signIn: true, menuItems: true, permissions: true } });
  assert.equal(app.status, 'ACTIVE');
  assert.equal(app.baseUrl, 'https://forge.example.com');
  assert.equal(app.version, '1.0.0');
  assert.ok(app.manifestImportedAt);
  assert.equal(app.signIn?.enabled, true);
  assert.equal(app.signIn?.initiateLoginUri, 'https://forge.example.com/login');
  assert.deepEqual(app.signIn?.redirectUris, m.signIn.redirectUris);
  assert.match(app.signIn!.oidcClientSecret!, /^enc:v\d+:/, 'stored encrypted');
  assert.equal(app.menuItems.length, 2);

  // The settings come back out as the same manifest
  const exported = await api('GET', `/applications/${app.id}/manifest`, { cookie: platform });
  assert.equal(exported.status, 200);
  assert.deepEqual(
    { ...exported.json, permissions: [...exported.json.permissions].sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)) },
    { ...m, permissions: [...m.permissions].sort((a, b) => a.name.localeCompare(b.name)) },
  );

  // Recorded in the platform's audit log
  const log = await api('GET', '/platform-audit?event=application.manifest_imported', { cookie: platform });
  assert.ok(JSON.stringify(log.json).includes(app.id));
});

test('importing again updates it: same credentials, permissions added and reported, menu replaced, status kept', async () => {
  const m = manifest();
  const first = await importIt(m);
  const { controlDb } = await db();
  const app = await controlDb.applicationRegistry.findUniqueOrThrow({ where: { key: m.productId } });
  // Platform staff take it offline: an import doesn't bring it back
  await controlDb.applicationRegistry.update({ where: { id: app.id }, data: { status: 'INACTIVE' } });

  const next = {
    ...m,
    name: 'Forge Studio',
    version: '1.1.0',
    signIn: { ...m.signIn, redirectUris: ['https://forge.example.com/auth/callback', 'https://forge.example.com/auth/cb2'] },
    permissions: [
      { name: `${m.productId}:admin`, description: 'Manage Forge Studio' },
      { name: `${m.productId}.workflows:run`, description: 'Run workflows' },
    ],
    menu: [{ label: 'Workflows', path: '/workflows', permission: `${m.productId}.workflows:run` }],
  };
  const res = await importIt(next);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.created, false);
  assert.equal(res.json.clientId, first.json.clientId, 'same client');
  assert.equal(res.json.clientSecret, undefined, 'no new secret');
  assert.deepEqual(res.json.permissions, { added: [`${m.productId}.workflows:run`], updated: [`${m.productId}:admin`], notInManifest: [`${m.productId}.apps:build`] });

  const after = await controlDb.applicationRegistry.findUniqueOrThrow({ where: { id: app.id }, include: { signIn: true, menuItems: true, permissions: true } });
  assert.equal(after.name, 'Forge Studio');
  assert.equal(after.version, '1.1.0');
  assert.equal(after.status, 'INACTIVE', 'status is platform staff’s decision');
  assert.equal(after.signIn?.redirectUris.length, 2);
  assert.deepEqual(after.menuItems.map((i) => i.label), ['Workflows']);
  assert.equal(after.permissions.length, 3, 'nothing removed');

  // Another product can't take its permissions: names outside a product's own are refused
  const other = manifest();
  const stolen = await importIt({ ...other, permissions: [{ name: `${m.productId}:admin`, description: 'mine now' }], menu: [] });
  assert.equal(stolen.status, 400);
});

test("organizations that have it on see its pages in the sidebar, as far as their permissions go", async () => {
  const m = manifest();
  await importIt(m);
  const { controlDb } = await db();
  const app = await controlDb.applicationRegistry.findUniqueOrThrow({ where: { key: m.productId } });
  const sectionOf = async (cookie: string) => {
    const res = await api('GET', '/menu-items/portal/TENANT', { cookie });
    assert.equal(res.status, 200);
    return res.json.menuItems.find((i: { path: string }) => i.path === `#app-${m.productId}`) as { label: string; children: { label: string; path: string; external: boolean }[] } | undefined;
  };
  assert.equal(await sectionOf(adminA), undefined, 'not before it is turned on');

  const on = await api('POST', '/tenant-applications', { cookie: adminA, body: { applicationId: app.id, state: 'ENABLED' } });
  assert.equal(on.status, 201, JSON.stringify(on.json));

  // The admin holds every permission: both pages
  const forAdmin = await sectionOf(adminA);
  assert.equal(forAdmin?.label, 'Forge');
  assert.deepEqual(forAdmin?.children.map((c) => [c.label, c.path, c.external]), [
    ['Home', 'https://forge.example.com/home', true],
    ['Builder', 'https://forge.example.com/apps', true],
  ]);
  // Right after Dashboard
  const menu = (await api('GET', '/menu-items/portal/TENANT', { cookie: adminA })).json.menuItems;
  assert.equal(menu[1].path, `#app-${m.productId}`);

  // A member without the permission: only the open page
  const member = (await loginSession(A.slug, A.userEmail)).cookie;
  assert.deepEqual((await sectionOf(member))?.children.map((c) => c.label), ['Home']);

  // Another organization, which hasn't turned it on: nothing
  assert.equal(await sectionOf((await loginSession(B.slug, B.adminEmail)).cookie), undefined);

  // Turned off: gone
  assert.equal((await api('DELETE', `/tenant-applications/${on.json.id}`, { cookie: adminA })).status, 204);
  assert.equal(await sectionOf(adminA), undefined);
});
