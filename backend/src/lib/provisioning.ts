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
import pg from 'pg';
import { AppError } from '../middleware/error-handler.js';
import { config } from '../config/env.js';
import { closeTenantClients, controlDb } from './prisma.js';
import { dbForTenant, forgetTenant } from './tenant-db.js';
import { createTenantDefaults, deleteTenantData } from './tenant-data.js';
import { archiveChain, platformActor, recordAudit } from './audit.js';
import { decryptSecret, secretContext } from './secrets.js';
import { sendInvitation } from './invitations.js';
import { sendMail } from './mailer.js';
import { organizationReadyEmail } from './email-templates.js';
import { appOriginForTenant } from './domains.js';
import { logPlatformActivity } from './activity.js';
import { refreshTenantUsage } from './tenant-usage.js';
import { accessFor, lockDatabaseAcl, migrateTarget, userOf, withConnection } from './tenant-migrations.js';
import { removeTenantExports } from './data-export.js';
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

/**
 * One job at a time per tenant, across every app server: provisioning,
 * deleting and rotating credentials take a session advisory lock in the
 * control database for as long as they run. Returns null (without running
 * fn) when another job holds it.
 */
async function withTenantJobLock<T>(tenantId: string, fn: () => Promise<T>, waitMs = 0): Promise<{ value: T } | null> {
  const c = new pg.Client({ connectionString: config.databaseUrl });
  await c.connect();
  try {
    const key = `tenant-job:${tenantId}`;
    // Actions people start (delete, rotate) wait briefly for a job that's finishing
    const until = Date.now() + waitMs;
    while (!(await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [key])).rows[0].ok) {
      if (Date.now() >= until) return null;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    try {
      return { value: await fn() };
    } finally {
      await c.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => {});
    }
  } finally {
    await c.end().catch(() => {});
  }
}

export const BUSY_MESSAGE = 'Something else is changing this tenant right now (setting it up, deleting it or rotating its credentials). Try again in a moment.';

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

/**
 * Provision a tenant. Records FAILED with the error instead of throwing.
 * Does nothing if another server is already working on this tenant.
 */
