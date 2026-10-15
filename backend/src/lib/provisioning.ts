/**
 * Provisioning: turning a tenant row into a place its data can live, and
 * removing it again. A platform admin authorises it (POST /tenants); the job
 * runs in the background under the provisioner and migration-owner accounts,
 * so nobody types database credentials.
 *
 * States (Tenant.provisioningStatus):
 *   PENDING -> PROVISIONING -> READY        (sign-in allowed only when READY)
 *                           -> FAILED       (error stored; Retry runs it again)
 *   any     -> DEPROVISIONING -> (removed)  (on failure it stays DEPROVISIONING with
 *                                            the error; deleting again retries)
 *
 * Steps, each safe to re-run so Retry picks up where it stopped:
 *  1. Pick the tenant's role name (once) and password (kept, encrypted, in the
 *     connection string, so a retry reuses it).
 *  2. Create or update the role (provisioner); shared-tables roles join the shared group (<prefix>shared).
 *  3. Create the database (database per tenant); the schema is created by step 4.
 *  4. Migrate the target and apply row-level security and grants (owner).
 *  5. As the tenant's own role: defaults, built-in roles, the first administrator.
 *  6. Invite the first administrator (once).
 */
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { closeTenantClients, controlDb } from './prisma.js';
import { dbForTenant, forgetTenant } from './tenant-db.js';
import { createTenantDefaults, deleteTenantData } from './tenant-data.js';
import { decryptSecret, secretContext } from './secrets.js';
import { sendInvitation } from './invitations.js';
import { logPlatformActivity } from './activity.js';
import { refreshTenantUsage } from './tenant-usage.js';
import { accessFor, lockDatabaseAcl, migrateTarget, userOf, withConnection } from './tenant-migrations.js';
import {
  sharedGroupRole, databaseOf, ident, ownerUrl, roleNameFor, sharedDatabaseName, targetOf, tenantRoleUrl, type Target,
} from './tenant-targets.js';

/** SCRAM-SHA-256 verifier, so the plain password never appears in SQL (or server logs). */
export function scramVerifier(password: string, iterations = 4096): string {
  const salt = crypto.randomBytes(16);
  const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

const running = new Map<string, Promise<void>>();

/** Run provisioning in the background (or join the run already going). */
export function startProvisioning(tenantId: string): Promise<void> {
  const existing = running.get(tenantId);
  if (existing) return existing;
  const job = provisionTenant(tenantId).finally(() => running.delete(tenantId));
  running.set(tenantId, job);
  return job;
}

/** How long a PENDING or PROVISIONING tenant goes untouched before it's taken to be abandoned (e.g. by a restart). */
const STALE_MS = 2 * 60_000;

/**
 * Resume provisioning abandoned part-way (the server restarted mid-job).
 * Runs at startup and on each usage-refresh tick. Only tenants untouched for
 * a couple of minutes are resumed, so a job still running elsewhere isn't
 * started twice.
 */
export async function resumeProvisioning(): Promise<void> {
  const stuck = await controlDb.tenant.findMany({
    where: { provisioningStatus: { in: ['PENDING', 'PROVISIONING'] }, updatedAt: { lt: new Date(Date.now() - STALE_MS) } },
    select: { id: true },
  });
  for (const t of stuck) void startProvisioning(t.id).catch(() => {});
}

/** Provision a tenant. Records FAILED with the error instead of throwing. */
export async function provisionTenant(tenantId: string): Promise<void> {
  await controlDb.tenant.update({ where: { id: tenantId }, data: { provisioningStatus: 'PROVISIONING', provisioningError: null } });
  try {
    await runSteps(tenantId);
    await controlDb.tenant.update({
      where: { id: tenantId },
      data: { provisioningStatus: 'READY', provisioningError: null, provisionedAt: new Date() },
    });
    await refreshTenantUsage([tenantId]).catch(() => {});
  } catch (err) {
    await controlDb.tenant
      .update({ where: { id: tenantId }, data: { provisioningStatus: 'FAILED', provisioningError: describeError(err) } })
      .catch(() => {});
  }
}

/** Errors shown to platform admins: the message only, never connection details. */
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/postgres(ql)?:\/\/\S+/gi, '[connection]').slice(0, 1000);
}

