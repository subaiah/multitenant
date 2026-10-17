/**
 * The release step: bring every database up to this version's schema before
 * the new servers start. Control plane first (servers refuse to start in
 * production while it is behind) and the menu entries this version adds,
 * then every tenant target. Safe to re-run,
 * and safe to run while another copy runs (each plane takes a lock).
 *
 *   npm run migrate                   (development, through tsx)
 *   node dist/cli/migrate.js          (the production image; see deploy/)
 *   ... --control-only                skip tenant targets
 */
import { migrateControlPlane } from '../lib/control-migrations.js';

const controlOnly = process.argv.includes('--control-only');
let failed = false;

try {
  const control = await migrateControlPlane();
  console.log(`control plane: ${control.applied.length ? `applied ${control.applied.join(', ')}` : 'up to date'}`);
  for (const m of control.modified) console.warn(`control plane: ${m} was changed after it was applied (ignored)`);
  // Menu entries this version adds (existing ones, and changes made to them, stay)
  const { syncMenus } = await import('../lib/menus.js');
  const added = await syncMenus();
  console.log(`menus: ${added ? `added ${added} entries` : 'up to date'}`);

  if (!controlOnly) {
    // Imported after the control plane is current: the Prisma client reads it
    const { migrateAllTargets } = await import('../lib/tenant-migrations.js');
    const { succeeded, failed: bad } = await migrateAllTargets();
    for (const s of succeeded) console.log(`tenants: ${s.target}${s.applied.length ? `: applied ${s.applied.join(', ')}` : ': up to date'}`);
    for (const f of bad) console.error(`tenants: FAILED ${f.target}: ${f.error}`);
    console.log(`tenants: ${succeeded.length} succeeded, ${bad.length} failed`);
    failed = bad.length > 0;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  failed = true;
} finally {
  const { disconnectDatabases } = await import('../lib/prisma.js');
  await disconnectDatabases();
}
process.exit(failed ? 1 : 0);
