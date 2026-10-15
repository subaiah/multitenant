/**
 * Permission catalog: the single list of permission names used by
 * - every protected API route (`config.permission`, enforced by authorize.ts),
 * - the frontend route guards (src/App.tsx) and action buttons,
 * - the sidebar menu items (prisma/seed-menu-items.ts, filtered server-side),
 * - the defaults each user type receives (below).
 *
 * Format is always `resource:action`. Grants may use wildcards:
 * `*` (everything), `resource:*`, `*:action`.
 *
 * The frontend has a copy of `permissionMatches` in src/lib/permissions.ts;
 * test/permissions.test.ts checks that every permission the frontend and the
 * menu seed ask for is listed here.
 */
import type { UserType } from './authorization.js';

export const PERMISSIONS = [
  // Platform portal
  'platform:read',
  'tenants:read',
  'tenants:manage',
  'platform-users:read',
  'policies:read',
  'platform-settings:manage',
  'app-registry:manage', // create/edit applications in the platform registry
  'menus:manage',
  'support:request', // ask for a time-limited support session into a tenant
  'support:manage', // list and revoke support sessions

  // Shared: application registry (read) and tenant entitlements / deployed apps
  'applications:read',
  'applications:manage',

  // Tenant portal
  'dashboard:view',
  'tenant:read',
  'tenant:update',
  'activity:read',
  'infrastructure:read',
  'database:read',
  'database:manage',
  'auth:read',
  'auth:manage',
  'api:read',
  'api:manage',
  'users:read',
  'users:create',
  'users:update',
  'users:delete',
  'groups:read',
  'groups:create',
  'groups:update',
  'groups:delete',
  'roles:read',
  'roles:assign',
  'roles:manage',
  'organizations:read',
  'organizations:create',
  'organizations:update',
  'organizations:delete',
  'settings:read',
  'settings:manage',
  'policies:manage',
  'access-requests:read',
  'access-requests:approve',
  'certifications:read',
  'certifications:manage',
  'delegations:read',
  'delegations:manage', // revoke anyone's delegation
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** What each user type can do before any roles are assigned. */
export const USER_TYPE_PERMISSIONS: Record<UserType, string[]> = {
  PLATFORM_ADMIN: ['*'],
  PLATFORM_USER: ['platform:read', 'tenants:read', 'applications:read', 'policies:read', 'platform-users:read', 'support:request'],
  TENANT_ADMIN: [
    'dashboard:view', 'tenant:*', 'applications:*', 'activity:read', 'infrastructure:read',
    'database:*', 'auth:*', 'api:*', 'users:*', 'groups:*', 'roles:*', 'organizations:*', 'settings:*',
    'policies:*', 'access-requests:*', 'certifications:*', 'delegations:*',
  ],
  TENANT_MANAGER: [
    'dashboard:view', 'tenant:read', 'tenant:update', 'applications:*', 'activity:read', 'infrastructure:read', 'database:read',
    'users:read', 'users:create', 'users:update', 'groups:*', 'roles:read', 'organizations:read', 'settings:read',
    'access-requests:read', 'certifications:read', 'delegations:read',
  ],
  TENANT_DEVELOPER: [
    'dashboard:view', 'tenant:read', 'applications:*', 'activity:read', 'infrastructure:read', 'database:read', 'api:read', 'users:read',
  ],
  TENANT_USER: ['dashboard:view', 'tenant:read', 'applications:read', 'users:read', 'groups:read', 'organizations:read'],
  TENANT_VIEWER: ['dashboard:view', 'tenant:read', 'applications:read'],
};

/** Resources that exist only at platform level. */
const PLATFORM_RESOURCES = new Set(['platform', 'tenants', 'platform-users', 'platform-settings', 'app-registry', 'menus', 'support']);

/**
 * Can a tenant-scoped role (or group role, or delegation) grant this to a
 * tenant user? Roles are built from a global permission table, so without
 * this a tenant admin could create a role with `tenants:delete` (or `*:read`)
 * and assign it to themselves. Wildcard resources are refused because they
 * would also cover platform resources.
 */
export function isTenantGrantable(permission: string): boolean {
  const i = permission.indexOf(':');
  if (i <= 0) return false; // '*' or malformed
  const resource = permission.slice(0, i);
  return resource !== '*' && !PLATFORM_RESOURCES.has(resource);
}

/** Does any granted permission (with wildcards) cover the required one? */
export function permissionMatches(granted: Iterable<string>, required: string): boolean {
  const set = granted instanceof Set ? (granted as Set<string>) : new Set(granted);
  if (set.has('*') || set.has('*:*') || set.has(required)) return true;
  const i = required.indexOf(':');
  if (i === -1) return false;
  const resource = required.slice(0, i);
  const action = required.slice(i + 1);
  return set.has(`${resource}:*`) || set.has(`*:${action}`);
}
