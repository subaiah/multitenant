import { prisma } from '../lib/prisma.js';
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
 * Get user permissions from their roles (both direct and group-based)
 */
export async function getUserPermissions(userId: string, tenantId?: string): Promise<string[]> {
  const permissions = new Set<string>();
  
  // 1. Get direct role assignments (new model)
  const directAssignments = await prisma.roleAssignment.findMany({
    where: {
      userId,
      principalType: 'USER',
      status: 'ACTIVE',
      validFrom: { lte: new Date() },
      OR: [
        { validTo: null },
        { validTo: { gt: new Date() } },
      ],
      ...(tenantId ? { tenantId } : {}),
    },
    include: {
      role: {
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      },
    },
  });
  
  // 2. Get group memberships
  const groupMemberships = await prisma.groupMembership.findMany({
    where: {
      userId,
      validFrom: { lte: new Date() },
      OR: [
        { validTo: null },
        { validTo: { gt: new Date() } },
      ],
      ...(tenantId ? { tenantId } : {}),
    },
    select: { groupId: true },
  });
  
  // 3. Get group-based role assignments
  const groupAssignments = await prisma.roleAssignment.findMany({
    where: {
      groupId: { in: groupMemberships.map(m => m.groupId) },
      principalType: 'GROUP',
      status: 'ACTIVE',
      validFrom: { lte: new Date() },
      OR: [
        { validTo: null },
        { validTo: { gt: new Date() } },
      ],
      ...(tenantId ? { tenantId } : {}),
    },
    include: {
      role: {
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      },
    },
  });
  
  // 4. Get legacy UserRole assignments (for backward compatibility)
  const legacyRoles = await prisma.userRole.findMany({
    // Legacy roles: only the requested tenant's roles (or platform roles)
    where: tenantId
      ? { userId, role: { OR: [{ tenantId }, { tenantId: null }] } }
      : { userId },
    include: {
      role: {
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      },
    },
  });
  
  // 5. Combine all permissions
  const allAssignments = [...directAssignments, ...groupAssignments];
  
  for (const assignment of allAssignments) {
    for (const rolePermission of assignment.role.permissions) {
      const permString = `${rolePermission.permission.resource}:${rolePermission.permission.action}`;
      permissions.add(permString);
    }
  }
  
  // Add legacy role permissions
  for (const userRole of legacyRoles) {
    for (const rolePermission of userRole.role.permissions) {
      const permString = `${rolePermission.permission.resource}:${rolePermission.permission.action}`;
      permissions.add(permString);
    }
  }

  return Array.from(permissions);
}

/**
 * Check if user has a specific permission with scope validation
 */
export async function hasPermission(
  userId: string,
  tenantId: string,
  resource: string,
  action: string,
  scopeType?: string,
  scopeId?: string
): Promise<boolean> {
  const permString = `${resource}:${action}`;
  
  // 1. Check direct user assignments (new RoleAssignment model)
  const directAssignments = await prisma.roleAssignment.findMany({
    where: {
      tenantId,
      userId,
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
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      },
    },
  });
  
  // 2. Check group-based assignments
  const groupMemberships = await prisma.groupMembership.findMany({
    where: {
      tenantId,
      userId,
      validFrom: { lte: new Date() },
      OR: [
        { validTo: null },
        { validTo: { gt: new Date() } },
      ],
    },
    select: { groupId: true },
  });
  
  const groupAssignments = await prisma.roleAssignment.findMany({
    where: {
      tenantId,
      groupId: { in: groupMemberships.map(m => m.groupId) },
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
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      },
    },
  });
  
  // 3. Combine all assignments
  const allAssignments = [...directAssignments, ...groupAssignments];
  
  // 4. Filter by scope if provided
  let validAssignments = allAssignments;
  if (scopeType && scopeId) {
    // Use Promise.all to handle async scope compatibility checks
    const compatibilityChecks = await Promise.all(
      allAssignments.map(async (assignment) => {
        const isCompatible = await isScopeCompatible(
          assignment.scopeType,
          assignment.scopeId,
          scopeType,
          scopeId,
          tenantId
        );
        return { assignment, isCompatible };
      })
    );
    
    validAssignments = compatibilityChecks
      .filter(check => check.isCompatible)
      .map(check => check.assignment);
  }
  
  // 5. Check for wildcard permissions
  const hasWildcard = validAssignments.some(assignment =>
    assignment.role.permissions.some(rp => {
      const perm = rp.permission.name;
      return perm === '*:*' || 
             perm === `${resource}:*` || 
             perm === `*:${action}` ||
             perm === permString;
    })
  );
  
  if (hasWildcard) {
    return true;
  }
  
  // 6. Check for explicit permission
  return validAssignments.some(assignment =>
    assignment.role.permissions.some(rp => rp.permission.name === permString)
  );
}

/**
 * Check if assignment scope is compatible with requested scope
 * Supports hierarchical scope checking for organizations and org units
 */
