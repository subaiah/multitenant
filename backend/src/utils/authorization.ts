import { dbForTenant, type TenantDb } from '../lib/tenant-db.js';
import { AppError } from '../middleware/error-handler.js';
import { PERMISSIONS, USER_TYPE_PERMISSIONS, isTenantGrantable, permissionMatches } from './permissions.js';

// User type hierarchy (higher number = more permissions)
export const USER_TYPE_HIERARCHY = {
  PLATFORM_ADMIN: 100,
  PLATFORM_USER: 90,
  TENANT_ADMIN: 80,
  TENANT_MANAGER: 70,
  TENANT_DEVELOPER: 60,
  TENANT_USER: 50,
  TENANT_VIEWER: 40,
} as const;

export type UserType = keyof typeof USER_TYPE_HIERARCHY;

/**
 * Check if a user type has sufficient privileges
 */
export function hasMinimumUserType(userType: UserType, minimumType: UserType): boolean {
  return USER_TYPE_HIERARCHY[userType] >= USER_TYPE_HIERARCHY[minimumType];
}

/**
 * Whether an actor may create, edit or grant a given user type.
 * Nobody can grant or manage a user type ranked above their own.
 */
export function canManageUserType(actorType: UserType, targetType: UserType): boolean {
  return USER_TYPE_HIERARCHY[targetType] <= USER_TYPE_HIERARCHY[actorType];
}

export function requireCanManageUserType(actorType: UserType, targetType: UserType): void {
  if (!canManageUserType(actorType, targetType)) {
    throw new AppError(`Cannot manage users of type ${targetType}`, 403);
  }
}

/**
 * Check if user is a platform admin
 */
export function isPlatformAdmin(userType: UserType): boolean {
  return userType === 'PLATFORM_ADMIN';
}

/**
 * Check if user is a platform user (admin or regular)
 */
export function isPlatformUser(userType: UserType): boolean {
  return userType === 'PLATFORM_ADMIN' || userType === 'PLATFORM_USER';
}

/**
 * Check if user is a tenant admin
 */
export function isTenantAdmin(userType: UserType): boolean {
  return userType === 'TENANT_ADMIN';
}

/**
 * Check if user belongs to a tenant
 */
export function isTenantUser(userType: UserType): boolean {
  return userType.startsWith('TENANT_');
}

/**
 * Get portal type for a user type
 */
export function getPortalForUser(userType: UserType): 'PLATFORM' | 'TENANT' {
  return userType.startsWith('PLATFORM_') ? 'PLATFORM' : 'TENANT';
}

/**
 * Require minimum user type or throw error
 */
export function requireUserType(userType: UserType, minimumType: UserType): void {
  if (!hasMinimumUserType(userType, minimumType)) {
    throw new AppError(`Requires ${minimumType} or higher`, 403);
  }
}

/**
 * Get default permissions for a user type
 */
export function getDefaultPermissions(userType: UserType): string[] {
  return USER_TYPE_PERMISSIONS[userType] ?? [];
}

/**
 * Create default roles for a tenant
 */
const DEFAULT_TENANT_ROLES: { name: string; description: string; userType: UserType }[] = [
  { name: 'Tenant Admin', description: 'Full access to tenant resources', userType: 'TENANT_ADMIN' },
  { name: 'Tenant Manager', description: 'Can manage applications, users and groups', userType: 'TENANT_MANAGER' },
  { name: 'Developer', description: 'Can manage applications and APIs', userType: 'TENANT_DEVELOPER' },
  { name: 'User', description: 'Can view and use applications', userType: 'TENANT_USER' },
  { name: 'Viewer', description: 'Read-only access', userType: 'TENANT_VIEWER' },
];

/**
 * Create the default roles for a tenant. Each role carries the same
 * permissions as the matching user type, so assigning e.g. "Tenant Manager"
 * to a regular user grants exactly what a manager has. Existing roles with
 * the same name are left as they are.
 */
