/**
 * Checks, at startup, that the tenant database server is set up the way
 * isolation relies on (prisma/tenant/setup-roles.sql). A role missing a
 * privilege otherwise fails quietly: a platform role without BYPASSRLS reads
 * zero rows (empty usage counts, a shared-tables tenant's rows left behind on
 * deletion); an owner that bypasses row-level security hides policy mistakes.
 *
 * Errors stop a production server from starting; elsewhere they're warnings.
 */
import { config } from '../config/env.js';
import { userOf, withConnection } from './tenant-migrations.js';
import { sharedGroupRole } from './tenant-targets.js';

export interface ServerCheck {
  errors: string[];
  warnings: string[];
}

interface RoleInfo {
  name: string;
  superuser: boolean;
  createRole: boolean;
  createDb: boolean;
  bypassRls: boolean;
}

async function whoAmI(url: string): Promise<RoleInfo> {
  return withConnection(url, async (c) => {
    const { rows } = await c.query(
      `SELECT rolname AS name, rolsuper AS superuser, rolcreaterole AS "createRole", rolcreatedb AS "createDb", rolbypassrls AS "bypassRls"
         FROM pg_roles WHERE rolname = current_user`,
    );
    return rows[0];
  });
}

export async function checkTenantServer(): Promise<ServerCheck> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ok = async (label: string, url: string): Promise<RoleInfo | null> => {
    try {
      return await whoAmI(url);
    } catch (err) {
      errors.push(`${label}: can't connect (${(err as Error).message})`);
      return null;
    }
  };

  const owner = await ok('TENANT_DATABASE_URL (migration owner)', config.tenantDatabaseUrl);
  const provisioner = await ok('TENANT_PROVISIONER_URL (provisioner)', config.tenantProvisionerUrl);
  const platform = await ok('TENANT_PLATFORM_URL (platform role)', config.tenantPlatformUrl);

  if (owner) {
    if (owner.superuser || owner.bypassRls) {
      warnings.push(`The migration owner (${owner.name}) bypasses row-level security; use the non-superuser tenant_owner from setup-roles.sql so its own reads are checked too`);
    }
    const canCreate = await withConnection(config.tenantDatabaseUrl, async (c) =>
      (await c.query(`SELECT has_database_privilege(current_database(), 'CREATE') AS ok`)).rows[0].ok as boolean,
    );
    if (!canCreate) errors.push(`The migration owner (${owner.name}) can't create schemas in the shared tenant database; it should own it`);
  }

  if (provisioner && !provisioner.superuser) {
    if (!provisioner.createRole || !provisioner.createDb) {
      errors.push(`The provisioner (${provisioner.name}) needs CREATEROLE and CREATEDB to create tenant roles and databases`);
    }
    const membership = await withConnection(config.tenantProvisionerUrl, async (c) => {
      const owns = (await c.query('SELECT pg_has_role(current_user, $1, $2) AS ok', [userOf(config.tenantDatabaseUrl), 'MEMBER'])).rows[0].ok as boolean;
      const group = (
        await c.query(
          `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists,
                  EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
                           WHERE g.rolname = $1 AND u.rolname = current_user AND m.admin_option) AS admin`,
          [sharedGroupRole()],
        )
      ).rows[0] as { exists: boolean; admin: boolean };
      const signal = (await c.query(`SELECT pg_has_role(current_user, 'pg_signal_backend', 'USAGE') AS ok`)).rows[0].ok as boolean;
      return { owns, group, signal };
    });
    if (!membership.owns) {
      errors.push(`The provisioner (${provisioner.name}) must be a member of the migration owner (${userOf(config.tenantDatabaseUrl)}) to create databases it owns`);
    }
    if (!membership.group.exists) {
      errors.push(`The shared-tables group role ${sharedGroupRole()} doesn't exist; run setup-roles.sql with role_prefix=${config.tenantRolePrefix}`);
    } else if (!membership.group.admin) {
      errors.push(`The provisioner (${provisioner.name}) needs ADMIN OPTION on ${sharedGroupRole()} to add shared-tables tenants to it`);
    }
    if (!membership.signal) {
      warnings.push(`The provisioner (${provisioner.name}) isn't in pg_signal_backend; deleting a database-per-tenant tenant fails while anything is connected to its database`);
    }
  }

  if (platform && !platform.superuser && !platform.bypassRls) {
    errors.push(`The platform role (${platform.name}) needs BYPASSRLS; without it, usage counts read nothing and deleting a shared-tables tenant leaves its rows behind`);
  }

  if (config.tenantPoolMax > config.tenantRoleConnectionLimit) {
    errors.push(`TENANT_POOL_MAX (${config.tenantPoolMax}) is above TENANT_ROLE_CONNECTION_LIMIT (${config.tenantRoleConnectionLimit}); a busy tenant would hit its connection limit from one server`);
  }

  return { errors, warnings };
}
