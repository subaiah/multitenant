/**
 * The external products an organization has on, with the pages a person may
 * open in each: the tenant portal's menu (routes/menu-items.ts) and the
 * application launcher (lib/product-embeds.ts) both use this, so they agree.
 */
import { controlDb } from './prisma.js';
import { getEnhancedUserPermissions } from '../utils/authorization.js';
import { isScopeAware, permissionMatches } from '../utils/permissions.js';

/** What a person holds for showing pages: everywhere, or anywhere for permissions that pages narrow themselves */
export async function grantedForMenus(userId: string, tenantId: string, userType: string): Promise<Set<string>> {
  const { permissions, scoped } = await getEnhancedUserPermissions(userId, tenantId, userType);
  return new Set([...permissions, ...scoped.filter((g) => isScopeAware(g.permission)).map((g) => g.permission)]);
}

/** The products the organization has on now (and set up), each with the menu entries this person may use */
export async function productsWithEntries(tenantId: string, granted: Set<string>) {
  const now = new Date();
  const apps = await controlDb.applicationRegistry.findMany({
    where: {
      status: 'ACTIVE',
      baseUrl: { not: null },
      menuItems: { some: {} },
      // Once it has set the organization up (lib/product-lifecycle.ts)
      tenantApplications: { some: { tenantId, state: { in: ['ENABLED', 'TRIAL'] }, provisioningStatus: { in: ['READY', 'NOT_REQUIRED'] }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] } },
    },
    include: { menuItems: { orderBy: { order: 'asc' } } },
    orderBy: { name: 'asc' },
  });
  return apps
    .map((app) => ({ app, entries: app.menuItems.filter((i) => !i.permission || permissionMatches(granted, i.permission)) }))
    .filter((p) => p.entries.length > 0);
}

/** Menu sections for the external products an organization has on now, with the entries this person may use */
export async function productSections(tenantId: string, granted: Set<string>) {
  const products = await productsWithEntries(tenantId, granted);
  return products
    .map(({ app, entries }, n) => ({
      id: `app:${app.id}`,
      portal: 'TENANT' as const,
      parentId: null,
      label: app.name,
      path: `#app-${app.key}`,
      icon: 'Package',
      permission: null,
      order: n,
      isActive: true,
      children: entries
        .map((i) => ({
          id: `app-item:${i.id}`,
          portal: 'TENANT' as const,
          parentId: `app:${app.id}`,
          label: i.label,
          // Opens in the product, which signs the person in with this account
          path: `${app.baseUrl}${i.path}`,
          external: true,
          icon: i.icon,
          permission: i.permission,
          order: i.order,
          isActive: true,
        })),
    }));
}

