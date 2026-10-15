import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType, isPlatformAdmin } from '../utils/authorization.js';

const createApplicationSchema = z.object({
  key: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/),
  name: z.string().min(2).max(100),
  description: z.string().optional(),
  version: z.string().default('1.0.0'),
});

const updateApplicationSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'DEPRECATED']).optional(),
});

const createPermissionSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().optional(),
  resource: z.string().min(2).max(50),
  action: z.string().min(2).max(50),
});

export const applicationRoutes: FastifyPluginAsync = async (fastify) => {
  // List all applications (platform-wide)
  fastify.get('/', {
    config: { permission: 'applications:read' },
    schema: {
      tags: ['applications'],
      summary: 'List all applications',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', default: '1' },
          limit: { type: 'string', default: '20' },
          search: { type: 'string' },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'DEPRECATED'] },
        },
      },
    },
  }, async (request, reply) => {
    const userType = (request.user as any).userType;
    const { page = '1', limit = '20', search, status } = request.query as any;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const where = {
      AND: [
        status ? { status } : {},
        search ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { key: { contains: search, mode: 'insensitive' as const } },
            { description: { contains: search, mode: 'insensitive' as const } },
          ],
        } : {},
      ],
    };
    
    const [applications, total] = await Promise.all([
      prisma.applicationRegistry.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: { permissions: true, tenantApplications: true },
          },
        },
      }),
      prisma.applicationRegistry.count({ where }),
    ]);
    
    return {
      applications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  });

  // Get application by ID
  fastify.get('/:id', {
    config: { permission: 'applications:read' },
    schema: {
      tags: ['applications'],
      summary: 'Get application by ID',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    
    const application = await prisma.applicationRegistry.findUnique({
      where: { id },
      include: {
        permissions: true,
        tenantApplications: {
          include: {
            tenant: {
              select: { id: true, name: true, slug: true },
            },
          },
        },
        _count: {
          select: { permissions: true, tenantApplications: true },
        },
      },
    });
    
    if (!application) {
      throw new AppError('Application not found', 404);
    }
    
    return application;
  });

  // Create application (platform admin only)
  fastify.post('/', {
    config: { permission: 'app-registry:manage' },
    schema: {
      tags: ['applications'],
      summary: 'Create application',
      body: {
        type: 'object',
        required: ['key', 'name'],
        properties: {
          key: { type: 'string', minLength: 2, maxLength: 50 },
          name: { type: 'string', minLength: 2, maxLength: 100 },
          description: { type: 'string' },
          version: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    
    // Only platform admins can create applications
    
    const data = createApplicationSchema.parse(request.body);
    
    // Check if key already exists
    const existing = await prisma.applicationRegistry.findUnique({
      where: { key: data.key },
    });
    
    if (existing) {
      throw new AppError('Application key already exists', 409);
    }
    
    const application = await prisma.applicationRegistry.create({
      data: {
        ...data,
      },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant?.id ?? null, // null for platform-level actions
        userId,
        action: 'created application',
        target: application.name,
        type: 'CONFIG',
      },
    });
    
    return reply.status(201).send(application);
  });

  // Update application (platform admin only)
  fastify.patch('/:id', {
    config: { permission: 'app-registry:manage' },
    schema: {
      tags: ['applications'],
      summary: 'Update application',
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
          name: { type: 'string', minLength: 2, maxLength: 100 },
          description: { type: 'string' },
          version: { type: 'string' },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'DEPRECATED'] },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { id } = request.params as { id: string };
    
    
    const data = updateApplicationSchema.parse(request.body);
    
    const application = await prisma.applicationRegistry.update({
      where: { id },
      data,
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant?.id ?? null, // null for platform-level actions
        userId,
        action: 'updated application',
        target: application.name,
        type: 'CONFIG',
      },
    });
    
    return application;
  });

  // Delete application (platform admin only)
  fastify.delete('/:id', {
    config: { permission: 'app-registry:manage' },
    schema: {
      tags: ['applications'],
      summary: 'Delete application',
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
    const userType = (request.user as any).userType;
    const { id } = request.params as { id: string };
    
    
    // Check if application has permissions
    const permissionCount = await prisma.permission.count({
      where: { applicationId: id },
    });
    
    if (permissionCount > 0) {
      throw new AppError('Cannot delete application with permissions. Remove all permissions first.', 400);
    }
    
    // Check if application has tenant entitlements
    const entitlementCount = await prisma.tenantApplication.count({
      where: { applicationId: id },
    });
    
    if (entitlementCount > 0) {
      throw new AppError('Cannot delete application with tenant entitlements. Remove all entitlements first.', 400);
    }
    
    const application = await prisma.applicationRegistry.delete({
      where: { id },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant?.id ?? null, // null for platform-level actions
        userId,
        action: 'deleted application',
        target: application.name,
        type: 'CONFIG',
      },
    });
    
    return reply.status(204).send();
  });

  // List permissions for an application
  fastify.get('/:id/permissions', {
    config: { permission: 'applications:read' },
    schema: {
      tags: ['applications'],
      summary: 'List permissions for an application',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    
    const application = await prisma.applicationRegistry.findUnique({
      where: { id },
    });
    
    if (!application) {
      throw new AppError('Application not found', 404);
    }
    
    const permissions = await prisma.permission.findMany({
      where: { applicationId: id },
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
    
    return { permissions };
  });

  // Create permission for an application
  fastify.post('/:id/permissions', {
    config: { permission: 'app-registry:manage' },
    schema: {
      tags: ['applications'],
      summary: 'Create permission for an application',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        required: ['name', 'resource', 'action'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 100 },
          description: { type: 'string' },
          resource: { type: 'string', minLength: 2, maxLength: 50 },
          action: { type: 'string', minLength: 2, maxLength: 50 },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { id } = request.params as { id: string };
    
    
    const data = createPermissionSchema.parse(request.body);
    
    // Verify application exists
    const application = await prisma.applicationRegistry.findUnique({
      where: { id },
    });
    
    if (!application) {
      throw new AppError('Application not found', 404);
    }
    
    // Check if permission name already exists
    const existing = await prisma.permission.findUnique({
      where: { name: data.name },
    });
    
    if (existing) {
      throw new AppError('Permission name already exists', 409);
    }
    
    const permission = await prisma.permission.create({
      data: {
        applicationId: id,
        ...data,
      },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant?.id ?? null, // null for platform-level actions
        userId,
        action: 'created permission',
        target: `${permission.name} for ${application.name}`,
        type: 'CONFIG',
      },
    });
    
    return reply.status(201).send(permission);
  });

  // Delete permission
  fastify.delete('/permissions/:permissionId', {
    config: { permission: 'app-registry:manage' },
    schema: {
      tags: ['applications'],
      summary: 'Delete permission',
      params: {
        type: 'object',
        required: ['permissionId'],
        properties: {
          permissionId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { permissionId } = request.params as { permissionId: string };
    
    
    // Check if permission is used in any roles
    const rolePermissionCount = await prisma.rolePermission.count({
      where: { permissionId },
    });
    
    if (rolePermissionCount > 0) {
      throw new AppError('Cannot delete permission that is used in roles. Remove from all roles first.', 400);
    }
    
    const permission = await prisma.permission.delete({
      where: { id: permissionId },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant?.id ?? null, // null for platform-level actions
        userId,
        action: 'deleted permission',
        target: permission.name,
        type: 'CONFIG',
      },
    });
    
    return reply.status(204).send();
  });
};
