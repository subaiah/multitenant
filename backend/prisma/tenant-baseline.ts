/**
 * Write a baseline tenant migration (the whole tenant schema, from empty)
 * when there are no tenant migrations yet. For CI and fresh checkouts; once
 * real migrations exist (npm run prisma:migrate:tenant) it does nothing.
 *
 *   npm run tenant:baseline
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMigrations, migrationsDir } from '../src/lib/tenant-migrations.js';

const dir = migrationsDir();
if (loadMigrations(dir).length > 0) {
  console.log(`Tenant migrations already exist in ${dir}; nothing to do.`);
} else {
  const out = spawnSync(
    'npx',
    ['prisma', 'migrate', 'diff', '--config', 'prisma.tenant.config.ts', '--from-empty', '--to-schema', 'prisma/tenant', '--script'],
    { encoding: 'utf8' },
  );
  if (out.status !== 0) {
    console.error(out.stderr || out.stdout);
    process.exit(1);
  }
  const target = join(dir, '00000000000000_baseline');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'migration.sql'), out.stdout);
  console.log(`Wrote ${join(target, 'migration.sql')}`);
}