async function isScopeCompatible(
  assignmentScopeType: string,
  assignmentScopeId: string,
  requestedScopeType: string,
  requestedScopeId: string,
  tenantId: string
): Promise<boolean> {
  // Exact match
  if (assignmentScopeType === requestedScopeType && assignmentScopeId === requestedScopeId) {
    return true;
  }
  
  // Tenant scope covers everything in tenant
  if (assignmentScopeType === 'TENANT') {
    return true;
  }
  
  // Organization scope covers the organization and all its units
  if (assignmentScopeType === 'ORGANIZATION') {
    // If requesting organization scope, check if it's the same org
    if (requestedScopeType === 'ORGANIZATION' && assignmentScopeId === requestedScopeId) {
      return true;
    }
    
    // If requesting org unit scope, check if the unit belongs to the assigned organization
    if (requestedScopeType === 'ORG_UNIT') {
      const unit = await prisma.orgUnit.findFirst({
        where: {
          id: requestedScopeId,
          organizationId: assignmentScopeId,
          tenantId,
        },
      });
      return !!unit;
    }
  }
  
  // Org unit scope covers the unit and all its descendants
  if (assignmentScopeType === 'ORG_UNIT') {
    // If requesting the same org unit
    if (requestedScopeType === 'ORG_UNIT' && assignmentScopeId === requestedScopeId) {
      return true;
    }
    
    // If requesting a descendant org unit, traverse up the hierarchy
    if (requestedScopeType === 'ORG_UNIT') {
      let currentUnitId: string | null = requestedScopeId;
      
      // Traverse up the hierarchy to find if assignment scope is an ancestor
      while (currentUnitId) {
        if (currentUnitId === assignmentScopeId) {
          return true;
        }
        
        // Get parent unit
        const unit: { parentUnitId: string | null } | null = await prisma.orgUnit.findUnique({
          where: { id: currentUnitId },
          select: { parentUnitId: true },
        });
        
        currentUnitId = unit?.parentUnitId || null;
      }
    }
  }
  
  return false;
}

/**
 * Require a specific permission or throw error
 */
export async function requirePermission(
  userId: string,
  tenantId: string,
  resource: string,
  action: string,
  scopeType?: string,
  scopeId?: string
): Promise<void> {
  const hasPerm = await hasPermission(userId, tenantId, resource, action, scopeType, scopeId);
  if (!hasPerm) {
    throw new AppError(`Missing permission: ${resource}:${action}`, 403);
  }
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
 * Check if user can access a specific tenant
 */
export async function canAccessTenant(userId: string, tenantId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { userType: true, tenantId: true },
  });

  if (!user) return false;

  // Platform admins can access any tenant
  if (isPlatformAdmin(user.userType as UserType)) {
    return true;
  }

  // Tenant users can only access their own tenant
  return user.tenantId === tenantId;
}

/**
 * Require access to a specific tenant or throw error
 */
export async function requireTenantAccess(userId: string, tenantId: string): Promise<void> {
  const canAccess = await canAccessTenant(userId, tenantId);
  if (!canAccess) {
    throw new AppError('Access denied to this tenant', 403);
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
export async function createDefaultTenantRoles(tenantId: string): Promise<void> {
  await createDefaultPermissions();
  const catalog = await prisma.permission.findMany({ where: { name: { in: [...PERMISSIONS] } } });

  for (const template of DEFAULT_TENANT_ROLES) {
    const existing = await prisma.role.findFirst({ where: { tenantId, name: template.name } });
    if (existing) continue;
    const granted = catalog.filter(
      (p) => isTenantGrantable(p.name) && permissionMatches(USER_TYPE_PERMISSIONS[template.userType], p.name),
    );
    try {
      await prisma.role.create({
        data: {
          tenantId,
          name: template.name,
          description: template.description,
          isSystem: true,
          permissions: { create: granted.map((p) => ({ permissionId: p.id })) },
        },
      });
    } catch (err) {
      // Created by a concurrent call in the meantime: that's the outcome we want
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
  }
}

/**
 * Create default permissions
 */
/**
 * Make the permissions table match the catalog (src/utils/permissions.ts), so
 * roles can be built from any catalog permission. Idempotent.
 */
export async function createDefaultPermissions(): Promise<void> {
  // One INSERT ... ON CONFLICT DO NOTHING: safe when several requests (or
  // tenants being created at the same time) seed the catalog concurrently.
  // Per-row upserts raced and failed with unique-constraint errors.
  await prisma.permission.createMany({
    data: PERMISSIONS.map((name) => {
      const i = name.indexOf(':');
      const resource = name.slice(0, i);
      const action = name.slice(i + 1);
      return { name, resource, action, description: `${action} ${resource}` };
    }),
    skipDuplicates: true,
  });
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

  // 2. Get direct role assignments
  const directAssignments = await prisma.roleAssignment.findMany({
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
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      },
    },
  });

  for (const assignment of directAssignments) {
    directRoleNames.add(assignment.role.name);
    for (const rp of assignment.role.permissions) {
      const permString = `${rp.permission.resource}:${rp.permission.action}`;
      addPermission(permString, `role:${assignment.role.name}`);
    }
  }

  // 3. Get group memberships and group-based permissions
  const groupMemberships = await prisma.groupMembership.findMany({
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
    const groupAssignments = await prisma.roleAssignment.findMany({
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
            permissions: {
              include: {
                permission: true,
              },
            },
          },
        },
        group: true,
      },
    });

    for (const assignment of groupAssignments) {
      groupRoleNames.add(assignment.role.name);
      for (const rp of assignment.role.permissions) {
        const permString = `${rp.permission.resource}:${rp.permission.action}`;
        addPermission(permString, `group:${assignment.group?.name || 'unknown'}:role:${assignment.role.name}`);
      }
    }
  }

  // 4. Get delegations
  const delegations = await prisma.delegation.findMany({
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
              permissions: {
                include: {
                  permission: true,
                },
              },
            },
          },
        },
      },
    },
  });

  for (const delegation of delegations) {
    delegationNames.add(delegation.roleAssignment.role.name);
    for (const rp of delegation.roleAssignment.role.permissions) {
      const permString = `${rp.permission.resource}:${rp.permission.action}`;
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
