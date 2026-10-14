/**
 * Seeds the sidebar menus for both portals.
 *
 *   npx tsx prisma/seed-menu-items.ts          # only if no menu items exist
 *   npx tsx prisma/seed-menu-items.ts --reset  # replace existing menu items
 *
 * Every `permission` must be in src/utils/permissions.ts (checked by
 * test/permissions.test.ts) and every `path` must be a route in src/App.tsx.
 */
import { prisma, pool } from '../src/lib/prisma.js';

import { MENUS, type MenuSeed, type Portal } from './menu-definitions.js';

async function createItems(portal: Portal, items: MenuSeed[], parentId: string | null = null) {
  let count = 0;
  for (const [order, item] of items.entries()) {
    const created = await prisma.menuItem.create({
      data: {
        portal,
        parentId,
        label: item.label,
        path: item.path,
        icon: item.icon,
        permission: item.permission,
        order,
        isActive: true,
      },
    });
    count += 1 + (item.children ? await createItems(portal, item.children, created.id) : 0);
  }
  return count;
}

async function seedMenuItems() {
  const reset = process.argv.includes('--reset');
  const existing = await prisma.menuItem.count();

  if (existing > 0 && !reset) {
    console.log(`⚠️  Found ${existing} existing menu items. Skipping. Re-run with --reset to replace them.`);
    return;
  }
  if (reset && existing > 0) {
    // Children first (self-relation)
    await prisma.menuItem.deleteMany({ where: { parentId: { not: null } } });
    await prisma.menuItem.deleteMany({});
    console.log(`🗑️  Removed ${existing} existing menu items`);
  }

  for (const portal of ['PLATFORM', 'TENANT'] as const) {
    const count = await createItems(portal, MENUS[portal]);
    console.log(`✅ Created ${count} ${portal.toLowerCase()} menu items`);
  }
}

seedMenuItems()
  .catch((error) => {
    console.error('❌ Error seeding menu items:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
