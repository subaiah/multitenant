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
import { product } from '../product/index.js';

/** The kit's own permissions. */
export const KIT_PERMISSIONS = [
  // Platform portal
  'platform:read',
  'tenants:read',
  'tenants:manage',
  'platform-users:read',
  'platform-users:manage', // platform roles: create them, give them to platform users
  'policies:read',
  'platform-settings:manage',
  'app-registry:manage', // create/edit applications in the platform registry
  'menus:manage',
  'support:request', // ask for a time-limited support session into a tenant
  'support:manage', // approve, list and end support sessions
  'platform-audit:read', // the platform's audit log
  'platform-audit:manage', // verify, export and archive audit logs

  // Shared: application registry (read) and tenant entitlements / deployed apps
  'applications:read',
  'applications:manage',

  // Tenant portal
  'dashboard:view',
  'tenant:read',
  'tenant:update',
  'activity:read',
  'audit:read',
  'audit:export',
  'notifications:manage',
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

export type KitPermission = (typeof KIT_PERMISSIONS)[number];

/** Every permission: the kit's, then the product's (src/product). */
export const PERMISSIONS: readonly string[] = [...KIT_PERMISSIONS, ...product.permissions.map((p) => p.name)];

/** Plain-language names for the role editor (tenant-grantable resources only). */
const KIT_RESOURCE_INFO: Record<string, { label: string; description: string }> = {
  dashboard: { label: 'Dashboard', description: 'The tenant overview' },
  tenant: { label: 'Tenant profile', description: 'Name, branding and plan details' },
  applications: { label: 'Applications', description: 'Apps available to and deployed in the tenant' },
  activity: { label: 'Activity log', description: 'A feed of what has happened' },
  audit: { label: 'Audit log', description: 'Tamper-evident record of who changed what' },
  notifications: { label: 'Notifications', description: 'Which notifications the organization sends, and how' },
  infrastructure: { label: 'Infrastructure', description: 'Deployments and resource usage' },
  database: { label: 'Database', description: 'Data isolation, backups and connections' },
  auth: { label: 'Authentication', description: 'Sign-in methods, SSO and password policy' },
  api: { label: 'API', description: 'API keys, rate limits and webhooks' },
  users: { label: 'Users', description: 'People in the tenant' },
  groups: { label: 'Groups', description: 'Groups and their members' },
  roles: { label: 'Roles', description: 'Roles and who holds them' },
  organizations: { label: 'Organizations', description: 'Organizations and units' },
  settings: { label: 'Settings', description: 'Tenant-wide settings' },
  policies: { label: 'Policies', description: 'Access policies' },
  'access-requests': { label: 'Access requests', description: 'Requests for roles' },
  certifications: { label: 'Access reviews', description: 'Periodic reviews of who has access' },
  delegations: { label: 'Delegations', description: 'Temporary hand-over of roles' },
};

/** What each permission allows, where the action name alone isn't clear. */
const KIT_PERMISSION_INFO: Partial<Record<KitPermission, string>> = {
  'dashboard:view': 'See the dashboard',
  'tenant:read': 'See tenant details',
  'tenant:update': 'Change tenant details and branding',
  'applications:read': 'See applications',
  'applications:manage': 'Enable, deploy and configure applications',
  'activity:read': 'See the activity log',
  'audit:read': 'See the audit log and check its integrity',
  'audit:export': 'Export the audit log and download archives',
  'notifications:manage': 'Choose which notifications the organization sends, and how',
  'infrastructure:read': 'See infrastructure and usage',
  'database:read': 'See database configuration',
  'database:manage': 'Change database configuration and backups',
  'auth:read': 'See sign-in settings',
  'auth:manage': 'Change sign-in methods, SSO and password policy',
  'api:read': 'See API settings and keys',
  'api:manage': 'Create keys and change API settings',
  'users:read': 'See people',
  'users:create': 'Invite people',
  'users:update': 'Change type, deactivate and reactivate people',
  'users:delete': 'Remove people',
  'groups:read': 'See groups and members',
  'groups:create': 'Create groups',
  'groups:update': 'Rename groups and change members',
  'groups:delete': 'Delete groups',
  'roles:read': 'See roles and assignments',
  'roles:assign': 'Give roles to people and groups (only roles within their own access)',
  'roles:manage': 'Create, edit and delete roles',
  'organizations:read': 'See organizations and units',
  'organizations:create': 'Create organizations and units',
  'organizations:update': 'Change organizations and units',
  'organizations:delete': 'Delete organizations and units',
  'settings:read': 'See settings',
  'settings:manage': 'Change settings',
  'policies:read': 'See access policies',
  'policies:manage': 'Create and change access policies',
  'access-requests:read': 'See access requests',
  'access-requests:approve': 'Approve or reject access requests',
  'certifications:read': 'See access reviews',
  'certifications:manage': 'Run access reviews',
  'delegations:read': 'See delegations',
  'delegations:manage': "Revoke anyone's delegation",
};

/** What each user type can do before any roles are assigned (kit part). */
const KIT_USER_TYPE_PERMISSIONS: Record<UserType, string[]> = {
  PLATFORM_ADMIN: ['*'],
  PLATFORM_USER: ['platform:read', 'tenants:read', 'applications:read', 'policies:read', 'platform-users:read', 'support:request'],
  TENANT_ADMIN: [
    'dashboard:view', 'tenant:*', 'applications:*', 'activity:read', 'audit:*', 'notifications:*', 'infrastructure:read',
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

export const RESOURCE_INFO: Record<string, { label: string; description: string }> = { ...KIT_RESOURCE_INFO, ...product.resources };

export const PERMISSION_INFO: Record<string, string> = {
  ...KIT_PERMISSION_INFO,
  ...Object.fromEntries(product.permissions.map((p) => [p.name, p.description])),
};

/** What each user type can do before any roles are assigned (kit and product). */
export const USER_TYPE_PERMISSIONS: Record<UserType, string[]> = Object.fromEntries(
  Object.entries(KIT_USER_TYPE_PERMISSIONS).map(([type, grants]) => [type, [...grants, ...(product.userTypeGrants[type as UserType] ?? [])]]),
) as Record<UserType, string[]>;

/** Resources that exist only at platform level. */
export const PLATFORM_RESOURCES = new Set(['platform', 'tenants', 'platform-users', 'platform-settings', 'app-registry', 'menus', 'support', 'platform-audit']);

/**
 * Can a tenant-scoped role (or group role, or delegation) grant this to a
 * tenant user? Roles are built from a global permission table, so without
 * this a tenant admin could create a role with `tenants:delete` (or `*:read`)
 * and assign it to themselves. Wildcard resources are refused because they
 * would also cover platform resources.
 */
/**
 * Can a platform role grant this? Platform permissions only, plus the shared
 * catalogue (applications) and global policies; never tenant data.
 */
export function isPlatformGrantable(permission: string): boolean {
  const i = permission.indexOf(':');
  if (i <= 0) return false;
  const resource = permission.slice(0, i);
  return PLATFORM_RESOURCES.has(resource) || resource === 'applications' || resource === 'policies';
}

/** Tenant permissions that only read (granted by a read-only support session). */
export function isReadPermission(permission: string): boolean {
  return isTenantGrantable(permission) && /:(read|view)$/.test(permission);
}

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

// A product permission must be a new, tenant-grantable resource: it can't
// widen a kit resource (e.g. `users:export`) or touch a platform one.
{
  const kitResources = new Set(KIT_PERMISSIONS.map((p) => p.split(':')[0]));
  for (const { name } of product.permissions) {
    const [resource, action] = name.split(':');
    if (!resource || !action || name.split(':').length !== 2 || name.includes('*')) {
      throw new Error(`Product permission "${name}" must look like resource:action`);
    }
    if (kitResources.has(resource) || !isTenantGrantable(name)) {
      throw new Error(`Product permission "${name}" uses a kit or platform resource; use a resource of your own`);
    }
  }
}

/** Resources whose routes check permissions per organization or unit (lib/scopes.ts) */
export const SCOPED_RESOURCES = new Set(['organizations', ...(product.scopedResources ?? [])]);

/** Whether a role given for one organization or unit can make this permission's pages available */
export function isScopeAware(permission: string): boolean {
  return SCOPED_RESOURCES.has(permission.split(':')[0]);
}
