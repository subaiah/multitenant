import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';

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
    where: { userId },
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
        const unit = await prisma.orgUnit.findUnique({
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
export async function requirePermission(userId: string, resource: string, action: string): Promise<void> {
  const hasPerm = await hasPermission(userId, resource, action);
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
  switch (userType) {
    case 'PLATFORM_ADMIN':
      return ['*:*']; // All permissions
    
    case 'PLATFORM_USER':
      return [
        'tenants:read',
        'platform:read',
      ];
    
    case 'TENANT_ADMIN':
      return [
        'tenant:*',
        'applications:*',
        'users:*',
        'roles:*',
        'settings:*',
      ];
    
    case 'TENANT_MANAGER':
      return [
        'tenant:read',
        'tenant:update',
        'applications:*',
        'users:read',
        'users:create',
        'users:update',
      ];
    
    case 'TENANT_DEVELOPER':
      return [
        'tenant:read',
        'applications:*',
        'users:read',
      ];
    
    case 'TENANT_USER':
      return [
        'tenant:read',
        'applications:read',
        'users:read',
      ];
    
    case 'TENANT_VIEWER':
      return [
        'tenant:read',
        'applications:read',
      ];
    
    default:
      return [];
  }
}

/**
 * Create default roles for a tenant
 */
export async function createDefaultTenantRoles(tenantId: string): Promise<void> {
  const defaultRoles = [
    {
      name: 'Tenant Admin',
      description: 'Full access to tenant resources',
      isSystem: true,
    },
    {
      name: 'Tenant Manager',
      description: 'Can manage applications and users',
      isSystem: true,
    },
    {
      name: 'Developer',
      description: 'Can manage applications',
      isSystem: true,
    },
    {
      name: 'User',
      description: 'Can view and use applications',
      isSystem: true,
    },
    {
      name: 'Viewer',
      description: 'Read-only access',
      isSystem: true,
    },
  ];

  for (const roleData of defaultRoles) {
    await prisma.role.create({
      data: {
        tenantId,
        ...roleData,
      },
    });
  }
}

/**
 * Create default permissions
 */
export async function createDefaultPermissions(): Promise<void> {
  const resources = ['tenants', 'applications', 'users', 'roles', 'settings', 'billing', 'platform'];
  const actions = ['create', 'read', 'update', 'delete'];

  for (const resource of resources) {
    for (const action of actions) {
      await prisma.permission.upsert({
        where: {
          name: `${resource}:${action}`,
        },
        update: {},
        create: {
          name: `${resource}:${action}`,
          description: `${action} ${resource}`,
          resource,
          action,
        },
      });
    }
  }

  // Add wildcard permission
  await prisma.permission.upsert({
    where: { name: '*:*' },
    update: {},
    create: {
      name: '*:*',
      description: 'All permissions',
      resource: '*',
      action: '*',
    },
  });
}
