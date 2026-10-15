/**
 * Where tenant data physically lives, and how each Postgres role reaches it.
 *
 * A *target* is one place the tenant schema is migrated into:
 * - shared:   the public schema of the shared tenant database (SHARED_TABLES)
 * - schema:   a schema of its own in the shared tenant database (SCHEMA_PER_TENANT)
 * - database: a database of its own on the same server (DATABASE_PER_TENANT)
 *
 * Roles (prisma/tenant/setup-roles.sql):
 * - migration owner (TENANT_DATABASE_URL): owns every tenant table, runs migrations
 * - provisioner (TENANT_PROVISIONER_URL): creates and drops tenant roles and databases
 * - platform role (TENANT_PLATFORM_URL): BYPASSRLS, for cross-tenant platform work
 * - one login role per tenant (<prefix><slug>, e.g. tnt_acme): reads and writes only its own rows
 */
import { config } from '../config/env.js';
import { tenantClient, type TenantDb } from './prisma.js';

export type Target =
  | { kind: 'shared' }
  | { kind: 'schema'; schema: string }
  | { kind: 'database'; database: string };

/**
 * Members of this group may use the shared tables; each shared-tables tenant
 * role joins it. `<prefix>shared`, so the slug "shared" is reserved.
 */
export function sharedGroupRole(): string {
  return `${config.tenantRolePrefix}shared`;
}

/** TENANT_ROLE_PREFIX + the slug, `-` turned into `_`, at most 63 characters (Postgres' limit). */
export function roleNameFor(slug: string): string {
  return `${config.tenantRolePrefix}${slug.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`.slice(0, 63);
}

/** Slugs that can't be tenants because their role name is taken by the platform. */
export const RESERVED_ROLE_SLUGS = ['shared'];

/** Double-quote an identifier for SQL. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function sharedDatabaseName(): string {
  return new URL(config.tenantDatabaseUrl).pathname.slice(1).split('?')[0];
}

/** A connection string on the tenant server with the user, password and/or database swapped. */
export function withConnection(base: string, change: { user?: string; password?: string; database?: string }): string {
  const url = new URL(base);
  if (change.user !== undefined) url.username = encodeURIComponent(change.user);
  if (change.password !== undefined) url.password = encodeURIComponent(change.password);
  if (change.database !== undefined) url.pathname = `/${change.database}`;
  // Schemas are chosen through the client, never the URL
  url.searchParams.delete('schema');
  return url.toString();
}

export function databaseOf(target: Target): string {
  return target.kind === 'database' ? target.database : sharedDatabaseName();
}

export function schemaOf(target: Target): string {
  return target.kind === 'schema' ? target.schema : 'public';
}

export function describeTarget(target: Target): string {
  return target.kind === 'shared' ? 'shared tables' : target.kind === 'schema' ? `schema ${target.schema}` : `database ${target.database}`;
}

/** The target for a tenant's database config. */
export function targetOf(cfg: { strategy: string; schemaName: string | null; databaseName: string | null }): Target {
  if (cfg.strategy === 'SCHEMA_PER_TENANT') {
    if (!cfg.schemaName) throw new Error('Schema-per-tenant config has no schema name');
    return { kind: 'schema', schema: cfg.schemaName };
  }
  if (cfg.strategy === 'DATABASE_PER_TENANT') {
    if (!cfg.databaseName) throw new Error('Database-per-tenant config has no database name');
    return { kind: 'database', database: cfg.databaseName };
  }
  return { kind: 'shared' };
}

/** Migration owner connection string for a target's database. */
export function ownerUrl(target: Target): string {
  return withConnection(config.tenantDatabaseUrl, { database: databaseOf(target) });
}

/** The platform role's client for a target (bypasses row-level security). */
export function platformDb(target: Target): TenantDb {
  return tenantClient(withConnection(config.tenantPlatformUrl, { database: databaseOf(target) }), schemaOf(target));
}

/** Login connection string for a tenant role on its target (stored encrypted in the control plane). */
export function tenantRoleUrl(target: Target, role: string, password: string): string {
  return withConnection(config.tenantDatabaseUrl, { user: role, password, database: databaseOf(target) });
}
