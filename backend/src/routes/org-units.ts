import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType } from '../utils/authorization.js';

const createOrgUnitSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().optional(),
  unitType: z.enum(['DIVISION', 'DEPARTMENT', 'TEAM', 'LOCATION']),
  parentUnitId: z.string().uuid().optional(),
});

const updateOrgUnitSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().optional(),
  unitType: z.enum(['DIVISION', 'DEPARTMENT', 'TEAM', 'LOCATION']).optional(),
  parentUnitId: z.string().uuid().nullable().optional(),
});

export const orgUnitRoutes: FastifyPluginAsync = async (fastify) => {
  // List org units for an organization
  fastify.get('/organization/:orgId', {
    config: { permission: 'organizations:read' },
    schema: {
      tags: ['org-units'],
      summary: 'List org units for an organization',
      params: {
        type: 'object',
        required: ['orgId'],
        properties: {
          orgId: { type: 'string', format: 'uuid' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          unitType: { type: 'string', enum: ['DIVISION', 'DEPARTMENT', 'TEAM', 'LOCATION'] },
          search: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const tenantId = request.tenant.id;
    const { unitType, search } = request.query as any;
    
    // Verify organization exists
    const organization = await prisma.organization.findFirst({
      where: { id: orgId, tenantId },
    });
    
    if (!organization) {
      throw new AppError('Organization not found', 404);
    }
    
    const where = {
      organizationId: orgId,
      tenantId,
      AND: [
        unitType ? { unitType } : {},
        search ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { description: { contains: search, mode: 'insensitive' as const } },
          ],
        } : {},
      ],
    };
    
    const units = await prisma.orgUnit.findMany({
      where,
      orderBy: [{ unitType: 'asc' }, { name: 'asc' }],
      include: {
        parent: {
          select: { id: true, name: true },
        },
        _count: {
          select: { children: true, memberships: true },
        },
      },
    });
    
    return { units };
  });

  // Get org unit by ID (with hierarchy)
  fastify.get('/:id', {
    config: { permission: 'organizations:read' },
    schema: {
      tags: ['org-units'],
      summary: 'Get org unit by ID',
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
    
    const unit = await prisma.orgUnit.findFirst({
      where: { id, tenantId },
      include: {
        organization: {
          select: { id: true, name: true },
        },
        parent: {
          select: { id: true, name: true, unitType: true },
        },
        children: {
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
          select: { children: true, memberships: true },
        },
      },
    });
    
    if (!unit) {
      throw new AppError('Org unit not found', 404);
    }
    
    return unit;
  });

  // Create org unit
  fastify.post('/organization/:orgId', {
    config: { permission: 'organizations:update' },
    schema: {
      tags: ['org-units'],
      summary: 'Create org unit',
      params: {
        type: 'object',
        required: ['orgId'],
        properties: {
          orgId: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        required: ['name', 'unitType'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 100 },
          description: { type: 'string' },
          unitType: { type: 'string', enum: ['DIVISION', 'DEPARTMENT', 'TEAM', 'LOCATION'] },
          parentUnitId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { orgId } = request.params as { orgId: string };
    const tenantId = request.tenant.id;
    
    
    const data = createOrgUnitSchema.parse(request.body);
    
    // Verify organization exists
    const organization = await prisma.organization.findFirst({
      where: { id: orgId, tenantId },
    });
    
    if (!organization) {
      throw new AppError('Organization not found', 404);
    }
    
    // Verify parent unit exists if provided
    if (data.parentUnitId) {
      const parentUnit = await prisma.orgUnit.findFirst({
        where: { id: data.parentUnitId, organizationId: orgId, tenantId },
      });
      
      if (!parentUnit) {
        throw new AppError('Parent unit not found in this organization', 404);
      }
    }
    
    // Check for duplicate name within organization
    const existing = await prisma.orgUnit.findFirst({
      where: { organizationId: orgId, name: data.name, tenantId },
    });
    
    if (existing) {
      throw new AppError('Unit name already exists in this organization', 409);
    }
    
    const unit = await prisma.orgUnit.create({
      data: {
        tenantId,
        organizationId: orgId,
        ...data,
      },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'created org unit',
        target: `${unit.name} (${unit.unitType})`,
        type: 'CONFIG',
      },
    });
    
    return reply.status(201).send(unit);
  });

  // Update org unit
  fastify.patch('/:id', {
    config: { permission: 'organizations:update' },
    schema: {
      tags: ['org-units'],
      summary: 'Update org unit',
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
          unitType: { type: 'string', enum: ['DIVISION', 'DEPARTMENT', 'TEAM', 'LOCATION'] },
          parentUnitId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { id } = request.params as { id: string };
    const tenantId = request.tenant.id;
    
    
    const data = updateOrgUnitSchema.parse(request.body);
    
    // Get current unit
    const currentUnit = await prisma.orgUnit.findFirst({
      where: { id, tenantId },
    });
    
    if (!currentUnit) {
      throw new AppError('Org unit not found', 404);
    }
    
    // Verify parent unit exists if provided
    if (data.parentUnitId) {
      const parentUnit = await prisma.orgUnit.findFirst({
        where: { id: data.parentUnitId, organizationId: currentUnit.organizationId, tenantId },
      });
      
      if (!parentUnit) {
        throw new AppError('Parent unit not found in this organization', 404);
      }
      
      // Prevent circular reference
      if (data.parentUnitId === id) {
        throw new AppError('Unit cannot be its own parent', 400);
      }
    }
    
    const unit = await prisma.orgUnit.update({
      where: { id, tenantId },
      data,
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'updated org unit',
        target: unit.name,
        type: 'CONFIG',
      },
    });
    
    return unit;
  });

  // Delete org unit
  fastify.delete('/:id', {
    config: { permission: 'organizations:update' },
    schema: {
      tags: ['org-units'],
      summary: 'Delete org unit',
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
    
    
    // Check if unit has children
    const childCount = await prisma.orgUnit.count({
      where: { parentUnitId: id },
    });
    
    if (childCount > 0) {
      throw new AppError('Cannot delete unit with children. Remove all child units first.', 400);
    }
    
    // Check if unit has members
    const memberCount = await prisma.orgMembership.count({
      where: { orgUnitId: id },
    });
    
    if (memberCount > 0) {
      throw new AppError('Cannot delete unit with members. Remove all members first.', 400);
    }
    
    const unit = await prisma.orgUnit.delete({
      where: { id, tenantId },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'deleted org unit',
        target: unit.name,
        type: 'CONFIG',
      },
    });
    
    return reply.status(204).send();
  });

  // Get org unit hierarchy (tree structure)
  fastify.get('/organization/:orgId/hierarchy', {
    config: { permission: 'organizations:read' },
    schema: {
      tags: ['org-units'],
      summary: 'Get org unit hierarchy',
      params: {
        type: 'object',
        required: ['orgId'],
        properties: {
          orgId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const tenantId = request.tenant.id;
    
    // Verify organization exists
    const organization = await prisma.organization.findFirst({
      where: { id: orgId, tenantId },
    });
    
    if (!organization) {
      throw new AppError('Organization not found', 404);
    }
    
    // Get all units for this organization
    const allUnits = await prisma.orgUnit.findMany({
      where: { organizationId: orgId, tenantId },
      include: {
        _count: {
          select: { memberships: true },
        },
      },
    });
    
    // Build tree structure
    const unitMap = new Map<string, any>();
    const rootUnits: any[] = [];
    
    // First pass: create map
    allUnits.forEach(unit => {
      unitMap.set(unit.id, { ...unit, children: [] });
    });
    
    // Second pass: build tree
    allUnits.forEach(unit => {
      const node = unitMap.get(unit.id);
      if (unit.parentUnitId && unitMap.has(unit.parentUnitId)) {
        unitMap.get(unit.parentUnitId).children.push(node);
      } else {
        rootUnits.push(node);
      }
    });
    
    return { hierarchy: rootUnits };
  });

  // Add member to org unit
  fastify.post('/:id/members', {
    config: { permission: 'organizations:update' },
    schema: {
      tags: ['org-units'],
      summary: 'Add member to org unit',
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
    const { id: unitId } = request.params as { id: string };
    const tenantId = request.tenant.id;
    const { userId: memberUserId } = request.body as any;
    
    
    // Verify unit exists
    const unit = await prisma.orgUnit.findFirst({
      where: { id: unitId, tenantId },
      include: { organization: true },
    });
    
    if (!unit) {
      throw new AppError('Org unit not found', 404);
    }
    
    // Verify user exists and belongs to tenant
    const user = await prisma.user.findFirst({
      where: { id: memberUserId, tenantId },
    });
    
    if (!user) {
      throw new AppError('User not found', 404);
    }
    
    // Check if already a member
    const existing = await prisma.orgMembership.findFirst({
      where: { orgUnitId: unitId, userId: memberUserId },
    });
    
    if (existing) {
      throw new AppError('User is already a member of this unit', 409);
    }
    
    const membership = await prisma.orgMembership.create({
      data: {
        tenantId,
        userId: memberUserId,
        organizationId: unit.organizationId,
        orgUnitId: unitId,
      },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'added member to org unit',
        target: `${user.email} to ${unit.name}`,
        type: 'USER',
      },
    });
    
    return reply.status(201).send(membership);
  });

  // Remove member from org unit
  fastify.delete('/:id/members/:userId', {
    config: { permission: 'organizations:update' },
    schema: {
      tags: ['org-units'],
      summary: 'Remove member from org unit',
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
    const { id: unitId, userId: memberUserId } = request.params as { id: string; userId: string };
    const tenantId = request.tenant.id;
    
    
    await prisma.orgMembership.deleteMany({
      where: { orgUnitId: unitId, userId: memberUserId, tenantId },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'removed member from org unit',
        target: `user ${memberUserId} from unit ${unitId}`,
        type: 'USER',
      },
    });
    
    return reply.status(204).send();
  });
};
