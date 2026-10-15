/**
 * Permission catalog: the single list of permission names used by
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

  // Shared: application registry (platform) and entitlements (tenant)
  'applications:read',
  'applications:manage',

  // Tenant portal
  'dashboard:view',
  'tenant:read',
  'tenant:update',
  'activity:read',
  'infrastructure:read',
  'database:manage',
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
  'roles:manage',
  'organizations:read',
  'organizations:create',
  'organizations:update',
  'organizations:delete',
  'settings:read',
  'settings:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** What each user type can do before any roles are assigned. */
export const USER_TYPE_PERMISSIONS: Record<UserType, string[]> = {
  PLATFORM_ADMIN: ['*'],
  PLATFORM_USER: ['platform:read', 'tenants:read', 'applications:read', 'policies:read', 'platform-users:read'],
  TENANT_ADMIN: [
    'dashboard:view', 'tenant:*', 'applications:*', 'activity:read', 'infrastructure:read',
    'database:*', 'auth:*', 'api:*', 'users:*', 'groups:*', 'roles:*', 'organizations:*', 'settings:*',
  ],
  TENANT_MANAGER: [
    'dashboard:view', 'tenant:read', 'tenant:update', 'applications:*', 'activity:read', 'infrastructure:read',
    'users:read', 'users:create', 'users:update', 'groups:*', 'roles:read', 'organizations:read', 'settings:read',
  ],
  TENANT_DEVELOPER: [
    'dashboard:view', 'tenant:read', 'applications:*', 'activity:read', 'infrastructure:read', 'api:read', 'users:read',
  ],
  TENANT_USER: ['dashboard:view', 'tenant:read', 'applications:read', 'users:read', 'groups:read', 'organizations:read'],
  TENANT_VIEWER: ['dashboard:view', 'tenant:read', 'applications:read'],
};

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
