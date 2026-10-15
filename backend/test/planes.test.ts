/**
 * Control-plane and tenant-plane data never mix: control models are only
 * reached through controlDb, tenant models only through a tenant client
 * (request.db, dbForTenant(...), platformDb(...)). The two Prisma clients already
 * refuse unknown models at compile time; this test also covers the rules the
 * type checker can't see (tenant-schema conventions).
 * Pure file checks: no database needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

function schemaFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.prisma'))
    .map((f) => join(root, dir, f));
}

function models(dir: string) {
  return schemaFiles(dir).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ file, name: m[1], body: m[2] })),
  );
}

const control = models('prisma/control');
const tenant = models('prisma/tenant');
const camel = (s: string) => s[0].toLowerCase() + s.slice(1);

test('no model is in both planes', () => {
  const controlNames = new Set(control.map((m) => m.name));
  const clash = tenant.filter((m) => controlNames.has(m.name)).map((m) => m.name);
  assert.deepEqual(clash, []);
});

test('every tenant model has a tenant_id column', () => {
  const missing = tenant.filter((m) => !/^\s+tenantId\s+String\s.*@map\("tenant_id"\)/m.test(m.body)).map((m) => m.name);
  assert.deepEqual(missing, [], 'row-level security and moving data between modes rely on it');
});

test('tenant models have no relations to control-plane models', () => {
  const controlNames = control.map((m) => m.name);
  const bad = tenant.flatMap((m) =>
    controlNames.filter((c) => new RegExp(`^\\s+\\w+\\s+${c}(\\?|\\[\\])?(\\s|$)`, 'm').test(m.body)).map((c) => `${m.name} -> ${c}`),
  );
  assert.deepEqual(bad, []);
});

test('tenant unique constraints on chosen values include tenant_id', () => {
  const bad: string[] = [];
  for (const m of tenant) {
    for (const [, fields] of m.body.matchAll(/@@unique\(\[([^\]]+)\]/g)) {
      const list = fields.split(',').map((f) => f.trim());
      // Uniques through a parent id (e.g. [roleId, permission]) are scoped by that parent
      if (!list.includes('tenantId') && !list.some((f) => f.endsWith('Id'))) bad.push(`${m.name} @@unique([${fields}])`);
    }
  }
  assert.deepEqual(bad, []);
});

test('source files reach each model through the right client', () => {
  const controlModels = new Set(control.map((m) => camel(m.name)));
  const tenantModels = new Set(tenant.map((m) => camel(m.name)));
  const files = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(root, 'src', f));
  const problems: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const [, model] of src.matchAll(/\bcontrolDb\.(\w+)\./g)) {
      if (tenantModels.has(model)) problems.push(`${file}: controlDb.${model} (tenant model)`);
    }
    for (const [, client, model] of src.matchAll(/(request\.db|platformDb\([^)]*\)|\(await dbForTenant\([^)]*\)\))\.(\w+)\./g)) {
      if (controlModels.has(model)) problems.push(`${file}: ${client}.${model} (control model)`);
    }
  }
  assert.deepEqual(problems, []);
});
