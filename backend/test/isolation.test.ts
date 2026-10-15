/**
 * Tenant isolation at the database, in every mode, independent of app code:
 * each tenant connects as its own role, and row-level security (ENABLE +
 * FORCE + a policy on every tenant table) only shows and accepts its rows.
 * These checks use raw SQL as the tenant's role, so a missing `where tenantId`
 * in app code would still not leak.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dataOf, db, seedTenant, stopServerAndCleanUp, type TenantSeed } from './helpers.js';
import { decryptSecret, secretContext } from '../src/lib/secrets.js';
import { migrateAllTargets, securityProblems, withConnection } from '../src/lib/tenant-migrations.js';
import { sharedGroupRole, targetOf, ownerUrl, withConnection as withUrl, sharedDatabaseName } from '../src/lib/tenant-targets.js';

const MODES = ['SHARED_TABLES', 'SCHEMA_PER_TENANT', 'DATABASE_PER_TENANT'] as const;
const T: Record<string, TenantSeed> = {};
let Other: TenantSeed; // a second shared-tables tenant, next to T.SHARED_TABLES

/** The tenant role's own connection string (as the app uses it) */
async function roleUrl(t: TenantSeed) {
  const { controlDb } = await db();
  const cfg = await controlDb.databaseConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
  return decryptSecret(cfg.connectionString!, secretContext('connectionString'));
}

async function asRole<R>(t: TenantSeed, fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>) => Promise<R>) {
  return withConnection(await roleUrl(t), async (c) => {
    await c.query(`SET search_path TO "${t.schema}"`);
    return fn((sql, params) => c.query(sql, params as unknown[]));
  });
}

const refused = async (p: Promise<unknown>, pattern: RegExp) => {
  await assert.rejects(p, (err: Error) => {
    assert.match(err.message, pattern);
    return true;
  });
};

before(async () => {
  for (const mode of MODES) T[mode] = await seedTenant(`iso-${mode.split('_')[0].toLowerCase()}`, mode);
  Other = await seedTenant('iso-other', 'SHARED_TABLES');
});
after(stopServerAndCleanUp);

for (const mode of MODES) {
  test(`${mode}: every tenant table has row-level security enabled, forced and a policy`, async () => {
    const { controlDb } = await db();
    const cfg = await controlDb.databaseConfig.findUniqueOrThrow({ where: { tenantId: T[mode].tenantId } });
    assert.deepEqual(await securityProblems(targetOf(cfg)), []);
  });

  test(`${mode}: the tenant's role sees and writes only its own rows`, async () => {
    const t = T[mode];
    await asRole(t, async (q) => {
      const { rows } = await q('SELECT DISTINCT tenant_id FROM users');
      assert.deepEqual(rows.map((r) => r.tenant_id), [t.tenantId], 'no other tenant visible, even unfiltered');
      await refused(
        q(`INSERT INTO users (id, tenant_id, email, user_type, status, created_at, updated_at) VALUES (gen_random_uuid(), $1, 'x@x.test', 'TENANT_USER', 'ACTIVE', now(), now())`, [Other.tenantId]),
        /row-level security/,
      );
      // Moving a row to another tenant is refused too
      await refused(q('UPDATE users SET tenant_id = $1', [Other.tenantId]), /row-level security/);
      // The mapping table, DDL and becoming someone else are all off limits
      await refused(q('SELECT * FROM tenant_roles'), /permission denied/);
      await refused(q('CREATE TABLE sneaky (id int)'), /permission denied/);
      await refused(q('DROP TABLE users'), /must be owner/);
      await refused(q('ALTER TABLE users DISABLE ROW LEVEL SECURITY'), /must be owner/);
      await refused(q('SET ROLE tenant_owner'), /permission denied/);
    });
  });
}

test("SHARED_TABLES: a neighbour's rows are invisible and untouchable", async () => {
  const t = T.SHARED_TABLES;
  // Both tenants have rows in the same table...
  assert.ok((await Other.db.user.count({ where: { tenantId: Other.tenantId } })) > 0);
  await asRole(t, async (q) => {
    assert.equal((await q('SELECT count(*)::int AS n FROM users WHERE tenant_id = $1', [Other.tenantId])).rows[0].n, 0);
    assert.equal((await q('DELETE FROM users WHERE tenant_id = $1', [Other.tenantId])).rows.length, 0);
    // Joining the shared group doesn't change who you are
    await q(`SET ROLE ${sharedGroupRole()}`);
    assert.equal((await q('SELECT count(*)::int AS n FROM users WHERE tenant_id = $1', [Other.tenantId])).rows[0].n, 0);
  });
  assert.ok((await Other.db.user.count({ where: { tenantId: Other.tenantId } })) > 0, "neighbour's rows survived");
});

test("SCHEMA_PER_TENANT: the role can't reach the shared tables or another schema", async () => {
  const t = T.SCHEMA_PER_TENANT;
  await asRole(t, async (q) => {
    await refused(q('SELECT count(*) FROM public.users'), /permission denied for schema public/);
    await refused(q(`SELECT count(*) FROM "${T.SHARED_TABLES.schema}".users`), /permission denied/);
  });
});

test("DATABASE_PER_TENANT: the role can't connect to any other tenant database", async () => {
  const url = await roleUrl(T.DATABASE_PER_TENANT);
  await refused(withConnection(withUrl(url, { database: sharedDatabaseName() }), async () => {}), /permission denied for database/);
  // ...and other tenants' roles can't connect to its database
  const other = withUrl(await roleUrl(T.SHARED_TABLES), { database: new URL(url).pathname.slice(1) });
  await refused(withConnection(other, async () => {}), /permission denied for database/);
});

test('the migration owner is subject to row-level security too (FORCE)', async () => {
  await withConnection(ownerUrl({ kind: 'shared' }), async (c) => {
    const { rows } = await c.query('SELECT count(*)::int AS n FROM users');
    assert.equal(rows[0].n, 0, 'the table owner sees nothing');
  });
});

test('a new tenant table (e.g. a product table) gets row-level security on the next migration run', async () => {
  const t = T.SCHEMA_PER_TENANT;
  const { controlDb } = await db();
  const target = targetOf(await controlDb.databaseConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId } }));
  await withConnection(ownerUrl(target), (c) => c.query(`CREATE TABLE "${t.schema}".invoices (id text PRIMARY KEY, tenant_id text NOT NULL, amount int)`));
  try {
    assert.ok((await securityProblems(target)).some((p) => p.startsWith('invoices:')), 'caught before the run');
    const report = await migrateAllTargets();
    assert.deepEqual(report.failed, []);
    assert.deepEqual(await securityProblems(target), []);
    // ...and the tenant role may use it, for its own rows only
    await asRole(t, async (q) => {
      await q(`INSERT INTO invoices VALUES ('i1', $1, 10)`, [t.tenantId]);
      await refused(q(`INSERT INTO invoices VALUES ('i2', $1, 10)`, [Other.tenantId]), /row-level security/);
    });
    assert.equal(await (await dataOf(t.tenantId)).user.count({ where: { tenantId: t.tenantId } }), 3);
  } finally {
    await withConnection(ownerUrl(target), (c) => c.query(`DROP TABLE "${t.schema}".invoices`));
  }
});
