/**
 * The one place that decides which database holds a tenant's data.
 *
 * Today every tenant is on the shared tenant database, so this always returns
 * the shared client. Schema-per-tenant and database-per-tenant (later phases
 * of the isolation design) resolve the tenant's own client here, from its
 * database config, without touching any route.
 */
import { tenantDb, type TenantDb } from './prisma.js';

export type { TenantDb };

export function dbForTenant(_tenantId: string): TenantDb {
  return tenantDb;
}
