import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler.js';
import { logActivity } from '../lib/activity.js';

const createOrganizationSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().optional(),
});

const updateOrganizationSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

export const organizationRoutes: FastifyPluginAsync = async (fastify) => {
  // List organizations for current tenant
  fastify.get('/', {
    config: { permission: 'organizations:read' },
    schema: {
      tags: ['organizations'],
      summary: 'List organizations for current tenant',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', default: '1' },
          limit: { type: 'string', default: '20' },
          search: { type: 'string' },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const tenantId = request.tenant.id;
    const { page = '1', limit = '20', search, status } = request.query as any;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const where = {
      tenantId,
      AND: [
        status ? { status } : {},
        search ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { description: { contains: search, mode: 'insensitive' as const } },
          ],
        } : {},
      ],
    };
    
    const [organizations, total] = await Promise.all([
      request.db.organization.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: { units: true, memberships: true },
          },
        },
      }),
      request.db.organization.count({ where }),
    ]);
    
    return {
      organizations,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  });

  // Get organization by ID
  fastify.get('/:id', {
    config: { permission: 'organizations:read' },
    schema: {
      tags: ['organizations'],
      summary: 'Get organization by ID',
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
    const tenantId = request.tenant.id;
    
    const organization = await request.db.organization.findFirst({
      where: { id, tenantId },
      include: {
        units: {
          where: { parentUnitId: null }, // Root units only
          include: {
            _count: {
              select: { children: true, memberships: true },
            },
          },
        },
        memberships: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
              },
            },
          },
        },
        _count: {
          select: { units: true, memberships: true },
        },
      },
    });
    
    if (!organization) {
      throw new AppError('Organization not found', 404);
    }
    
    return organization;
  });

  // Create organization
  fastify.post('/', {
    config: { permission: 'organizations:create' },
    schema: {
      tags: ['organizations'],
      summary: 'Create organization',
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 100 },
          description: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const tenantId = request.tenant.id;
    
    // Only admins can create organizations
    
    const data = createOrganizationSchema.parse(request.body);
    
    // Check if organization name already exists
    const existing = await request.db.organization.findFirst({
      where: { tenantId, name: data.name },
    });
    
    if (existing) {
      throw new AppError('Organization name already exists', 409);
    }
    
    const organization = await request.db.organization.create({
      data: {
        tenantId,
        ...data,
      },
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'created organization',
        target: organization.name,
        type: 'CONFIG',
      });
    
    return reply.status(201).send(organization);
  });

  // Update organization
  fastify.patch('/:id', {
    config: { permission: 'organizations:update' },
    schema: {
      tags: ['organizations'],
      summary: 'Update organization',
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
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { id } = request.params as { id: string };
    const tenantId = request.tenant.id;
    
    
    const data = updateOrganizationSchema.parse(request.body);
    
    const organization = await request.db.organization.update({
      where: { id, tenantId },
      data,
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'updated organization',
        target: organization.name,
        type: 'CONFIG',
      });
    
    return organization;
  });

  // Delete organization
  fastify.delete('/:id', {
    config: { permission: 'organizations:delete' },
    schema: {
      tags: ['organizations'],
      summary: 'Delete organization',
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
    const tenantId = request.tenant.id;
    
    
    // Check if organization has units
    const unitCount = await request.db.orgUnit.count({
      where: { organizationId: id },
    });
    
    if (unitCount > 0) {
      throw new AppError('Cannot delete organization with units. Remove all units first.', 400);
    }
    
    // Check if organization has members
    const memberCount = await request.db.orgMembership.count({
      where: { organizationId: id },
    });
    
    if (memberCount > 0) {
      throw new AppError('Cannot delete organization with members. Remove all members first.', 400);
    }
    
    const organization = await request.db.organization.delete({
      where: { id, tenantId },
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'deleted organization',
        target: organization.name,
        type: 'CONFIG',
      });
    
    return reply.status(204).send();
  });

  // Add member to organization
  fastify.post('/:id/members', {
    config: { permission: 'organizations:update' },
    schema: {
      tags: ['organizations'],
      summary: 'Add member to organization',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { id: orgId } = request.params as { id: string };
    const tenantId = request.tenant.id;
    const { userId: memberUserId } = request.body as any;
    
    
    // Verify organization exists
    const organization = await request.db.organization.findFirst({
      where: { id: orgId, tenantId },
    });
    
    if (!organization) {
      throw new AppError('Organization not found', 404);
    }
    
    // Verify user exists and belongs to tenant
    const user = await request.db.user.findFirst({
      where: { id: memberUserId, tenantId },
    });
    
    if (!user) {
      throw new AppError('User not found', 404);
    }
    
    // Check if already a member
    const existing = await request.db.orgMembership.findFirst({
      where: { organizationId: orgId, userId: memberUserId },
    });
    
    if (existing) {
      throw new AppError('User is already a member of this organization', 409);
    }
    
    const membership = await request.db.orgMembership.create({
      data: {
        tenantId,
        userId: memberUserId,
        organizationId: orgId,
      },
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'added member to organization',
        target: `${user.email} to ${organization.name}`,
        type: 'USER',
      });
    
    return reply.status(201).send(membership);
  });

  // Remove member from organization
  fastify.delete('/:id/members/:userId', {
    config: { permission: 'organizations:update' },
    schema: {
      tags: ['organizations'],
      summary: 'Remove member from organization',
      params: {
        type: 'object',
        required: ['id', 'userId'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          userId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { id: orgId, userId: memberUserId } = request.params as { id: string; userId: string };
    const tenantId = request.tenant.id;
    
    
    await request.db.orgMembership.deleteMany({
      where: { organizationId: orgId, userId: memberUserId, tenantId },
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'removed member from organization',
        target: `user ${memberUserId} from organization ${orgId}`,
        type: 'USER',
      });
    
    return reply.status(204).send();
  });
};
