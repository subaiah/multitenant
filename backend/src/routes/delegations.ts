import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType } from '../utils/authorization.js';
import { AUTHENTICATED } from '../middleware/authorize.js';
import { hasPermission, requirePermission } from '../middleware/authorize.js';
import { logActivity } from '../lib/activity.js';
import { audit } from '../lib/audit.js';

const createDelegationSchema = z.object({
  delegateId: z.string().uuid(),
  roleAssignmentId: z.string().uuid(),
  reason: z.string().optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime(),
});

const revokeDelegationSchema = z.object({
  reason: z.string().optional(),
});

export const delegationRoutes: FastifyPluginAsync = async (fastify) => {
  // List delegations for current tenant
  fastify.get('/', {
    config: { permission: 'delegations:read' },
    schema: {
      tags: ['delegations'],
      summary: 'List delegations',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', default: '1' },
          limit: { type: 'string', default: '20' },
          status: { type: 'string', enum: ['ACTIVE', 'EXPIRED', 'REVOKED'] },
          delegateId: { type: 'string', format: 'uuid' },
          delegatorId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const tenantId = request.tenant.id;
    const { page = '1', limit = '20', status, delegateId, delegatorId } = request.query as any;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const where = {
      tenantId,
      AND: [
        status ? { status } : {},
        delegateId ? { delegateId } : {},
        delegatorId ? { delegatorId } : {},
      ],
    };
    
    const [delegations, total] = await Promise.all([
      request.db.delegation.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          delegator: {
            select: { id: true, email: true, name: true },
          },
          delegate: {
            select: { id: true, email: true, name: true },
          },
          roleAssignment: {
            include: {
              role: {
                select: { id: true, name: true },
              },
            },
          },
        },
      }),
      request.db.delegation.count({ where }),
    ]);
    
    return {
      delegations,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  });

  // Get delegation by ID
  fastify.get('/:id', {
    config: { permission: 'delegations:read' },
    schema: {
      tags: ['delegations'],
      summary: 'Get delegation by ID',
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
    
    const delegation = await request.db.delegation.findFirst({
      where: { id, tenantId },
      include: {
        delegator: {
          select: { id: true, email: true, name: true, userType: true },
        },
        delegate: {
          select: { id: true, email: true, name: true, userType: true },
        },
        roleAssignment: {
          include: {
            role: true,
          },
        },
      },
    });
    
    if (!delegation) {
      throw new AppError('Delegation not found', 404);
    }
    
    return delegation;
  });

  // Create delegation
  fastify.post('/', {
    config: { permission: AUTHENTICATED },
    schema: {
      tags: ['delegations'],
      summary: 'Create delegation',
      body: {
        type: 'object',
        required: ['delegateId', 'roleAssignmentId', 'validTo'],
        properties: {
          delegateId: { type: 'string', format: 'uuid' },
          roleAssignmentId: { type: 'string', format: 'uuid' },
          reason: { type: 'string' },
          validFrom: { type: 'string', format: 'date-time' },
          validTo: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const tenantId = request.tenant.id;
    
    const data = createDelegationSchema.parse(request.body);
    
    // Verify role assignment exists and belongs to delegator
    const roleAssignment = await request.db.roleAssignment.findFirst({
      where: {
        id: data.roleAssignmentId,
        tenantId,
        userId, // Delegator must own the role assignment
        status: 'ACTIVE',
      },
    });
    
    if (!roleAssignment) {
      throw new AppError('Role assignment not found or not owned by you', 404);
    }
    
    // Verify delegate exists and belongs to same tenant
    const delegate = await request.db.user.findFirst({
      where: { id: data.delegateId, tenantId },
    });
    
    if (!delegate) {
      throw new AppError('Delegate user not found', 404);
    }
    
    // Cannot delegate to yourself
    if (data.delegateId === userId) {
      throw new AppError('Cannot delegate to yourself', 400);
    }
    
    // Validate dates
    const validFrom = data.validFrom ? new Date(data.validFrom) : new Date();
    const validTo = new Date(data.validTo);
    
    if (validTo <= validFrom) {
      throw new AppError('validTo must be after validFrom', 400);
    }
    
    if (validTo <= new Date()) {
      throw new AppError('validTo must be in the future', 400);
    }
    
    // Check for existing active delegation
    const existing = await request.db.delegation.findFirst({
      where: {
        tenantId,
        delegateId: data.delegateId,
        roleAssignmentId: data.roleAssignmentId,
        status: 'ACTIVE',
        validTo: { gt: new Date() },
      },
    });
    
    if (existing) {
      throw new AppError('Active delegation already exists for this user and role', 409);
    }
    
    const delegation = await request.db.delegation.create({
      data: {
        tenantId,
        delegatorId: userId,
        delegateId: data.delegateId,
        roleAssignmentId: data.roleAssignmentId,
        reason: data.reason,
        validFrom,
        validTo,
      },
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'created delegation',
        target: `Delegation to ${delegate.email}`,
        type: 'USER',
      });
    await audit(request, 'delegation.created', { resource: { type: 'delegation', id: delegation.id, label: `to ${delegate.email}` }, details: { delegateId: data.delegateId, roleAssignmentId: data.roleAssignmentId, reason: data.reason, validFrom, validTo } });
    
    return reply.status(201).send(delegation);
  });

  // Revoke delegation
  fastify.post('/:id/revoke', {
    config: { permission: AUTHENTICATED },
    schema: {
      tags: ['delegations'],
      summary: 'Revoke delegation',
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
          reason: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const { id } = request.params as { id: string };
    const tenantId = request.tenant.id;
    const { reason } = revokeDelegationSchema.parse(request.body);
    
    const delegation = await request.db.delegation.findFirst({
      where: { id, tenantId },
    });
    
    if (!delegation) {
      throw new AppError('Delegation not found', 404);
    }
    
    if (delegation.status !== 'ACTIVE') {
      throw new AppError('Delegation is not active', 400);
    }
    
    // Only delegator or tenant admin can revoke
    const userType = (request.user as any).userType;
    if (delegation.delegatorId !== userId && !(await hasPermission(request, 'delegations:manage'))) {
      throw new AppError('Not authorized to revoke this delegation', 403);
    }
    
    const revoked = await request.db.delegation.update({
      where: { id },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedBy: userId,
      },
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'revoked delegation',
        target: `Delegation ${id}`,
        type: 'USER',
      });
    await audit(request, 'delegation.revoked', { resource: { type: 'delegation', id }, details: { delegatorId: delegation.delegatorId, delegateId: delegation.delegateId } });
    
    return revoked;
  });

  // Get my delegations (as delegate)
  fastify.get('/my/delegations', {
    config: { permission: AUTHENTICATED },
    schema: {
      tags: ['delegations'],
      summary: 'Get my active delegations',
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const tenantId = request.tenant.id;
    
    const delegations = await request.db.delegation.findMany({
      where: {
        tenantId,
        delegateId: userId,
        status: 'ACTIVE',
        validTo: { gt: new Date() },
      },
      include: {
        delegator: {
          select: { id: true, email: true, name: true },
        },
        roleAssignment: {
          include: {
            role: {
              select: { id: true, name: true, description: true },
            },
          },
        },
      },
      orderBy: { validTo: 'asc' },
    });
    
    return { delegations };
  });
};
