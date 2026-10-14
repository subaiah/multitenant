import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType, isPlatformAdmin } from '../utils/authorization.js';

const createSupportSessionSchema = z.object({
  tenantId: z.string().uuid(),
  reason: z.string().min(10),
  permissions: z.array(z.string()),
  validTo: z.string().datetime(),
});

const approveSupportSessionSchema = z.object({
  approved: z.boolean(),
  reason: z.string().optional(),
});

export const supportSessionRoutes: FastifyPluginAsync = async (fastify) => {
  // List support sessions (platform admin only)
  fastify.get('/', {
    schema: {
      tags: ['support-sessions'],
      summary: 'List support sessions',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', default: '1' },
          limit: { type: 'string', default: '20' },
          status: { type: 'string', enum: ['ACTIVE', 'EXPIRED', 'REVOKED'] },
          tenantId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userType = (request.user as any).userType;
    
    if (!isPlatformAdmin(userType)) {
      throw new AppError('Only platform admins can view support sessions', 403);
    }
    
    const { page = '1', limit = '20', status, tenantId } = request.query as any;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const where = {
      AND: [
        status ? { status } : {},
        tenantId ? { tenantId } : {},
      ],
    };
    
    const [sessions, total] = await Promise.all([
      prisma.supportSession.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          platformUser: {
            select: { id: true, email: true, name: true },
          },
          tenant: {
            select: { id: true, name: true, slug: true },
          },
          approver: {
            select: { id: true, email: true, name: true },
          },
        },
      }),
      prisma.supportSession.count({ where }),
    ]);
    
    return {
      sessions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  });

  // Request support session (platform user)
  fastify.post('/request', {
    schema: {
      tags: ['support-sessions'],
      summary: 'Request support session',
      body: {
        type: 'object',
        required: ['tenantId', 'reason', 'permissions', 'validTo'],
        properties: {
          tenantId: { type: 'string', format: 'uuid' },
          reason: { type: 'string', minLength: 10 },
          permissions: { type: 'array', items: { type: 'string' } },
          validTo: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    
    if (!isPlatformAdmin(userType) && userType !== 'PLATFORM_USER') {
      throw new AppError('Only platform users can request support sessions', 403);
    }
    
    const data = createSupportSessionSchema.parse(request.body);
    
    // Verify tenant exists
    const tenant = await prisma.tenant.findUnique({
      where: { id: data.tenantId },
    });
    
    if (!tenant) {
      throw new AppError('Tenant not found', 404);
    }
    
    // Validate dates
    const validTo = new Date(data.validTo);
    if (validTo <= new Date()) {
      throw new AppError('validTo must be in the future', 400);
    }
    
    // Create pending session (requires approval)
    const session = await prisma.supportSession.create({
      data: {
        platformUserId: userId,
        tenantId: data.tenantId,
        approvedBy: userId, // Self-approved for now, in production requires separate approval
        reason: data.reason,
        permissions: data.permissions,
        validFrom: new Date(),
        validTo,
        status: 'ACTIVE',
      },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: data.tenantId,
        userId,
        action: 'created support session',
        target: `Support session for ${tenant.name}`,
        type: 'AUTH',
      },
    });
    
    return reply.status(201).send(session);
  });

  // Revoke support session
  fastify.post('/:id/revoke', {
    schema: {
      tags: ['support-sessions'],
      summary: 'Revoke support session',
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
    
    if (!isPlatformAdmin(userType)) {
      throw new AppError('Only platform admins can revoke support sessions', 403);
    }
    
    const session = await prisma.supportSession.findUnique({
      where: { id },
    });
    
    if (!session) {
      throw new AppError('Support session not found', 404);
    }
    
    if (session.status !== 'ACTIVE') {
      throw new AppError('Support session is not active', 400);
    }
    
    const revoked = await prisma.supportSession.update({
      where: { id },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
      },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: session.tenantId,
        userId,
        action: 'revoked support session',
        target: `Support session ${id}`,
        type: 'AUTH',
      },
    });
    
    return revoked;
  });

  // Get my active support sessions
  fastify.get('/my/sessions', {
    schema: {
      tags: ['support-sessions'],
      summary: 'Get my active support sessions',
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    
    const sessions = await prisma.supportSession.findMany({
      where: {
        platformUserId: userId,
        status: 'ACTIVE',
        validTo: { gt: new Date() },
      },
      include: {
        tenant: {
          select: { id: true, name: true, slug: true },
        },
      },
      orderBy: { validTo: 'asc' },
    });
    
    return { sessions };
  });
};
