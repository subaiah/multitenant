/**
 * Tenant migrations and row-level security, applied to every target.
 *
 * Migrations are the folders in prisma/tenant/migrations (made with
 * `npm run prisma:migrate:tenant`). They're applied as the migration owner and
 * recorded in each target's own `_prisma_migrations` table, the same table and
 * checksum Prisma uses, so `prisma migrate` and this runner agree on what has
 * been applied. Schema-per-tenant targets get the same SQL with the schema
 * swapped in.
 *
 * After migrating, every table with a tenant_id column gets row-level security
 * (ENABLE + FORCE, one policy for reads and writes): a row is visible only when
 * its tenant_id belongs to the connected login role, per tenant_roles. Product
 * tables are covered automatically. Then the target's roles get exactly the
 * privileges they need. Every step is safe to re-run.
 */
import crypto from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { config } from '../config/env.js';
import { controlDb } from './prisma.js';
import { sharedGroupRole, databaseOf, describeTarget, ident, ownerUrl, schemaOf, targetOf, type Target } from './tenant-targets.js';

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export const POLICY = 'tenant_isolation';
/** Tenant tables tenant roles may only insert into and read (lib/audit.ts) */
export const APPEND_ONLY_TABLES = ['audit_events'];
/** Bump when the policy text changes, so the next run replaces existing policies */
const POLICY_VERSION = 'v1';
/** Tables the tenant roles never touch */
const INTERNAL_TABLES = ['tenant_roles', '_prisma_migrations'];

export function migrationsDir(): string {
  return config.tenantMigrationsDir ?? join(import.meta.dirname, '..', '..', 'prisma', 'tenant', 'migrations');
}