export async function provisionTenant(tenantId: string): Promise<void> {
  const outcome = await withTenantJobLock(tenantId, async () => {
    const tenant = await controlDb.tenant.findUnique({ where: { id: tenantId }, include: { databaseConfig: { select: { strategy: true } } } });
    // Gone, being deleted, or finished by another server in the meantime
    if (!tenant || tenant.provisioningStatus === 'DEPROVISIONING' || tenant.provisioningStatus === 'READY') return null;
    const audit = { tenantId, userId: null, target: `${tenant.name} (${tenant.slug})`, type: 'CONFIG' as const };
    await controlDb.tenant.update({ where: { id: tenantId }, data: { provisioningStatus: 'PROVISIONING', provisioningError: null } });
    try {
      await runSteps(tenantId);
      await controlDb.tenant.update({
        where: { id: tenantId },
        data: { provisioningStatus: 'READY', provisioningError: null, provisionedAt: new Date() },
      });
      return { audit, ok: true as const, isolation: tenant.databaseConfig?.strategy ?? null };
    } catch (err) {
      const error = describeError(err);
      await controlDb.tenant.update({ where: { id: tenantId }, data: { provisioningStatus: 'FAILED', provisioningError: error } }).catch(() => {});
      return { audit, ok: false as const, error };
    }
  });
  // Bookkeeping after the lock is released, so the tenant is free to change at once
  const result = outcome?.value;
  if (!result) return;
  if (result.ok) {
    await logPlatformActivity({ ...result.audit, action: 'tenant set up', metadata: { isolation: result.isolation } }).catch(() => {});
    await recordAudit({ actor: { type: 'SYSTEM' } }, 'tenant.provisioned', { tenantId, resource: { type: 'tenant', id: tenantId, label: result.audit.target }, details: { isolation: result.isolation } }).catch(() => {});
    await refreshTenantUsage([tenantId]).catch(() => {});
  } else {
    await logPlatformActivity({ ...result.audit, action: 'tenant setup failed', type: 'ALERT', metadata: { error: result.error } }).catch(() => {});
    await recordAudit({ actor: { type: 'SYSTEM' } }, 'tenant.provisioning_failed', { outcome: 'FAILURE', tenantId, resource: { type: 'tenant', id: tenantId, label: result.audit.target }, details: { error: result.error } }).catch(() => {});
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

  // 6. Bring in the first administrator, once: invited by the platform user
  // who created the tenant, or, for someone who signed up, given the password
  // they chose then (routes/signup.ts) and told the organization is ready
  if (admin && admin.status === 'PENDING' && !tenant.adminInvitedAt) {
    let inviteError: string | null = null;
    if (tenant.createdById) {
      // The tenant is ready either way: a failed email is recorded, and the
      // invitation can be resent (or its link shared) from the Tenants page
      const invite = await sendInvitation(tenant, admin, tenant.createdById);
      inviteError = invite.sent ? null : (invite.error ?? 'The email could not be sent');
    } else {
      const signup = await controlDb.signupRequest.findUnique({ where: { tenantId } });
      if (signup?.passwordHash) {
        await db.user.update({ where: { id: admin.id }, data: { passwordHash: signup.passwordHash, status: 'ACTIVE' } });
        await controlDb.signupRequest.update({ where: { id: signup.id }, data: { passwordHash: null } });
        const origin = await appOriginForTenant(tenantId);
        await sendMail(organizationReadyEmail(admin.email, `${origin}/${tenant.slug}/login?email=${encodeURIComponent(admin.email)}`, tenant.name)).catch(() => {});
      }
    }
    await controlDb.tenant.update({ where: { id: tenantId }, data: { adminInvitedAt: new Date(), adminInviteError: inviteError } });
    // Platform staff hear about it in the app (an email about broken email wouldn't arrive)
    if (inviteError) {
      await recordAudit({ actor: { type: 'SYSTEM' } }, 'tenant.invitation_not_sent', {
        tenantId, resource: { type: 'tenant', id: tenantId, label: tenant.slug }, details: { name: tenant.name, to: admin.email, error: inviteError },
      }).catch(() => {});
    }
  }
}

/**
 * Remove a tenant's data and database access, then its control-plane rows.
 * Safe to re-run: every step checks first. Throws on failure (the tenant stays
 * listed as DEPROVISIONING with the error, so deleting again retries).
 */
export async function deprovisionTenant(tenantId: string, actorId?: string): Promise<void> {
  const done = await withTenantJobLock(tenantId, () => deprovisionLocked(tenantId, actorId), 5_000);
  if (!done) throw new AppError(BUSY_MESSAGE, 409);
}

async function deprovisionLocked(tenantId: string, actorId?: string): Promise<void> {
  const tenant = await controlDb.tenant.findUnique({ where: { id: tenantId }, include: { databaseConfig: true } });
  if (!tenant) return; // already deleted by another server
  await controlDb.tenant.update({ where: { id: tenantId }, data: { provisioningStatus: 'DEPROVISIONING', provisioningError: null } });
  try {
    const cfg = tenant.databaseConfig;
    const role = cfg?.dbRoleName;
    // The tenant's audit log outlives it: archive every entry first
    if (tenant.provisioningStatus === 'READY') {
      await archiveChain(tenantId, { before: new Date(8.64e15), everything: true });
    }
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

    // Its data exports, files and records
    await removeTenantExports(tenantId);
    await controlDb.$transaction([
      controlDb.supportSession.deleteMany({ where: { tenantId } }),
      controlDb.signupRequest.deleteMany({ where: { tenantId } }),
      controlDb.tenantApplication.deleteMany({ where: { tenantId } }),
      controlDb.tenantUsage.deleteMany({ where: { tenantId } }),
      controlDb.databaseConfig.deleteMany({ where: { tenantId } }),
      controlDb.tenant.delete({ where: { id: tenantId } }),
    ]);
    await logPlatformActivity({ tenantId, userId: actorId, action: 'deleted tenant', target: `${tenant.name} (${tenant.slug})`, type: 'CONFIG' });
    await recordAudit({ actor: await platformActor(actorId) }, 'tenant.deleted', { tenantId, resource: { type: 'tenant', id: tenantId, label: tenant.slug }, details: { name: tenant.name } }).catch(() => {});
  } catch (err) {
    await controlDb.tenant
      .update({ where: { id: tenantId }, data: { provisioningError: `Deleting failed: ${describeError(err)}` } })
      .catch(() => {});
    throw err;
  }
}

/**
 * Give a tenant's database role a new password. The role and its data stay as
 * they are; the new password is stored (encrypted) first, then set on the
 * role, so a failure in between is fixed by rotating again. Connections
 * already open keep working until they close; this server closes its own,
 * and other servers switch on their next request for the tenant (the
 * config's version changes, see lib/tenant-db.ts).
 */
export async function rotateTenantCredentials(tenantId: string, actorId: string): Promise<void> {
  const done = await withTenantJobLock(tenantId, async () => {
    const tenant = await controlDb.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { databaseConfig: true } });
    const cfg = tenant.databaseConfig;
    if (tenant.provisioningStatus !== 'READY' || !cfg?.dbRoleName || !cfg.connectionString) {
      throw new AppError('Only a tenant that is set up has credentials to rotate', 409);
    }
    const role = cfg.dbRoleName;
    const target = targetOf(cfg);
    const oldUrl = decryptSecret(cfg.connectionString, secretContext('connectionString'));
    const password = crypto.randomBytes(32).toString('base64url');

    await controlDb.databaseConfig.update({ where: { tenantId }, data: { connectionString: tenantRoleUrl(target, role, password) } });
    await withConnection(config.tenantProvisionerUrl, (c) => c.query(`ALTER ROLE ${ident(role)} WITH PASSWORD '${scramVerifier(password)}'`));
    forgetTenant(tenantId);
    await closeTenantClients((u) => u === oldUrl);
    await logPlatformActivity({ tenantId, userId: actorId, action: 'rotated database credentials', target: `${tenant.name} (${tenant.slug})`, type: 'CONFIG' });
    await recordAudit({ actor: await platformActor(actorId) }, 'tenant.credentials_rotated', { tenantId, resource: { type: 'tenant', id: tenantId, label: tenant.slug } }).catch(() => {});
  }, 5_000);
  if (!done) throw new AppError(BUSY_MESSAGE, 409);
}