async function runSteps(tenantId: string) {
  const tenant = await controlDb.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { databaseConfig: true } });
  const cfg = tenant.databaseConfig;
  if (!cfg) throw new Error('Tenant has no database config');

  // 1. Role name (fixed once) and password (reused on retries)
  const role = cfg.dbRoleName ?? roleNameFor(tenant.slug);
  const name = { schemaName: cfg.strategy === 'SCHEMA_PER_TENANT' ? cfg.schemaName ?? role : null, databaseName: cfg.strategy === 'DATABASE_PER_TENANT' ? cfg.databaseName ?? role : null };
  const target = targetOf({ strategy: cfg.strategy, ...name });
  const password = cfg.connectionString
    ? decodeURIComponent(new URL(decryptSecret(cfg.connectionString, secretContext('connectionString'))).password)
    : crypto.randomBytes(32).toString('base64url');
  await controlDb.databaseConfig.update({
    where: { tenantId },
    data: { dbRoleName: role, ...name, tenantColumn: 'tenant_id', connectionString: tenantRoleUrl(target, role, password) },
  });
  forgetTenant(tenantId);

  // 2-3. Role, and the database for database-per-tenant
  await withConnection(config.tenantProvisionerUrl, async (c) => {
    const verifier = scramVerifier(password);
    const exists = (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount;
    const limit = Number(config.tenantRoleConnectionLimit);
    await c.query(
      exists
        ? // Only a superuser may touch SUPERUSER/BYPASSRLS, even to turn them off; a role we created never has them
          `ALTER ROLE ${ident(role)} WITH LOGIN CONNECTION LIMIT ${limit} PASSWORD '${verifier}'`
        : `CREATE ROLE ${ident(role)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT ${limit} PASSWORD '${verifier}'`,
    );
    if (target.kind === 'shared') {
      if (!(await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [sharedGroupRole()])).rowCount) {
        await c.query(`CREATE ROLE ${ident(sharedGroupRole())} NOLOGIN`);
      }
      await c.query(`GRANT ${ident(sharedGroupRole())} TO ${ident(role)}`);
    }
    if (target.kind === 'database') {
      const db = (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [target.database])).rowCount;
      if (!db) await c.query(`CREATE DATABASE ${ident(target.database)} OWNER ${ident(userOf(config.tenantDatabaseUrl))}`);
    }
  });

  // 4. Tables, row-level security and grants
  const migrated = await migrateTarget(target, accessFor(target, [{ tenantId, role }]));
  await controlDb.databaseConfig.update({ where: { tenantId }, data: { lastMigration: migrated.last, migratedAt: new Date(), migrationError: null } });

  // 5. Everything from here runs as the tenant's own role
  const db = await dbForTenant(tenantId);
  await createTenantDefaults(tenantId, db);
  let admin: { id: string; email: string; status: string } | null = null;
  if (tenant.initialAdminEmail) {
    admin =
      (await db.user.findFirst({ where: { tenantId, email: tenant.initialAdminEmail }, select: { id: true, email: true, status: true } })) ??
      (await db.user.create({
        data: { tenantId, email: tenant.initialAdminEmail, name: tenant.initialAdminName, userType: 'TENANT_ADMIN', status: 'PENDING' },
        select: { id: true, email: true, status: true },
      }));
  }

  // 6. Invite the first administrator, once
  if (admin && admin.status === 'PENDING' && !tenant.adminInvitedAt && tenant.createdById) {
    await sendInvitation(tenant, admin, tenant.createdById);
    await controlDb.tenant.update({ where: { id: tenantId }, data: { adminInvitedAt: new Date() } });
  }
}

/**
 * Remove a tenant's data and database access, then its control-plane rows.
 * Safe to re-run: every step checks first. Throws on failure (the tenant stays
 * listed as DEPROVISIONING with the error, so deleting again retries).
 */
export async function deprovisionTenant(tenantId: string, actorId?: string): Promise<void> {
  const tenant = await controlDb.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { databaseConfig: true } });
  await controlDb.tenant.update({ where: { id: tenantId }, data: { provisioningStatus: 'DEPROVISIONING', provisioningError: null } });
  try {
    const cfg = tenant.databaseConfig;
    const role = cfg?.dbRoleName;
    if (cfg && role) {
      const target: Target = targetOf(cfg);
      if (target.kind === 'shared') {
        // Its rows, kit and product tables alike, then its role mapping
        await deleteTenantData(tenantId, target);
        await withConnection(ownerUrl(target), (c) => c.query('DELETE FROM public.tenant_roles WHERE role_name = $1', [role]));
      }
      // Close our own connections first: as that role, and (database per tenant) to that database
      const url = cfg.connectionString ? decryptSecret(cfg.connectionString, secretContext('connectionString')) : null;
      await closeTenantClients((u) => u === url || (target.kind === 'database' && new URL(u).pathname === `/${target.database}`));
      forgetTenant(tenantId);

      if (target.kind === 'schema') {
        await withConnection(ownerUrl(target), async (c) => {
          await c.query(`DROP SCHEMA IF EXISTS ${ident(target.schema)} CASCADE`);
          if ((await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount) {
            await c.query('BEGIN');
            await lockDatabaseAcl(c, sharedDatabaseName());
            await c.query(`REVOKE ALL ON DATABASE ${ident(sharedDatabaseName())} FROM ${ident(role)}`);
            await c.query('COMMIT');
          }
        });
      }
      await withConnection(config.tenantProvisionerUrl, async (c) => {
        if (target.kind === 'database') await c.query(`DROP DATABASE IF EXISTS ${ident(databaseOf(target))} WITH (FORCE)`);
        await c.query(`DROP ROLE IF EXISTS ${ident(role)}`);
      });
    }

    await controlDb.$transaction([
      controlDb.supportSession.deleteMany({ where: { tenantId } }),
      controlDb.tenantApplication.deleteMany({ where: { tenantId } }),
      controlDb.tenantUsage.deleteMany({ where: { tenantId } }),
      controlDb.databaseConfig.deleteMany({ where: { tenantId } }),
      controlDb.tenant.delete({ where: { id: tenantId } }),
    ]);
    await logPlatformActivity({ tenantId, userId: actorId, action: 'deleted tenant', target: `${tenant.name} (${tenant.slug})`, type: 'CONFIG' });
  } catch (err) {
    await controlDb.tenant
      .update({ where: { id: tenantId }, data: { provisioningError: `Deleting failed: ${describeError(err)}` } })
      .catch(() => {});
    throw err;
  }
}