export function loadMigrations(dir = migrationsDir()): Migration[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'migration.sql')))
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
      return { name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

let latestCache: { at: number; name: string | null } | null = null;

/** Name of the newest tenant migration this server knows about (re-read every 30 s). */
export function latestMigration(): string | null {
  if (!latestCache || Date.now() - latestCache.at > 30_000) {
    latestCache = { at: Date.now(), name: loadMigrations().at(-1)?.name ?? null };
  }
  return latestCache.name;
}

/** Ready tenants whose schema is older than the newest migration (or never recorded). */
export async function tenantsBehind(): Promise<number> {
  const latest = latestMigration();
  if (!latest) return 0;
  return controlDb.databaseConfig.count({
    where: { tenant: { provisioningStatus: 'READY' }, OR: [{ lastMigration: null }, { lastMigration: { not: latest } }] },
  });
}

let rollout: Promise<RolloutReport> | null = null;

/** migrateAllTargets, at most one run per server at a time (null if one is running). */
export function startRollout(): Promise<RolloutReport> | null {
  if (rollout) return null;
  rollout = migrateAllTargets().finally(() => {
    rollout = null;
  });
  return rollout;
}

export async function withConnection<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Take turns changing who may connect to a database: parallel GRANT/REVOKE on
 * one database collide in Postgres ("tuple concurrently updated"). Call inside
 * a transaction; the lock is held until it ends.
 */
export async function lockDatabaseAcl(c: pg.Client, database: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tenant-database-acl:${database}`]);
}

/** Login name in a connection string */
export const userOf = (url: string) => decodeURIComponent(new URL(url).username);

export interface TargetAccess {
  /** Roles that read and write the target's rows (the tenant role, or the shared-tables group) */
  grantees: string[];
  /** Login roles to map to their tenant in tenant_roles */
  tenantRoles: { role: string; tenantId: string }[];
  /** Login roles that may connect to the target's database (schema and database targets) */
  connectRoles: string[];
}

export interface MigrateResult {
  applied: string[];
  last: string | null;
}

/** Apply pending migrations to one target, then secure it. */
export async function migrateTarget(target: Target, access: TargetAccess, migrations = loadMigrations()): Promise<MigrateResult> {
  if (migrations.length === 0) {
    throw new Error(`No tenant migrations in ${migrationsDir()}. Create one with: npm run prisma:migrate:tenant`);
  }
  const schema = schemaOf(target);
  const s = ident(schema);
  return withConnection(ownerUrl(target), async (c) => {
    // One migration run per target at a time (parallel provisioning, several servers)
    await c.query('SELECT pg_advisory_lock(hashtext($1))', [`tenant-migrations:${schema}`]);
    if (target.kind === 'schema') await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`SET search_path TO ${s}`);
    await c.query(`CREATE TABLE IF NOT EXISTS ${s}."_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )`);
    const done = new Set(
      (await c.query(`SELECT migration_name FROM ${s}."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)).rows.map(
        (r) => r.migration_name as string,
      ),
    );
    const applied: string[] = [];
    for (const m of migrations) {
      if (done.has(m.name)) continue;
      // Prisma writes "public"."table"; a schema target gets its own schema instead
      const sql = target.kind === 'schema' ? m.sql.replaceAll('"public".', `${s}.`) : m.sql;
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query(
          `INSERT INTO ${s}."_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES ($1, $2, $3, now(), now(), 1)`,
          [crypto.randomUUID(), m.checksum, m.name],
        );
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed on ${describeTarget(target)}: ${(err as Error).message}`);
      }
      applied.push(m.name);
    }
    await secureTarget(c, target, access);
    return { applied, last: migrations.at(-1)!.name };
  });
}

/** The tables in a schema that carry tenant data (have a tenant_id column). */
export async function tenantTables(c: pg.Client, schema: string): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname <> ALL($2)
      ORDER BY c.relname`,
    [schema, INTERNAL_TABLES],
  );
  return rows.map((r) => r.relname as string);
}

/** Row-level security on every tenant table, and the target's grants. */
async function secureTarget(c: pg.Client, target: Target, access: TargetAccess) {
  const schema = schemaOf(target);
  const s = ident(schema);
  const platform = userOf(config.tenantPlatformUrl);

  await c.query('BEGIN');
  try {
    // Which tenant the connected login role belongs to. session_user is the
    // login role and can't be changed by SET ROLE; SECURITY DEFINER lets the
    // function read tenant_roles, which tenant roles themselves can't.
    await c.query(`CREATE OR REPLACE FUNCTION ${s}.current_tenant_id() RETURNS text
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $fn$ SELECT tenant_id FROM ${s}.tenant_roles WHERE role_name = session_user $fn$`);
    await c.query(`REVOKE ALL ON FUNCTION ${s}.current_tenant_id() FROM PUBLIC`);

    // Change only what's missing. The shared tables are live: re-running ALTER
    // TABLE or CREATE POLICY on them takes exclusive locks and can deadlock
    // with tenants writing to them, so a routine run touches nothing.
    const tables = await tenantTables(c, schema);
    const state = new Map(
      (
        await c.query(
          `SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                  (SELECT d.description FROM pg_policy p JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_policy'::regclass
                    WHERE p.polrelid = c.oid AND p.polname = $2) AS policy_version
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = ANY($3)`,
          [schema, POLICY, tables],
        )
      ).rows.map((r) => [r.relname as string, r]),
    );
    for (const t of tables) {
      const table = `${s}.${ident(t)}`;
      const st = state.get(t);
      if (!st?.enabled) await c.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      if (!st?.forced) await c.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      if (st?.policy_version !== POLICY_VERSION) {
        await c.query(`DROP POLICY IF EXISTS ${POLICY} ON ${table}`);
        await c.query(
          `CREATE POLICY ${POLICY} ON ${table} USING (tenant_id = ${s}.current_tenant_id()) WITH CHECK (tenant_id = ${s}.current_tenant_id())`,
        );
        await c.query(`COMMENT ON POLICY ${POLICY} ON ${table} IS '${POLICY_VERSION}'`);
      }
    }

    // Grants, only where missing (DELETE is granted last, so it stands for all four)
    const lacking = async (role: string, list: string[]) =>
      list.length
        ? (
            await c.query(
              `SELECT t FROM unnest($2::text[]) t WHERE NOT has_table_privilege($1, format('%I.%I', $3::text, t), 'DELETE')`,
              [role, list, schema],
            )
          ).rows.map((r) => `${s}.${ident(r.t)}`)
        : [];
    const dml = 'SELECT, INSERT, UPDATE, DELETE';
    // Append-only tables (the audit log): tenant roles may add and read rows, nothing else
    const appendOnly = tables.filter((t) => APPEND_ONLY_TABLES.includes(t));
    const readWrite = tables.filter((t) => !APPEND_ONLY_TABLES.includes(t));
    const lackingInsert = async (role: string) =>
      appendOnly.length
        ? (
            await c.query(
              `SELECT t FROM unnest($2::text[]) t WHERE NOT has_table_privilege($1, format('%I.%I', $3::text, t), 'INSERT')`,
              [role, appendOnly, schema],
            )
          ).rows.map((r) => `${s}.${ident(r.t)}`)
        : [];
    const canAlter = async (role: string) =>
      appendOnly.length
        ? (
            await c.query(
              `SELECT t FROM unnest($2::text[]) t
                WHERE has_table_privilege($1, format('%I.%I', $3::text, t), 'UPDATE')
                   OR has_table_privilege($1, format('%I.%I', $3::text, t), 'DELETE')
                   OR has_table_privilege($1, format('%I.%I', $3::text, t), 'TRUNCATE')`,
              [role, appendOnly, schema],
            )
          ).rows.map((r) => `${s}.${ident(r.t)}`)
        : [];

    // Tenant roles: rows in the tenant tables, nothing else, no DDL
    if (target.kind !== 'shared') await c.query(`REVOKE ALL ON SCHEMA ${s} FROM PUBLIC`);
    for (const role of access.grantees) {
      const r = ident(role);
      if (!(await c.query('SELECT has_schema_privilege($1, $2, $3) AS ok', [role, schema, 'USAGE'])).rows[0].ok) {
        await c.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
      }
      if (!(await c.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, `${s}.current_tenant_id()`])).rows[0].ok) {
        await c.query(`GRANT EXECUTE ON FUNCTION ${s}.current_tenant_id() TO ${r}`);
      }
      const missing = await lacking(role, readWrite);
      if (missing.length) await c.query(`GRANT ${dml} ON ${missing.join(', ')} TO ${r}`);
      const missingInsert = await lackingInsert(role);
      if (missingInsert.length) await c.query(`GRANT SELECT, INSERT ON ${missingInsert.join(', ')} TO ${r}`);
      const tooMuch = await canAlter(role);
      if (tooMuch.length) await c.query(`REVOKE UPDATE, DELETE, TRUNCATE ON ${tooMuch.join(', ')} FROM ${r}`);
    }
    // Platform role: every table in the schema (it bypasses row-level security)
    const all = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1`, [schema])).rows.map((r) => r.tablename as string);
    if (!(await c.query('SELECT has_schema_privilege($1, $2, $3) AS ok', [platform, schema, 'USAGE'])).rows[0].ok) {
      await c.query(`GRANT USAGE ON SCHEMA ${s} TO ${ident(platform)}`);
    }
    const platformMissing = await lacking(platform, all);
    if (platformMissing.length) await c.query(`GRANT ${dml} ON ${platformMissing.join(', ')} TO ${ident(platform)}`);

    for (const { role, tenantId } of access.tenantRoles) {
      await c.query(
        `INSERT INTO ${s}.tenant_roles (role_name, tenant_id) VALUES ($1, $2) ON CONFLICT (role_name) DO UPDATE SET tenant_id = EXCLUDED.tenant_id`,
        [role, tenantId],
      );
    }

    // Who may connect to the target's database at all. Grants on one database
    // from parallel runs (schema targets share the shared database) would
    // collide in Postgres ("tuple concurrently updated"), so take turns.
    await lockDatabaseAcl(c, databaseOf(target));
    const db = ident(databaseOf(target));
    if (target.kind === 'database') {
      await c.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
      await c.query(`GRANT CONNECT ON DATABASE ${db} TO ${ident(platform)}`);
    }
    if (access.connectRoles.length) {
      await c.query(`GRANT CONNECT ON DATABASE ${db} TO ${access.connectRoles.map(ident).join(', ')}`);
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw new Error(`Securing ${describeTarget(target)} failed: ${(err as Error).message}`);
  }
}

/**
 * Problems with row-level security on a target, for checks and tests: tenant
 * tables without ENABLE, FORCE or the policy. Empty when all is well.
 */
export async function securityProblems(target: Target): Promise<string[]> {
  const schema = schemaOf(target);
  return withConnection(ownerUrl(target), async (c) => {
    const tables = await tenantTables(c, schema);
    const { rows } = await c.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname AND p.policyname = $2) AS has_policy
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = ANY($3)`,
      [schema, POLICY, tables],
    );
    const problems: string[] = [];
    for (const r of rows) {
      if (!r.relrowsecurity) problems.push(`${r.relname}: row-level security not enabled`);
      if (!r.relforcerowsecurity) problems.push(`${r.relname}: row-level security not forced`);
      if (!r.has_policy) problems.push(`${r.relname}: no ${POLICY} policy`);
    }
    if (tables.length === 0) problems.push(`no tenant tables in ${describeTarget(target)}`);
    return problems;
  });
}


