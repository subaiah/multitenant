import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType, requireTenantAccess } from '../utils/authorization.js';

const createGroupSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().optional(),
  groupType: z.enum(['MANUAL', 'SYNCED', 'RULE_BASED']).default('MANUAL'),
});

const updateGroupSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

export const groupRoutes: FastifyPluginAsync = async (fastify) => {
  // List groups for current tenant
  fastify.get('/', {
    schema: {
      tags: ['groups'],
      summary: 'List groups for current tenant',
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
    
    const [groups, total] = await Promise.all([
      prisma.group.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: { members: true },
          },
        },
      }),
      prisma.group.count({ where }),
    ]);
    
    return {
      groups,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  });

  // Get group by ID
  fastify.get('/:id', {
    schema: {
      tags: ['groups'],
      summary: 'Get group by ID',
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
    
    const group = await prisma.group.findFirst({
      where: { id, tenantId },
      include: {
        members: {
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
        _count: {
          select: { members: true, roleAssignments: true },
        },
      },
    });
    
    if (!group) {
      throw new AppError('Group not found', 404);
    }
    
    return group;
  });

  // Create group
  fastify.post('/', {
    schema: {
      tags: ['groups'],
      summary: 'Create group',
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 100 },
          description: { type: 'string' },
          groupType: { type: 'string', enum: ['MANUAL', 'SYNCED', 'RULE_BASED'] },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const tenantId = request.tenant.id;
    
    // Only admins can create groups
    requireUserType(userType, 'TENANT_ADMIN');
    
    const data = createGroupSchema.parse(request.body);
    
    // Check if group name already exists
    const existing = await prisma.group.findFirst({
      where: { tenantId, name: data.name },
    });
    
    if (existing) {
      throw new AppError('Group name already exists', 409);
    }
    
    const group = await prisma.group.create({
      data: {
        tenantId,
        ...data,
      },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'created group',
        target: group.name,
        type: 'CONFIG',
      },
    });
    
    return reply.status(201).send(group);
  });

  // Update group
  fastify.patch('/:id', {
    schema: {
      tags: ['groups'],
      summary: 'Update group',
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
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    const data = updateGroupSchema.parse(request.body);
    
    const group = await prisma.group.update({
      where: { id, tenantId },
      data,
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'updated group',
        target: group.name,
        type: 'CONFIG',
      },
    });
    
    return group;
  });

  // Delete group
  fastify.delete('/:id', {
    schema: {
      tags: ['groups'],
      summary: 'Delete group',
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
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    // Check if group has members
    const memberCount = await prisma.groupMembership.count({
      where: { groupId: id },
    });
    
    if (memberCount > 0) {
      throw new AppError('Cannot delete group with members. Remove all members first.', 400);
    }
    
    // Check if group has role assignments
    const assignmentCount = await prisma.roleAssignment.count({
      where: { groupId: id },
    });
    
    if (assignmentCount > 0) {
      throw new AppError('Cannot delete group with role assignments. Remove all assignments first.', 400);
    }
    
    const group = await prisma.group.delete({
      where: { id, tenantId },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'deleted group',
        target: group.name,
        type: 'CONFIG',
      },
    });
    
    return reply.status(204).send();
  });

  // Add member to group
  fastify.post('/:id/members', {
    schema: {
      tags: ['groups'],
      summary: 'Add member to group',
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
          validFrom: { type: 'string', format: 'date-time' },
          validTo: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { id: groupId } = request.params as { id: string };
    const tenantId = request.tenant.id;
    const { userId: memberUserId, validFrom, validTo } = request.body as any;
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    // Verify group exists
    const group = await prisma.group.findFirst({
      where: { id: groupId, tenantId },
    });
    
    if (!group) {
      throw new AppError('Group not found', 404);
    }
    
    // Verify user exists and belongs to tenant
    const user = await prisma.user.findFirst({
      where: { id: memberUserId, tenantId },
    });
    
    if (!user) {
      throw new AppError('User not found', 404);
    }
    
    // Check if already a member
    const existing = await prisma.groupMembership.findFirst({
      where: { groupId, userId: memberUserId },
    });
    
    if (existing) {
      throw new AppError('User is already a member of this group', 409);
    }
    
    const membership = await prisma.groupMembership.create({
      data: {
        tenantId,
        groupId,
        userId: memberUserId,
        validFrom: validFrom ? new Date(validFrom) : new Date(),
        validTo: validTo ? new Date(validTo) : null,
      },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'added member to group',
        target: `${user.email} to ${group.name}`,
        type: 'USER',
      },
    });
    
    return reply.status(201).send(membership);
  });

  // Remove member from group
  fastify.delete('/:id/members/:userId', {
    schema: {
      tags: ['groups'],
      summary: 'Remove member from group',
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
    const { id: groupId, userId: memberUserId } = request.params as { id: string; userId: string };
    const tenantId = request.tenant.id;
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    await prisma.groupMembership.deleteMany({
      where: { groupId, userId: memberUserId, tenantId },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'removed member from group',
        target: `user ${memberUserId} from group ${groupId}`,
        type: 'USER',
      },
    });
    
    return reply.status(204).send();
  });
};
