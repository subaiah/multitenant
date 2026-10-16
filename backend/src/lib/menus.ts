/**
 * The sidebar menus in the database (menu_items), from kit/menu-definitions.ts.
 *
 * syncMenus runs in the release step (cli/migrate.ts): it adds entries a new
 * version introduced and leaves existing ones alone, so changes made on the
 * Menu settings (labels, order, switched off) survive upgrades. An entry is
 * matched by portal, its parent and its path.
 */
import { controlDb } from './prisma.js';
import { MENUS, type MenuSeed, type Portal } from '../kit/menu-definitions.js';

type Db = Pick<typeof controlDb, 'menuItem'>;

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
      for (const portal of ['PLATFORM', 'TENANT'] as const) added += await addMissing(tx, portal, MENUS[portal], null);
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