/** The access a target needs, given the tenants on it. */
export function accessFor(target: Target, tenants: { tenantId: string; role: string }[]): TargetAccess {
  return {
    grantees: target.kind === 'shared' ? [sharedGroupRole()] : tenants.map((t) => t.role),
    tenantRoles: tenants.map((t) => ({ role: t.role, tenantId: t.tenantId })),
    connectRoles: target.kind === 'shared' ? [] : tenants.map((t) => t.role),
  };
}

export interface RolloutReport {
  succeeded: { target: string; applied: string[] }[];
  failed: { target: string; error: string }[];
}

type ProvisioningStatus = 'READY' | 'FAILED' | 'PROVISIONING';

/**
 * Every target and the tenants on it (by default: READY, or part-way through
 * provisioning and so possibly holding tables). The shared database is always included.
 */
export async function listTargets(
  statuses: ProvisioningStatus[] = ['READY', 'FAILED', 'PROVISIONING'],
): Promise<{ target: Target; tenants: { tenantId: string; role: string }[] }[]> {
  const configs = await controlDb.databaseConfig.findMany({
    where: { dbRoleName: { not: null }, tenant: { provisioningStatus: { in: statuses } } },
    select: { tenantId: true, strategy: true, schemaName: true, databaseName: true, dbRoleName: true },
  });
  const shared = configs.filter((c) => c.strategy === 'SHARED_TABLES');
  return [
    { target: { kind: 'shared' }, tenants: shared.map((c) => ({ tenantId: c.tenantId, role: c.dbRoleName! })) },
    ...configs
      .filter((c) => c.strategy !== 'SHARED_TABLES')
      .map((c) => ({ target: targetOf(c), tenants: [{ tenantId: c.tenantId, role: c.dbRoleName! }] })),
  ];
}

