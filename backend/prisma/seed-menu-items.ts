/**
 * The sidebar menus for both portals (src/kit/menu-definitions.ts).
 *
 *   npm run prisma:seed-menus              add missing entries (the release step does this too)
 *   npm run prisma:seed-menus -- --reset   replace every entry with the definitions
 */
import { disconnectDatabases } from '../src/lib/prisma.js';
import { resetMenus, syncMenus } from '../src/lib/menus.js';

const reset = process.argv.includes('--reset');
try {
  const added = reset ? await resetMenus() : await syncMenus();
  console.log(`✅ ${reset ? 'Replaced the menus' : 'Menus up to date'}: ${added} entries added`);
} catch (error) {
  console.error('❌ Error seeding menu items:', error);
  process.exitCode = 1;
} finally {
  await disconnectDatabases();
}
