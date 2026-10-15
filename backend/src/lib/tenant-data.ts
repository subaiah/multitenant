/**
 * Work on a tenant's data as a whole: setting up its defaults and deleting it.
 */
import { createDefaultTenantRoles } from '../utils/authorization.js';
import type { TenantDb } from './tenant-db.js';
import { product } from '../product/index.js';
import { config } from '../config/env.js';
import { tenantTables, withConnection } from './tenant-migrations.js';
import { databaseOf, ident, schemaOf, withConnection as withUrl, type Target } from './tenant-targets.js';

/** The defaults every tenant starts with (sign-in and API settings, built-in roles), then the product's. Run as the tenant's role. */
export async function createTenantDefaults(tenantId: string, db: TenantDb) {
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
 * Delete every row a tenant owns on a target: every table with a tenant_id
 * column, kit and product alike. Runs as the platform role. Tables are retried
 * in passes until foreign keys stop getting in the way, so it works whatever
 * the order of the tables and whether or not their foreign keys cascade.
 */
export async function deleteTenantData(tenantId: string, target: Target): Promise<void> {
  const url = withUrl(config.tenantPlatformUrl, { database: databaseOf(target) });
  const schema = schemaOf(target);
  await withConnection(url, async (c) => {
    let remaining = await tenantTables(c, schema);
    await c.query('BEGIN');
    try {
      for (let pass = 0; remaining.length > 0; pass++) {
        const blocked: string[] = [];
        let lastError: Error | null = null;
        for (const t of remaining) {
          await c.query('SAVEPOINT del');
          try {
            await c.query(`DELETE FROM ${ident(schema)}.${ident(t)} WHERE tenant_id = $1`, [tenantId]);
            await c.query('RELEASE SAVEPOINT del');
          } catch (err) {
            await c.query('ROLLBACK TO SAVEPOINT del');
            blocked.push(t);
            lastError = err as Error;
          }
        }
        if (blocked.length === remaining.length) throw lastError ?? new Error('Could not delete tenant rows');
        remaining = blocked;
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  });
}
