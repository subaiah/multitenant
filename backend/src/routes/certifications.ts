import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType } from '../utils/authorization.js';
import { AUTHENTICATED } from '../middleware/authorize.js';
import { hasPermission, requirePermission } from '../middleware/authorize.js';
import { logActivity } from '../lib/activity.js';
import { audit } from '../lib/audit.js';
import { pageOf } from '../lib/pagination.js';

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
    config: { permission: 'certifications:read' },
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
    const paging = pageOf(page, limit);
    
    const skip = paging.skip;
    
    // Users can see their own certifications, admins can see all
    const where = {
      tenantId,
      AND: [
        status ? { status } : {},
        reviewerId ? { reviewerId } : {},
        // Certification managers see all; reviewers see the ones assigned to them
        (await hasPermission(request, 'certifications:manage')) ? {} : { reviewerId: userId },
      ],
    };
    
    const [certifications, total] = await Promise.all([
      request.db.accessCertification.findMany({
        where,
        skip,
        take: paging.limit,
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
      request.db.accessCertification.count({ where }),
    ]);
    
    return {
      certifications,
      pagination: {
        page: paging.page,
        limit: paging.limit,
        total,
        pages: Math.ceil(total / paging.limit),
      },
    };
  });

  // Get certification by ID
  fastify.get('/:id', {
    config: { permission: 'certifications:read' },
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
    
    const certification = await request.db.accessCertification.findFirst({
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
    config: { permission: 'certifications:manage' },
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
    
    
    const data = createCertificationSchema.parse(request.body);
    
    // Verify reviewer exists
    const reviewer = await request.db.user.findFirst({
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
    
    const certification = await request.db.accessCertification.create({
      data: {
        tenantId,
        ...data,
        dueDate,
      },
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'created certification',
        target: certification.name,
        type: 'CONFIG',
      });
    await audit(request, 'certification.created', { resource: { type: 'certification', id: certification.id, label: certification.name } });
    
    return reply.status(201).send(certification);
  });

  // Submit certification decision
  fastify.post('/:id/decisions', {
    config: { permission: AUTHENTICATED },
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
    const certification = await request.db.accessCertification.findFirst({
      where: { id, tenantId, reviewerId: userId },
    });
    
    if (!certification) {
      throw new AppError('Certification not found or not assigned to you', 404);
    }
    
    if (certification.status === 'COMPLETED') {
      throw new AppError('Certification is already completed', 400);
    }
    
    // Verify role assignment exists
    const roleAssignment = await request.db.roleAssignment.findFirst({
      where: { id: data.roleAssignmentId, tenantId },
    });
    
    if (!roleAssignment) {
      throw new AppError('Role assignment not found', 404);
    }
    
    // Check for existing decision
    const existing = await request.db.certificationDecision.findFirst({
      where: {
        certificationId: id,
        roleAssignmentId: data.roleAssignmentId,
      },
    });
    
    if (existing) {
      throw new AppError('Decision already submitted for this assignment', 409);
    }
    
    // Create decision
    const decision = await request.db.certificationDecision.create({
      data: {
        tenantId: request.tenant.id,
        certificationId: id,
        roleAssignmentId: data.roleAssignmentId,
        decision: data.decision,
        reason: data.reason,
      },
    });
    
    // If REVOKE, deactivate the role assignment
    if (data.decision === 'REVOKE') {
      await request.db.roleAssignment.update({
        where: { id: data.roleAssignmentId },
        data: { status: 'REVOKED' },
      });
    }
    
    // Update certification status
    await request.db.accessCertification.update({
      where: { id },
      data: { status: 'IN_PROGRESS' },
    });
    
    return reply.status(201).send(decision);
  });

  // Complete certification
  fastify.post('/:id/complete', {
    config: { permission: AUTHENTICATED },
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
    const certification = await request.db.accessCertification.findFirst({
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
    
    const completed = await request.db.accessCertification.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'completed certification',
        target: certification.name,
        type: 'CONFIG',
      });
    await audit(request, 'certification.completed', { resource: { type: 'certification', id, label: certification.name } });
    
    return completed;
  });

  // Get my certifications
  fastify.get('/my/certifications', {
    config: { permission: AUTHENTICATED },
    schema: {
      tags: ['certifications'],
      summary: 'Get my certifications',
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const tenantId = request.tenant.id;
    
    const certifications = await request.db.accessCertification.findMany({
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
