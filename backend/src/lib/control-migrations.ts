/**
 * Control-plane migrations (prisma/control/migrations), applied without the
 * Prisma CLI so a production image needs neither the CLI nor its schema
 * engine.
 *
 * Same bookkeeping as `prisma migrate deploy`: each migration is recorded in
 * `_prisma_migrations` with the same checksum (SHA-256 of migration.sql), so
 * this runner and `prisma migrate` agree on what has been applied and either
 * can be used against the same database. Each migration runs in its own
 * transaction; a session-level advisory lock means only one server or release
 * job migrates at a time.
 */
import crypto from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { config } from '../config/env.js';
import { loadMigrations, type Migration } from './tenant-migrations.js';

export function controlMigrationsDir(): string {
  return join(import.meta.dirname, '..', '..', 'prisma', 'control', 'migrations');
}

export interface ControlMigrateResult {
  applied: string[];
  /** Already applied, but the file has changed since (left alone, like Prisma does) */
  modified: string[];
}

export async function migrateControlPlane(url = config.databaseUrl, migrations: Migration[] = loadMigrations(controlMigrationsDir())): Promise<ControlMigrateResult> {
  if (migrations.length === 0) throw new Error(`No control-plane migrations in ${controlMigrationsDir()}`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['control-plane-migrations']);
    await client.query(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )`);
    const { rows } = await client.query<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }>(
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"',
    );
    // A migration that started and never finished needs a person: Prisma refuses to go on, and so do we
    const failed = rows.find((r) => !r.finished_at && !r.rolled_back_at);
    if (failed) {
      throw new Error(
        `Migration ${failed.migration_name} failed earlier and was never resolved. Fix the database, then mark it with ` +
          `\`npx prisma migrate resolve --applied ${failed.migration_name}\` (or --rolled-back) before migrating again.`,
      );
    }
    const done = new Map(rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => [r.migration_name, r.checksum]));
    const result: ControlMigrateResult = { applied: [], modified: [] };
    for (const m of migrations) {
      const recorded = done.get(m.name);
      if (recorded) {
        if (recorded !== m.checksum) result.modified.push(m.name);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          'INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES ($1, $2, $3, now(), now(), 1)',
          [crypto.randomUUID(), m.checksum, m.name],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Control-plane migration ${m.name} failed (nothing from it was applied): ${(err as Error).message}`);
      }
      result.applied.push(m.name);
    }
    return result;
  } finally {
    await client.end();
  }
}

/** Control-plane migrations this server's code expects but the database doesn't have yet. */
export async function pendingControlMigrations(url = config.databaseUrl): Promise<string[]> {
  const names = loadMigrations(controlMigrationsDir()).map((m) => m.name);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const exists = (await client.query(`SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS ok`)).rows[0].ok as boolean;
    if (!exists) return names;
    const applied = new Set(
      (await client.query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows.map(
        (r) => r.migration_name as string,
      ),
    );
    return names.filter((n) => !applied.has(n));
  } finally {
    await client.end();
  }
}
