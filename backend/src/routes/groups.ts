import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { requireCanGrant } from '../middleware/authorize.js';
import { assignmentState, groupPermissionNames } from '../lib/access.js';

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
    config: { permission: 'groups:read' },
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
            select: { members: true, roleAssignments: true },
          },
          roleAssignments: { select: { role: { select: { name: true } } } },
        },
      }),
      prisma.group.count({ where }),
    ]);
    
    return {
      groups: groups.map(({ roleAssignments, ...g }) => ({
        ...g,
        roles: [...new Set(roleAssignments.map((a) => a.role.name))],
      })),
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
    config: { permission: 'groups:read' },
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
                status: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        roleAssignments: {
          include: { role: { select: { id: true, name: true, description: true, permissions: { select: { permission: { select: { name: true } } } } } } },
          orderBy: { createdAt: 'asc' },
        },
        _count: {
          select: { members: true, roleAssignments: true },
        },
      },
    });
    
    if (!group) {
      throw new AppError('Group not found', 404);
    }
    
    const { roleAssignments, ...rest } = group;
    const scopeIds = roleAssignments.filter((a) => a.scopeType !== 'TENANT').map((a) => a.scopeId);
    const [orgs, units] = await Promise.all([
      prisma.organization.findMany({ where: { tenantId, id: { in: scopeIds } }, select: { id: true, name: true } }),
      prisma.orgUnit.findMany({ where: { tenantId, id: { in: scopeIds } }, select: { id: true, name: true } }),
    ]);
    const scopeNames = new Map<string, string>([...orgs, ...units].map((x) => [x.id, x.name]));
    return {
      ...rest,
      roleAssignments: roleAssignments.map((a) => ({
        id: a.id,
        roleId: a.roleId,
        roleName: a.role.name,
        roleDescription: a.role.description,
        scopeType: a.scopeType,
        scopeId: a.scopeId,
        scopeName: a.scopeType === 'TENANT' ? request.tenant.name : (scopeNames.get(a.scopeId) ?? a.scopeId),
        permissions: a.role.permissions.map((rp) => rp.permission.name),
        validFrom: a.validFrom,
        validTo: a.validTo,
        state: assignmentState(a),
      })),
      // What membership grants, so the UI can tell whether the caller may change it
      grants: await groupPermissionNames(id, tenantId),
    };
  });

  // Create group
  fastify.post('/', {
    config: { permission: 'groups:create' },
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
    config: { permission: 'groups:update' },
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
    
    
    const data = updateGroupSchema.parse(request.body);
    
    const current = await prisma.group.findFirst({ where: { id, tenantId } });
    if (!current) {
      throw new AppError('Group not found', 404);
    }
    if (data.name && data.name !== current.name) {
      const clash = await prisma.group.findFirst({ where: { tenantId, name: data.name } });
      if (clash) throw new AppError('Group name already exists', 409);
    }
    // Turning a group on or off changes what its members can do
    if (data.status && data.status !== current.status) {
      await requireCanGrant(request, await groupPermissionNames(id, tenantId), `${data.status === 'ACTIVE' ? 'activate' : 'deactivate'} this group`);
    }
    
    const group = await prisma.group.update({
      where: { id },
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
    config: { permission: 'groups:delete' },
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
    
    
    const existing = await prisma.group.findFirst({ where: { id, tenantId } });
    if (!existing) {
      throw new AppError('Group not found', 404);
    }
    
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
      where: { id },
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
    config: { permission: 'groups:update' },
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
    
    await requireCanGrant(request, await groupPermissionNames(groupId, tenantId), `add members to ${group.name}`);
    
    if (validTo && new Date(validTo) <= (validFrom ? new Date(validFrom) : new Date())) {
      throw new AppError('Membership end date must be after its start', 400);
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
    config: { permission: 'groups:update' },
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
    
    
    const membership = await prisma.groupMembership.findFirst({
      where: { groupId, userId: memberUserId, tenantId },
      include: { group: { select: { name: true } }, user: { select: { email: true } } },
    });
    if (!membership) {
      throw new AppError('This user is not a member of the group', 404);
    }
    
    await requireCanGrant(request, await groupPermissionNames(groupId, tenantId), `remove members from ${membership.group.name}`);
    
    await prisma.groupMembership.delete({ where: { id: membership.id } });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'removed member from group',
        target: `${membership.user.email} from ${membership.group.name}`,
        type: 'USER',
      },
    });
    
    return reply.status(204).send();
  });
};
