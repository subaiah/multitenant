/**
 * The sidebar menus in the database (menu_items), from kit/menu-definitions.ts.
 *
 * syncMenus runs in the release step (cli/migrate.ts): it adds entries a new
 * version introduced and leaves existing ones alone, so changes made on the
 * Menu settings (labels, order, switched off) survive upgrades. An entry is
 * matched by portal, its parent and its path. The one exception: entries of
 * the menus from before sections that now sit in a section are moved there.
 */
import { controlDb } from './prisma.js';
import { MENUS, type MenuSeed, type Portal } from '../kit/menu-definitions.js';

type Db = Pick<typeof controlDb, 'menuItem'>;

/** Default names of top-level entries in the menus from before sections */
const LEGACY_LABELS: Record<Portal, string[]> = {
  PLATFORM: ['Tenants', 'Applications', 'Platform Users', 'Global Policies', 'Support', 'Audit Log'],
  TENANT: ['Applications', 'Organizations', 'Entitlements', 'Activity Log', 'Audit Log', 'Infrastructure', 'Data Isolation', 'Authentication', 'API', 'Settings'],
};

async function addMissing(db: Db, portal: Portal, items: MenuSeed[], parentId: string | null): Promise<number> {
  let added = 0;
  for (const [order, item] of items.entries()) {
    let row = await db.menuItem.findFirst({ where: { portal, parentId, path: item.path }, orderBy: { createdAt: 'asc' } });
    if (!row) {
      row = await db.menuItem.create({
        data: { portal, parentId, label: item.label, path: item.path, icon: item.icon, permission: item.permission, order, isActive: true },
      });
      added += 1;
    }
    if (item.children) added += await addMissing(db, portal, item.children, row.id);
  }
  return added;
}

/** Add the menu entries that are missing; returns how many were added. */
export async function syncMenus(): Promise<number> {
  // One release step at a time (two adding the same entry would duplicate it)
  return controlDb.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('menu-sync'))`;
      let added = 0;
      for (const portal of ['PLATFORM', 'TENANT'] as const) {
        // Menus from before sections: the old top-level entries that now sit
        // in a section (still with their default names) and the tenant
        // portal's "Access" group are removed, so nothing is listed twice
        const legacy = portal === 'TENANT' && (await tx.menuItem.findFirst({ where: { portal, parentId: null, path: '/users', children: { some: {} } } }));
        if (legacy) {
          await tx.menuItem.deleteMany({ where: { parentId: legacy.id } });
          await tx.menuItem.delete({ where: { id: legacy.id } });
        }
        const moved = MENUS[portal].filter((m) => m.path.startsWith('#')).flatMap((m) => (m.children ?? []).map((c) => c.path));
        await tx.menuItem.deleteMany({ where: { portal, parentId: null, path: { in: moved }, label: { in: LEGACY_LABELS[portal] } } });
        added += await addMissing(tx, portal, MENUS[portal], null);
      }
      return added;
    },
    { timeout: 60_000 },
  );
}

/** Replace every menu entry with the definitions (development: npm run prisma:seed-menus -- --reset). */
export async function resetMenus(): Promise<number> {
  await controlDb.menuItem.deleteMany({ where: { parentId: { not: null } } });
  await controlDb.menuItem.deleteMany({});
  return syncMenus();
}