/**
 * Migrate every target: the shared tenant database (always), and each
 * provisioned tenant's schema or database. Runs `concurrency` targets at a
 * time and records the outcome on each tenant's database config, so a failed
 * target is retried on the next run.
 */
export async function migrateAllTargets({ concurrency = 10 } = {}): Promise<RolloutReport> {
  const migrations = loadMigrations();
  const jobs = await listTargets();

  const report: RolloutReport = { succeeded: [], failed: [] };
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const name = describeTarget(job.target);
      const ids = job.tenants.map((t) => t.tenantId);
      try {
        const result = await migrateTarget(job.target, accessFor(job.target, job.tenants), migrations);
        report.succeeded.push({ target: name, applied: result.applied });
        await controlDb.databaseConfig.updateMany({
          where: { tenantId: { in: ids } },
          data: { lastMigration: result.last, migratedAt: new Date(), migrationError: null },
        });
      } catch (err) {
        // A tenant deleted during the run isn't a failure: its target is gone on purpose
        const still = job.target.kind === 'shared' ? 1 : await controlDb.tenant.count({ where: { id: { in: ids }, provisioningStatus: { not: 'DEPROVISIONING' } } });
        if (still === 0) continue;
        const error = (err as Error).message;
        report.failed.push({ target: name, error });
        await controlDb.databaseConfig.updateMany({ where: { tenantId: { in: ids } }, data: { migrationError: error } });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return report;
}
