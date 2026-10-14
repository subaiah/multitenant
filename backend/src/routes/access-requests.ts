import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType } from '../utils/authorization.js';

const createAccessRequestSchema = z.object({
  roleId: z.string().uuid(),
  scopeType: z.enum(['TENANT', 'ORGANIZATION', 'ORG_UNIT', 'RESOURCE']),
  scopeId: z.string().uuid(),
  reason: z.string().min(10),
  duration: z.number().int().min(1).max(168), // 1 hour to 7 days
});

const approveAccessRequestSchema = z.object({
  approved: z.boolean(),
  reason: z.string().optional(),
});

export const accessRequestRoutes: FastifyPluginAsync = async (fastify) => {
  // List access requests
  fastify.get('/', {
    schema: {
      tags: ['access-requests'],
      summary: 'List access requests',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', default: '1' },
          limit: { type: 'string', default: '20' },
          status: { type: 'string', enum: ['PENDING', 'APPROVED', 'DENIED', 'EXPIRED'] },
          requesterId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const tenantId = request.tenant.id;
    const { page = '1', limit = '20', status, requesterId } = request.query as any;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Users can see their own requests, admins can see all
    const where = {
      tenantId,
      AND: [
        status ? { status } : {},
        requesterId ? { requesterId } : {},
        userType !== 'TENANT_ADMIN' ? { requesterId: userId } : {},
      ],
    };
    
    const [requests, total] = await Promise.all([
      prisma.accessRequest.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          requester: {
            select: { id: true, email: true, name: true },
          },
          approver: {
            select: { id: true, email: true, name: true },
          },
          role: {
            select: { id: true, name: true, description: true },
          },
        },
      }),
      prisma.accessRequest.count({ where }),
    ]);
    
    return {
      requests,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  });

  // Create access request (Just-in-Time)
  fastify.post('/', {
    schema: {
      tags: ['access-requests'],
      summary: 'Create access request',
      body: {
        type: 'object',
        required: ['roleId', 'scopeType', 'scopeId', 'reason', 'duration'],
        properties: {
          roleId: { type: 'string', format: 'uuid' },
          scopeType: { type: 'string', enum: ['TENANT', 'ORGANIZATION', 'ORG_UNIT', 'RESOURCE'] },
          scopeId: { type: 'string', format: 'uuid' },
          reason: { type: 'string', minLength: 10 },
          duration: { type: 'number', minimum: 1, maximum: 168 },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const tenantId = request.tenant.id;
    
    const data = createAccessRequestSchema.parse(request.body);
    
    // Verify role exists
    const role = await prisma.role.findFirst({
      where: { id: data.roleId, tenantId },
    });
    
    if (!role) {
      throw new AppError('Role not found', 404);
    }
    
    // Check for existing pending request
    const existing = await prisma.accessRequest.findFirst({
      where: {
        tenantId,
        requesterId: userId,
        roleId: data.roleId,
        status: 'PENDING',
      },
    });
    
    if (existing) {
      throw new AppError('Pending request already exists for this role', 409);
    }
    
    const accessRequest = await prisma.accessRequest.create({
      data: {
        tenantId,
        requesterId: userId,
        roleId: data.roleId,
        scopeType: data.scopeType,
        scopeId: data.scopeId,
        reason: data.reason,
        duration: data.duration,
      },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'requested access',
        target: `Access request for ${role.name}`,
        type: 'USER',
      },
    });
    
    return reply.status(201).send(accessRequest);
  });

  // Approve/Deny access request
  fastify.post('/:id/decide', {
    schema: {
      tags: ['access-requests'],
      summary: 'Approve or deny access request',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        required: ['approved'],
        properties: {
          approved: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const tenantId = request.tenant.id;
    const { id } = request.params as { id: string };
    const { approved, reason } = approveAccessRequestSchema.parse(request.body);
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    const accessRequest = await prisma.accessRequest.findFirst({
      where: { id, tenantId },
    });
    
    if (!accessRequest) {
      throw new AppError('Access request not found', 404);
    }
    
    if (accessRequest.status !== 'PENDING') {
      throw new AppError('Access request is not pending', 400);
    }
    
    const now = new Date();
    const validTo = new Date(now.getTime() + accessRequest.duration * 60 * 60 * 1000);
    
    const updated = await prisma.accessRequest.update({
      where: { id },
      data: {
        status: approved ? 'APPROVED' : 'DENIED',
        approverId: userId,
        approvedAt: approved ? now : null,
        deniedAt: approved ? null : now,
        denialReason: approved ? null : reason,
        validFrom: approved ? now : null,
        validTo: approved ? validTo : null,
      },
    });
    
    // If approved, create temporary role assignment
    if (approved) {
      await prisma.roleAssignment.create({
        data: {
          tenantId,
          roleId: accessRequest.roleId,
          principalType: 'USER',
          userId: accessRequest.requesterId,
          scopeType: accessRequest.scopeType,
          scopeId: accessRequest.scopeId,
          validFrom: now,
          validTo,
          status: 'ACTIVE',
        },
      });
    }
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: approved ? 'approved access request' : 'denied access request',
        target: `Access request ${id}`,
        type: 'USER',
      },
    });
    
    return updated;
  });

  // Get my pending requests
  fastify.get('/my/pending', {
    schema: {
      tags: ['access-requests'],
      summary: 'Get my pending requests',
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const tenantId = request.tenant.id;
    
    const requests = await prisma.accessRequest.findMany({
      where: {
        tenantId,
        requesterId: userId,
        status: 'PENDING',
      },
      include: {
        role: {
          select: { id: true, name: true, description: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    
    return { requests };
  });
};