export async function createDefaultTenantRoles(tenantId: string, db: TenantDb = dbForTenant(tenantId)): Promise<void> {
  for (const template of DEFAULT_TENANT_ROLES) {
    const existing = await db.role.findFirst({ where: { tenantId, name: template.name } });
    if (existing) continue;
    const granted = PERMISSIONS.filter(
      (p) => isTenantGrantable(p) && permissionMatches(USER_TYPE_PERMISSIONS[template.userType], p),
    );
    try {
      await db.role.create({
        data: {
          tenantId,
          name: template.name,
          description: template.description,
          isSystem: true,
          permissions: { create: granted.map((permission) => ({ tenantId, permission })) },
        },
      });
    } catch (err) {
      // Created by a concurrent call in the meantime: that's the outcome we want
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
  }
}

/**
 * Enhanced permission data structure
 */
export interface EnhancedPermissionData {
  permissions: string[];
  sources: {
    userType: string;
    directRoles: string[];
    groupRoles: string[];
    delegations: string[];
  };
  effectivePermissions: Array<{
    permission: string;
    sources: string[];
  }>;
}

/**
 * Get enhanced user permissions with metadata about sources
 */
export async function getEnhancedUserPermissions(
  userId: string,
  tenantId: string | undefined,
  userType: string
): Promise<EnhancedPermissionData> {
  const permissionSources = new Map<string, Set<string>>();
  const directRoleNames = new Set<string>();
  const groupRoleNames = new Set<string>();
  const delegationNames = new Set<string>();

  // Helper to add permission with source tracking.
  // Tenant users can't gain platform-level permissions through tenant roles.
  const platformUser = isPlatformUser(userType as UserType);
  const addPermission = (permission: string, source: string) => {
    if (source !== 'userType' && !platformUser && !isTenantGrantable(permission)) {
      return;
    }
    if (!permissionSources.has(permission)) {
      permissionSources.set(permission, new Set());
    }
    permissionSources.get(permission)!.add(source);
  };

  // 1. Get user type default permissions
  const userTypePermissions = getDefaultPermissions(userType as UserType);
  userTypePermissions.forEach(perm => addPermission(perm, 'userType'));

  // Roles, groups and delegations are tenant-scoped. Without a tenant (platform
  // users) only user-type permissions apply; querying with tenantId undefined
  // would otherwise match assignments in every tenant.
  if (!tenantId) {
    return {
      permissions: Array.from(permissionSources.keys()),
      sources: { userType, directRoles: [], groupRoles: [], delegations: [] },
      effectivePermissions: Array.from(permissionSources.entries()).map(([permission, sources]) => ({
        permission,
        sources: Array.from(sources),
      })),
    };
  }

  const db = dbForTenant(tenantId);

  // 2. Get direct role assignments
  const directAssignments = await db.roleAssignment.findMany({
    where: {
      userId,
      tenantId,
      principalType: 'USER',
      status: 'ACTIVE',
      validFrom: { lte: new Date() },
      OR: [
        { validTo: null },
        { validTo: { gt: new Date() } },
      ],
    },
    include: {
      role: {
        include: {
          permissions: true,
        },
      },
    },
  });

  for (const assignment of directAssignments) {
    directRoleNames.add(assignment.role.name);
    for (const rp of assignment.role.permissions) {
      const permString = rp.permission;
      addPermission(permString, `role:${assignment.role.name}`);
    }
  }

  // 3. Get group memberships and group-based permissions
  const groupMemberships = await db.groupMembership.findMany({
    where: {
      userId,
      tenantId,
      group: { status: 'ACTIVE' }, // a deactivated group grants nothing
      validFrom: { lte: new Date() },
      OR: [
        { validTo: null },
        { validTo: { gt: new Date() } },
      ],
    },
    include: {
      group: true,
    },
  });

  const groupIds = groupMemberships.map(m => m.groupId);
  
  if (groupIds.length > 0) {
    const groupAssignments = await db.roleAssignment.findMany({
      where: {
        groupId: { in: groupIds },
        tenantId,
        principalType: 'GROUP',
        status: 'ACTIVE',
        validFrom: { lte: new Date() },
        OR: [
          { validTo: null },
          { validTo: { gt: new Date() } },
        ],
      },
      include: {
        role: {
          include: {
            permissions: true,
          },
        },
        group: true,
      },
    });

    for (const assignment of groupAssignments) {
      groupRoleNames.add(assignment.role.name);
      for (const rp of assignment.role.permissions) {
        const permString = rp.permission;
        addPermission(permString, `group:${assignment.group?.name || 'unknown'}:role:${assignment.role.name}`);
      }
    }
  }

  // 4. Get delegations
  const delegations = await db.delegation.findMany({
    where: {
      delegateId: userId,
      tenantId,
      status: 'ACTIVE',
      // Not before it starts, and only while the delegator's own assignment is in force
      validFrom: { lte: new Date() },
      validTo: { gt: new Date() },
      roleAssignment: {
        status: 'ACTIVE',
        validFrom: { lte: new Date() },
        OR: [{ validTo: null }, { validTo: { gt: new Date() } }],
      },
    },
    include: {
      roleAssignment: {
        include: {
          role: {
            include: {
              permissions: true,
            },
          },
        },
      },
    },
  });

  for (const delegation of delegations) {
    delegationNames.add(delegation.roleAssignment.role.name);
    for (const rp of delegation.roleAssignment.role.permissions) {
      const permString = rp.permission;
      addPermission(permString, `delegation:${delegation.roleAssignment.role.name}`);
    }
  }

  // 5. Build effective permissions list
  const effectivePermissions = Array.from(permissionSources.entries()).map(
    ([permission, sources]) => ({
      permission,
      sources: Array.from(sources),
    })
  );

  // 6. Build simple permissions array (for backward compatibility)
  const permissions = Array.from(permissionSources.keys());

  return {
    permissions,
    sources: {
      userType,
      directRoles: Array.from(directRoleNames),
      groupRoles: Array.from(groupRoleNames),
      delegations: Array.from(delegationNames),
    },
    effectivePermissions,
  };
}
