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
 * Get user permissions from their roles
 */
export async function getUserPermissions(userId: string): Promise<string[]> {
  const userRoles = await prisma.userRole.findMany({
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

  const permissions = new Set<string>();
  
  for (const userRole of userRoles) {
    for (const rolePermission of userRole.role.permissions) {
      const permString = `${rolePermission.permission.resource}:${rolePermission.permission.action}`;
      permissions.add(permString);
    }
  }

  return Array.from(permissions);
}

/**
 * Check if user has a specific permission
 */
export async function hasPermission(userId: string, resource: string, action: string): Promise<boolean> {
  const permissions = await getUserPermissions(userId);
  const permString = `${resource}:${action}`;
  
  // Check for wildcard permissions
  return permissions.includes(permString) || 
         permissions.includes(`${resource}:*`) ||
         permissions.includes(`*:${action}`) ||
         permissions.includes('*:*');
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
       {
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
