/**
 * Keeps permission names consistent across the frontend route guards,
 * page-level buttons, the sidebar menu seed and the backend catalog.
 * Pure file checks: no database needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSIONS, USER_TYPE_PERMISSIONS, permissionMatches } from '../src/utils/permissions.js';
import { MENUS } from '../prisma/menu-definitions.js';

const FRONTEND = join(import.meta.dirname, '..', '..', 'src');
const catalog = new Set<string>(PERMISSIONS);

/** `<Route path="/x" element={<PermissionGuard permission="a:b"` / anyOf={['a:b', ...]} */
function guardedRoutes() {
  const app = readFileSync(join(FRONTEND, 'App.tsx'), 'utf8');
  const re = /<Route path="([^"]+)" element=\{\s*<PermissionGuard (?:permission="([^"]+)"|anyOf=\{\[([^\]]+)\]\}|allOf=\{\[([^\]]+)\]\})/g;
  return [...app.matchAll(re)].map((m) => ({
    path: m[1],
    portal: m[1].startsWith('/platform') ? ('PLATFORM' as const) : ('TENANT' as const),
    required: m[2] ? [m[2]] : [...(m[3] ?? m[4]).matchAll(/'([^']+)'/g)].map((x) => x[1]),
  }));
}

function allRoutePaths() {
  const app = readFileSync(join(FRONTEND, 'App.tsx'), 'utf8');
  return new Set([...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]));
}

function pagePermissions() {
  const dir = join(FRONTEND, 'pages');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.tsx') && f !== 'PermissionDemo.tsx')
    .flatMap((f) =>
      [...readFileSync(join(dir, f), 'utf8').matchAll(/permission="([^"]+)"|hasPermission\('([^']+)'\)/g)].map((m) => ({ file: f, permission: m[1] ?? m[2] })),
    );
}

function flatten(items: (typeof MENUS)['TENANT']): (typeof MENUS)['TENANT'] {
  return items.flatMap((i) => [i, ...flatten(i.children ?? [])]);
}

test('route guards only use catalog permissions', () => {
  const routes = guardedRoutes();
  assert.ok(routes.length >= 15, `parsed ${routes.length} guarded routes`);
  for (const r of routes) for (const p of r.required) assert.ok(catalog.has(p), `${r.path} requires unknown permission "${p}"`);
});

test('page buttons only use catalog permissions', () => {
  for (const { file, permission } of pagePermissions()) {
    assert.ok(catalog.has(permission), `${file} uses unknown permission "${permission}"`);
  }
});

test('menu items use catalog permissions and point at real routes', () => {
  const paths = allRoutePaths();
  for (const portal of ['PLATFORM', 'TENANT'] as const) {
    for (const item of flatten(MENUS[portal])) {
      if (item.permission) assert.ok(catalog.has(item.permission), `menu "${item.label}" uses unknown permission "${item.permission}"`);
      assert.ok(paths.has(item.path), `menu "${item.label}" points at ${item.path}, which is not a route`);
    }
  }
});

test('user-type defaults only grant catalog permissions (or wildcards over them)', () => {
  for (const [type, grants] of Object.entries(USER_TYPE_PERMISSIONS)) {
    for (const g of grants) {
      const ok = g === '*' || catalog.has(g) || PERMISSIONS.some((p) => permissionMatches([g], p));
      assert.ok(ok, `${type} grants "${g}", which matches nothing in the catalog`);
    }
  }
});

test('admins can open every page in their portal', () => {
  for (const r of guardedRoutes()) {
    const admin = r.portal === 'PLATFORM' ? 'PLATFORM_ADMIN' : 'TENANT_ADMIN';
    assert.ok(
      r.required.some((p) => permissionMatches(USER_TYPE_PERMISSIONS[admin], p)),
      `${admin} cannot open ${r.path} (needs ${r.required.join(' or ')})`,
    );
  }
});

test('every tenant user type can open the dashboard', () => {
  for (const type of ['TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER'] as const) {
    assert.ok(permissionMatches(USER_TYPE_PERMISSIONS[type], 'dashboard:view'), `${type} cannot open /dashboard`);
  }
  assert.ok(permissionMatches(USER_TYPE_PERMISSIONS.PLATFORM_USER, 'platform:read'));
});

test('wildcard matching', () => {
  assert.ok(permissionMatches(['*'], 'tenants:read'));
  assert.ok(permissionMatches(['*:*'], 'tenants:read'));
  assert.ok(permissionMatches(['users:*'], 'users:delete'));
  assert.ok(permissionMatches(['*:read'], 'groups:read'));
  assert.ok(!permissionMatches(['users:read'], 'users:delete'));
  assert.ok(!permissionMatches(['users:*'], 'groups:read'));
});
