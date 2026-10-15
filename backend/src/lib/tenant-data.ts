/**
 * Work on a tenant's data as a whole: setting up its defaults, counting it
 * for platform pages, and deleting it. The tenant plane has no foreign keys to
 * the control plane, so deleting a tenant row no longer cascades; these
 * helpers do it explicitly.
 */
import { createDefaultTenantRoles } from '../utils/authorization.js';
import { dbForTenant, type TenantDb } from './tenant-db.js';
import { product } from '../product/index.js';

/** The defaults every tenant starts with (sign-in and API settings, built-in roles), then the product's. */
export async function createTenantDefaults(tenantId: string, db: TenantDb = dbForTenant(tenantId)) {
  await db.authConfig.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId, mfaEnabled: false, sessionTimeout: 60, passwordPolicy: 'STANDARD', ssoOnly: false, otpEnabled: true },
  });
  await db.apiConfig.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId, apiGateway: 'CUSTOM', rateLimit: 1000, corsEnabled: true, allowedOrigins: [], authType: 'JWT', versioning: 'URL' },
  });
  await createDefaultTenantRoles(tenantId, db);
  await product.onTenantCreated?.(tenantId, db);
}

/**
 * Delete everything a tenant owns in the tenant plane. Children first, so it
 * works whether or not the tenant database has cascading foreign keys.
 */
export async function deleteTenantData(tenantId: string, db: TenantDb = dbForTenant(tenantId)) {
  const where = { where: { tenantId } };
  await db.$transaction([
    db.certificationDecision.deleteMany(where),
    db.accessCertification.deleteMany(where),
    db.accessRequest.deleteMany(where),
    db.delegation.deleteMany(where),
    db.policyBinding.deleteMany(where),
    db.accessPolicy.deleteMany(where),
    db.roleAssignment.deleteMany(where),
    db.rolePermission.deleteMany(where),
    db.role.deleteMany(where),
    db.groupMembership.deleteMany(where),
    db.group.deleteMany(where),
    db.orgMembership.deleteMany(where),
    db.orgUnit.deleteMany(where),
    db.organization.deleteMany(where),
    db.userToken.deleteMany(where),
    db.refreshToken.deleteMany(where),
    db.otpCode.deleteMany(where),
    db.oAuthSession.deleteMany(where),
    db.authProvider.deleteMany(where),
    db.authConfig.deleteMany(where),
    db.apiConfig.deleteMany(where),
    db.application.deleteMany(where),
    db.activity.deleteMany(where),
    db.tenantDbRole.deleteMany(where),
    db.user.deleteMany(where),
  ]);
}

/**
 * The tenant databases holding these tenants, each with the tenant ids it
 * holds, for cross-tenant reads on platform pages. Queries against each
 * database must still filter by those ids.
 */
export function groupByDatabase(tenantIds: string[]): Map<TenantDb, string[]> {
  const byDb = new Map<TenantDb, string[]>();
  for (const id of tenantIds) {
    const db = dbForTenant(id);
    byDb.set(db, [...(byDb.get(db) ?? []), id]);
  }
  return byDb;
}

export interface TenantCounts {
  users: number;
  applications: number;
  lastActiveAt: Date | null;
}

/**
 * Users, applications and last activity for several tenants, for platform
 * pages. Grouped by the database each tenant lives in (today all share one).
 */
export async function countTenantData(tenantIds: string[]): Promise<Map<string, TenantCounts>> {
  const result = new Map<string, TenantCounts>(tenantIds.map((id) => [id, { users: 0, applications: 0, lastActiveAt: null }]));
  for (const [db, ids] of groupByDatabase(tenantIds)) {
    const where = { tenantId: { in: ids } };
    const [users, apps, activity] = await Promise.all([
      db.user.groupBy({ by: ['tenantId'], where, _count: true }),
      db.application.groupBy({ by: ['tenantId'], where, _count: true }),
      db.activity.groupBy({ by: ['tenantId'], where, _max: { createdAt: true } }),
    ]);
    for (const r of users) result.get(r.tenantId)!.users = r._count;
    for (const r of apps) result.get(r.tenantId)!.applications = r._count;
    for (const r of activity) result.get(r.tenantId)!.lastActiveAt = r._max.createdAt;
  }
  return result;
}
