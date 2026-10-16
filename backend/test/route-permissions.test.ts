/**
 * Every protected route must declare the permission it needs, and only use
 * names from the catalog. A route without a declaration is refused at
 * runtime (fail closed); this test catches it before it ships.
 * Pure file checks: no database needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSIONS, isTenantGrantable } from '../src/utils/permissions.js';

const ROUTES = join(import.meta.dirname, '..', 'src', 'routes');
// The product's routes (src/product) follow the same rules
const PRODUCT = join(import.meta.dirname, '..', 'src', 'product');
// Registered outside the authenticated scope (login, session, health)
const PUBLIC_FILES = new Set(['auth.ts', 'bff-auth.ts', 'mfa.ts', 'account.ts', 'health.ts']);
const catalog = new Set<string>(PERMISSIONS);

interface Declared {
  file: string;
  route: string;
  permission: string[] | 'AUTHENTICATED' | null;
}

function protectedRoutes(): Declared[] {
  const files = [
    ...readdirSync(ROUTES).filter((f) => !PUBLIC_FILES.has(f)).map((f) => join(ROUTES, f)),
    ...readdirSync(PRODUCT).map((f) => join(PRODUCT, f)),
  ].filter((f) => f.endsWith('.ts'));
  return files
    .flatMap((path) => {
      const file = path.split('/').slice(-2).join('/');
      const src = readFileSync(path, 'utf8');
      const starts = [...src.matchAll(/fastify\.(get|post|put|patch|delete)\('([^']*)'/g)];
      return starts.map((m, i) => {
        const options = src.slice(m.index, starts[i + 1]?.index ?? src.length).split('async (')[0];
        const decl = options.match(/config:\s*\{[^}]*permission:\s*(AUTHENTICATED|'[^']+'|\[[^\]]+\])/);
        const permission = !decl
          ? null
          : decl[1] === 'AUTHENTICATED'
            ? ('AUTHENTICATED' as const)
            : [...decl[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
        return { file, route: `${m[1].toUpperCase()} ${m[2]}`, permission };
      });
    });
}

test('every protected route declares a permission', () => {
  const routes = protectedRoutes();
  assert.ok(routes.length > 100, `found ${routes.length} protected routes`);
  const missing = routes.filter((r) => r.permission === null).map((r) => `${r.file}: ${r.route}`);
  assert.deepEqual(missing, [], `routes without config.permission:\n${missing.join('\n')}`);
});

test('declared permissions exist in the catalog', () => {
  for (const r of protectedRoutes()) {
    if (Array.isArray(r.permission)) {
      for (const p of r.permission) assert.ok(catalog.has(p), `${r.file}: ${r.route} uses unknown permission "${p}"`);
    }
  }
});

test('platform-only resources cannot be granted by tenant roles', () => {
  for (const p of ['tenants:read', 'tenants:manage', 'platform:read', 'platform-users:read', 'app-registry:manage', 'menus:manage', 'support:manage']) {
    assert.ok(!isTenantGrantable(p), p);
  }
  for (const p of ['*', '*:*', '*:read', '*:manage']) assert.ok(!isTenantGrantable(p), `wildcard ${p}`);
  for (const p of ['users:read', 'groups:create', 'roles:assign', 'applications:manage', 'policies:manage']) {
    assert.ok(isTenantGrantable(p), p);
  }
});
