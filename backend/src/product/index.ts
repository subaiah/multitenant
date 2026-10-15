/**
 * Your product. Everything product-specific plugs in here; the kit calls it.
 * The starter ships an empty product. See docs/extending.md for a worked
 * example (an "invoices" feature: table, permissions, routes, menu, seed).
 */
import type { ProductModule } from '../kit/product.js';

export const product: ProductModule = {
  name: 'Starter',
  permissions: [],
  resources: {},
  userTypeGrants: {},
  routes: async () => {},
  tenantMenu: [],
};
