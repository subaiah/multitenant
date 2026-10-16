/**
 * Apply tenant migrations to every target: the shared tenant database and
 * each tenant's own schema or database. Safe to re-run; failed targets are
 * retried next time.
 *
 *   npm run tenant:migrate
 */
import { migrateAllTargets } from '../lib/tenant-migrations.js';
import { disconnectDatabases } from '../lib/prisma.js';

migrateAllTargets()
  .then(({ succeeded, failed }) => {
    for (const s of succeeded) console.log(`ok      ${s.target}${s.applied.length ? `: applied ${s.applied.join(', ')}` : ': up to date'}`);
    for (const f of failed) console.log(`FAILED  ${f.target}: ${f.error}`);
    console.log(`\n${succeeded.length} succeeded, ${failed.length} failed`);
    process.exitCode = failed.length ? 1 : 0;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(disconnectDatabases);
