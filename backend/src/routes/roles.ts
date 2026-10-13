import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { 
  requireUserType, 
  requireTenantAccess, 
  getUserPermissions,
  createDefaultTenantRoles,
  UserType 
} from '../utils/authorization.js';

// Validation schemas
const createRoleSchema = z.object({
  name: z.string().min(2).max(50),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

const updateRoleSchema = z.object({
  name: z.string().min(2).max(50).optional(),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

const assignRoleSchema = z.object({
  userId: z.string().uuid(),
  roleId: z.string().uuid(),
});

export const roleRoutes: FastifyPluginAsync = async (fastify) => {
  // List all roles (platform-wide or tenant-specific)
  fastify.get('/', {
    schema: {
      tags: ['roles'],
      summary: 'List roles',
      querystring: {
        type: 'object',
        properties: {
          tenantId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType as UserType;
    const { tenantId } = request.query as { tenantId?: string };

    // Platform admins can see all roles
    if (userType === 'PLATFORM_ADMIN') {
      const roles = await prisma.role.findMany({
        where: tenantId ? { tenantId } : {},
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
          _count: {
            select: { users: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return { roles };
    }

    // Tenant users can only see their tenant's roles
    if (tenantId) {
      await requireTenantAccess(userId, tenantId);
    }

    const userTenantId = (request.user as any).tenantId;
    if (!userTenantId && !tenantId) {
      throw new AppError('Tenant ID required', 400);
    }

    const roles = await prisma.role.findMany({
      where: { tenantId: tenantId || userTenantId },
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
        _count: {
          select: { users: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { roles };
  });

  // Get role by ID
  fastify.get('/:id', {
    schema: {
      tags: ['roles'],
      summary: 'Get role by ID',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const { id } = request.params as { id: string };

    const role = await prisma.role.findUnique({
      where: { id },
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
        users: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                userType: true,
              },
            },
          },
        },
      },
    });

    if (!role) {
      throw new AppError('Role not found', 404);
    }

    // Check access
    if (role.tenantId) {
      await requireTenantAccess(userId, role.tenantId);
    }

    return role;
  });

  // Create role
  fastify.post('/', {
    schema: {
      tags: ['roles'],
      summary: 'Create role',
      body: {
        type: 'object',
        required: ['name', 'tenantId'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 50 },
          description: { type: 'string' },
          tenantId: { type: 'string', format: 'uuid' },
          permissions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType as UserType;
    const data = createRoleSchema.parse(request.body);
    const { tenantId } = request.body as { tenantId: string };

    // Check tenant access
    await requireTenantAccess(userId, tenantId);

    // Check if user can create roles
    requireUserType(userType, 'TENANT_ADMIN');

    // Check if role name already exists
    const existingRole = await prisma.role.findFirst({
      where: { tenantId, name: data.name },
    });

    if (existingRole) {
      throw new AppError('Role name already exists', 409);
    }

    // Create role
    const role = await prisma.role.create({
       {
        tenantId,
        name: data.name,
        description: data.description,
        isSystem: false,
      },
    });

    // Assign permissions if provided
    if (data.permissions && data.permissions.length > 0) {
      const permissions = await prisma.permission.findMany({
        where: { name: { in: data.permissions } },
      });

      if (permissions.length !== data.permissions.length) {
        throw new AppError('Some permissions not found', 400);
      }

      await prisma.rolePermission.createMany({
         {
          roleId: role.id,
          permissionIds: permissions.map(p => p.id),
        },
      });
    }

    // Log activity
    await prisma.activity.create({
       {
        tenantId,
        userId,
        action: 'created role',
        target: role.name,
        type: 'CONFIG',
      },
    });

    return reply.status(201).send(role);
  });

  // Update role
  fastify.patch('/:id', {
    schema: {
      tags: ['roles'],
      summary: 'Update role',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 50 },
          description: { type: 'string' },
          permissions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType as UserType;
    const { id } = request.params as { id: string };
    const data = updateRoleSchema.parse(request.body);

    const role = await prisma.role.findUnique({
      where: { id },
    });

    if (!role) {
      throw new AppError('Role not found', 404);
    }

    // Can't update system roles
    if (role.isSystem) {
      throw new AppError('Cannot update system roles', 403);
    }

    // Check tenant access
    if (role.tenantId) {
      await requireTenantAccess(userId, role.tenantId);
    }

    // Check permissions
    requireUserType(userType, 'TENANT_ADMIN');

    // Update role
    const updatedRole = await prisma.role.update({
      where: { id },
       {
        name: data.name,
        description: data.description,
      },
    });

    // Update permissions if provided
    if (data.permissions) {
      // Remove existing permissions
      await prisma.rolePermission.deleteMany({
        where: { roleId: id },
      });

      // Add new permissions
      if (data.permissions.length > 0) {
        const permissions = await prisma.permission.findMany({
          where: { name: { in: data.permissions } },
        });

        if (permissions.length !== data.permissions.length) {
          throw new AppError('Some permissions not found', 400);
        }

        await prisma.rolePermission.createMany({
           {
            roleId: id,
            permissionIds: permissions.map(p => p.id),
          },
        });
      }
    }

    // Log activity
    if (role.tenantId) {
      await prisma.activity.create({
         {
          tenantId: role.tenantId,
          userId,
          action: 'updated role',
          target: updatedRole.name,
          type: 'CONFIG',
        },
      });
    }

    return updatedRole;
  });

  // Delete role
  fastify.delete('/:id', {
    schema: {
      tags: ['roles'],
      summary: 'Delete role',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType as UserType;
    const { id } = request.params as { id: string };

    const role = await prisma.role.findUnique({
      where: { id },
      include: {
        _count: {
          select: { users: true },
        },
      },
    });

    if (!role) {
      throw new AppError('Role not found', 404);
    }

    // Can't delete system roles
    if (role.isSystem) {
      throw new AppError('Cannot delete system roles', 403);
    }

    // Check if role has users
    if (role._count.users > 0) {
      throw new AppError('Cannot delete role with assigned users', 400);
    }

    // Check tenant access
    if (role.tenantId) {
      await requireTenantAccess(userId, role.tenantId);
    }

    // Check permissions
    requireUserType(userType, 'TENANT_ADMIN');

    await prisma.role.delete({
      where: { id },
    });

    // Log activity
    if (role.tenantId) {
      await prisma.activity.create({
         {
          tenantId: role.tenantId,
          userId,
          action: 'deleted role',
          target: role.name,
          type: 'CONFIG',
        },
      });
    }

    return reply.status(204).send();
  });

  // Assign role to user
  fastify.post('/assign', {
    schema: {
      tags: ['roles'],
      summary: 'Assign role to user',
      body: {
        type: 'object',
        required: ['userId', 'roleId'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
          roleId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType as UserType;
    const data = assignRoleSchema.parse(request.body);

    // Get role
    const role = await prisma.role.findUnique({
      where: { id: data.roleId },
    });

    if (!role) {
      throw new AppError('Role not found', 404);
    }

    // Get user
    const user = await prisma.user.findUnique({
      where: { id: data.userId },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    // Check tenant access
    if (role.tenantId) {
      await requireTenantAccess(userId, role.tenantId);
      
      // User must belong to same tenant
      if (user.tenantId !== role.tenantId) {
        throw new AppError('User does not belong to this tenant', 400);
      }
    }

    // Check permissions
    requireUserType(userType, 'TENANT_ADMIN');

    // Check if already assigned
    const existingAssignment = await prisma.userRole.findFirst({
      where: {
        userId: data.userId,
        roleId: data.roleId,
      },
    });

    if (existingAssignment) {
      throw new AppError('Role already assigned to user', 409);
    }

    // Assign role
    await prisma.userRole.create({
       {
        userId: data.userId,
        roleId: data.roleId,
      },
    });

    // Log activity
    if (role.tenantId) {
      await prisma.activity.create({
         {
          tenantId: role.tenantId,
          userId,
          action: 'assigned role',
          target: `${role.name} to ${user.email}`,
          type: 'USER',
        },
      });
    }

    return { message: 'Role assigned successfully' };
  });

  // Remove role from user
  fastify.delete('/unassign', {
    schema: {
      tags: ['roles'],
      summary: 'Remove role from user',
      body: {
        type: 'object',
        required: ['userId', 'roleId'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
          roleId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType as UserType;
    const data = assignRoleSchema.parse(request.body);

    // Get role
    const role = await prisma.role.findUnique({
      where: { id: data.roleId },
    });

    if (!role) {
      throw new AppError('Role not found', 404);
    }

    // Check tenant access
    if (role.tenantId) {
      await requireTenantAccess(userId, role.tenantId);
    }

    // Check permissions
    requireUserType(userType, 'TENANT_ADMIN');

    // Remove role
    await prisma.userRole.deleteMany({
      where: {
        userId: data.userId,
        roleId: data.roleId,
      },
    });

    // Log activity
    if (role.tenantId) {
      await prisma.activity.create({
         {
          tenantId: role.tenantId,
          userId,
          action: 'removed role',
          target: `${role.name}`,
          type: 'USER',
        },
      });
    }

    return { message: 'Role removed successfully' };
  });

  // Get user roles
  fastify.get('/user/:userId', {
    schema: {
      tags: ['roles'],
      summary: 'Get user roles',
      params: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const requesterId = (request.user as any).userId;
    const { userId } = request.params as { userId: string };

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        roles: {
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

    if (!user) {
      throw new AppError('User not found', 404);
    }

    // Check tenant access
    if (user.tenantId) {
      await requireTenantAccess(requesterId, user.tenantId);
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        userType: user.userType,
      },
      roles: user.roles.map(ur => ({
        id: ur.role.id,
        name: ur.role.name,
        description: ur.role.description,
        permissions: ur.role.permissions.map(rp => rp.permission.name),
      })),
    };
  });

  // Get user permissions
  fastify.get('/user/:userId/permissions', {
    schema: {
      tags: ['roles'],
      summary: 'Get user permissions',
      params: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const requesterId = (request.user as any).userId;
    const { userId } = request.params as { userId: string };

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    // Check tenant access
    if (user.tenantId) {
      await requireTenantAccess(requesterId, user.tenantId);
    }

    const permissions = await getUserPermissions(userId);

    return { permissions };
  });

  // List all permissions
  fastify.get('/permissions/list', {
    schema: {
      tags: ['roles'],
      summary: 'List all available permissions',
    },
  }, async (request, reply) => {
    const permissions = await prisma.permission.findMany({
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });

    return { permissions };
  });

  // Initialize default roles for tenant
  fastify.post('/initialize/:tenantId', {
    schema: {
      tags: ['roles'],
      summary: 'Initialize default roles for tenant',
      params: {
        type: 'object',
        required: ['tenantId'],
        properties: {
          tenantId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType as UserType;
    const { tenantId } = request.params as { tenantId: string };

    // Only platform admins or tenant admins can initialize roles
    if (userType !== 'PLATFORM_ADMIN') {
      await requireTenantAccess(userId, tenantId);
      requireUserType(userType, 'TENANT_ADMIN');
    }

    await createDefaultTenantRoles(tenantId);

    // Log activity
    await prisma.activity.create({
       {
        tenantId,
        userId,
        action: 'initialized default roles',
        target: 'roles',
        type: 'CONFIG',
      },
    });

    return { message: 'Default roles initialized successfully' };
  });
};
