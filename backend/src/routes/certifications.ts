import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType } from '../utils/authorization.js';

const createCertificationSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().optional(),
  reviewType: z.enum(['ROLE', 'PERMISSION', 'ORGANIZATION']),
  scopeType: z.enum(['TENANT', 'ORGANIZATION', 'ORG_UNIT']),
  scopeId: z.string().uuid(),
  reviewerId: z.string().uuid(),
  dueDate: z.string().datetime(),
});

const submitDecisionSchema = z.object({
  roleAssignmentId: z.string().uuid(),
  decision: z.enum(['APPROVE', 'REVOKE']),
  reason: z.string().optional(),
});

export const certificationRoutes: FastifyPluginAsync = async (fastify) => {
  // List certifications
  fastify.get('/', {
    schema: {
      tags: ['certifications'],
      summary: 'List access certifications',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', default: '1' },
          limit: { type: 'string', default: '20' },
          status: { type: 'string', enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE'] },
          reviewerId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const tenantId = request.tenant.id;
    const { page = '1', limit = '20', status, reviewerId } = request.query as any;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Users can see their own certifications, admins can see all
    const where = {
      tenantId,
      AND: [
        status ? { status } : {},
        reviewerId ? { reviewerId } : {},
        userType !== 'TENANT_ADMIN' ? { reviewerId: userId } : {},
      ],
    };
    
    const [certifications, total] = await Promise.all([
      prisma.accessCertification.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { dueDate: 'asc' },
        include: {
          reviewer: {
            select: { id: true, email: true, name: true },
          },
          _count: {
            select: { decisions: true },
          },
        },
      }),
      prisma.accessCertification.count({ where }),
    ]);
    
    return {
      certifications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  });

  // Get certification by ID
  fastify.get('/:id', {
    schema: {
      tags: ['certifications'],
      summary: 'Get certification by ID',
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
    
    const certification = await prisma.accessCertification.findFirst({
      where: { id, tenantId },
      include: {
        reviewer: {
          select: { id: true, email: true, name: true },
        },
        decisions: {
          include: {
            roleAssignment: {
              include: {
                role: {
                  select: { id: true, name: true },
                },
                user: {
                  select: { id: true, email: true, name: true },
                },
              },
            },
          },
        },
      },
    });
    
    if (!certification) {
      throw new AppError('Certification not found', 404);
    }
    
    return certification;
  });

  // Create certification
  fastify.post('/', {
    schema: {
      tags: ['certifications'],
      summary: 'Create access certification',
      body: {
        type: 'object',
        required: ['name', 'reviewType', 'scopeType', 'scopeId', 'reviewerId', 'dueDate'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 100 },
          description: { type: 'string' },
          reviewType: { type: 'string', enum: ['ROLE', 'PERMISSION', 'ORGANIZATION'] },
          scopeType: { type: 'string', enum: ['TENANT', 'ORGANIZATION', 'ORG_UNIT'] },
          scopeId: { type: 'string', format: 'uuid' },
          reviewerId: { type: 'string', format: 'uuid' },
          dueDate: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const tenantId = request.tenant.id;
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    const data = createCertificationSchema.parse(request.body);
    
    // Verify reviewer exists
    const reviewer = await prisma.user.findFirst({
      where: { id: data.reviewerId, tenantId },
    });
    
    if (!reviewer) {
      throw new AppError('Reviewer not found', 404);
    }
    
    // Validate due date
    const dueDate = new Date(data.dueDate);
    if (dueDate <= new Date()) {
      throw new AppError('Due date must be in the future', 400);
    }
    
    const certification = await prisma.accessCertification.create({
      data: {
        tenantId,
        ...data,
        dueDate,
      },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'created certification',
        target: certification.name,
        type: 'CONFIG',
      },
    });
    
    return reply.status(201).send(certification);
  });

  // Submit certification decision
  fastify.post('/:id/decisions', {
    schema: {
      tags: ['certifications'],
      summary: 'Submit certification decision',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        required: ['roleAssignmentId', 'decision'],
        properties: {
          roleAssignmentId: { type: 'string', format: 'uuid' },
          decision: { type: 'string', enum: ['APPROVE', 'REVOKE'] },
          reason: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const tenantId = request.tenant.id;
    const { id } = request.params as { id: string };
    const data = submitDecisionSchema.parse(request.body);
    
    // Verify certification exists and user is reviewer
    const certification = await prisma.accessCertification.findFirst({
      where: { id, tenantId, reviewerId: userId },
    });
    
    if (!certification) {
      throw new AppError('Certification not found or not assigned to you', 404);
    }
    
    if (certification.status === 'COMPLETED') {
      throw new AppError('Certification is already completed', 400);
    }
    
    // Verify role assignment exists
    const roleAssignment = await prisma.roleAssignment.findFirst({
      where: { id: data.roleAssignmentId, tenantId },
    });
    
    if (!roleAssignment) {
      throw new AppError('Role assignment not found', 404);
    }
    
    // Check for existing decision
    const existing = await prisma.certificationDecision.findFirst({
      where: {
        certificationId: id,
        roleAssignmentId: data.roleAssignmentId,
      },
    });
    
    if (existing) {
      throw new AppError('Decision already submitted for this assignment', 409);
    }
    
    // Create decision
    const decision = await prisma.certificationDecision.create({
      data: {
        certificationId: id,
        roleAssignmentId: data.roleAssignmentId,
        decision: data.decision,
        reason: data.reason,
      },
    });
    
    // If REVOKE, deactivate the role assignment
    if (data.decision === 'REVOKE') {
      await prisma.roleAssignment.update({
        where: { id: data.roleAssignmentId },
        data: { status: 'REVOKED' },
      });
    }
    
    // Update certification status
    await prisma.accessCertification.update({
      where: { id },
      data: { status: 'IN_PROGRESS' },
    });
    
    return reply.status(201).send(decision);
  });

  // Complete certification
  fastify.post('/:id/complete', {
    schema: {
      tags: ['certifications'],
      summary: 'Complete certification',
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
    const tenantId = request.tenant.id;
    const { id } = request.params as { id: string };
    
    // Verify certification exists and user is reviewer
    const certification = await prisma.accessCertification.findFirst({
      where: { id, tenantId, reviewerId: userId },
      include: {
        decisions: true,
      },
    });
    
    if (!certification) {
      throw new AppError('Certification not found or not assigned to you', 404);
    }
    
    if (certification.status === 'COMPLETED') {
      throw new AppError('Certification is already completed', 400);
    }
    
    const completed = await prisma.accessCertification.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'completed certification',
        target: certification.name,
        type: 'CONFIG',
      },
    });
    
    return completed;
  });

  // Get my certifications
  fastify.get('/my/certifications', {
    schema: {
      tags: ['certifications'],
      summary: 'Get my certifications',
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const tenantId = request.tenant.id;
    
    const certifications = await prisma.accessCertification.findMany({
      where: {
        tenantId,
        reviewerId: userId,
        status: { in: ['PENDING', 'IN_PROGRESS'] },
      },
      include: {
        _count: {
          select: { decisions: true },
        },
      },
      orderBy: { dueDate: 'asc' },
    });
    
    return { certifications };
  });
};
