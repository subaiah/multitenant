import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType } from '../utils/authorization.js';

const createTenantApplicationSchema = z.object({
  applicationId: z.string().uuid(),
  state: z.enum(['ENABLED', 'DISABLED', 'TRIAL']).default('ENABLED'),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
});

const updateTenantApplicationSchema = z.object({
  state: z.enum(['ENABLED', 'DISABLED', 'TRIAL']).optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
});

export const tenantApplicationRoutes: FastifyPluginAsync = async (fastify) => {
  // List tenant applications (entitlements)
  fastify.get('/', {
    schema: {
      tags: ['tenant-applications'],
      summary: 'List tenant applications',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', default: '1' },
          limit: { type: 'string', default: '20' },
          state: { type: 'string', enum: ['ENABLED', 'DISABLED', 'TRIAL'] },
        },
      },
    },
  }, async (request, reply) => {
    const tenantId = request.tenant.id;
    const { page = '1', limit = '20', state } = request.query as any;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const where = {
      tenantId,
      AND: [
        state ? { state } : {},
      ],
    };
    
    const [tenantApplications, total] = await Promise.all([
      prisma.tenantApplication.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          application: {
            select: {
              id: true,
              key: true,
              name: true,
              description: true,
              version: true,
              status: true,
              _count: {
                select: { permissions: true },
              },
            },
          },
        },
      }),
      prisma.tenantApplication.count({ where }),
    ]);
    
    return {
      tenantApplications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  });

  // Get tenant application by ID
  fastify.get('/:id', {
    schema: {
      tags: ['tenant-applications'],
      summary: 'Get tenant application by ID',
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
    
    const tenantApplication = await prisma.tenantApplication.findFirst({
      where: { id, tenantId },
      include: {
        application: {
          include: {
            permissions: true,
          },
        },
      },
    });
    
    if (!tenantApplication) {
      throw new AppError('Tenant application not found', 404);
    }
    
    return tenantApplication;
  });

  // Enable application for tenant
  fastify.post('/', {
    schema: {
      tags: ['tenant-applications'],
      summary: 'Enable application for tenant',
      body: {
        type: 'object',
        required: ['applicationId'],
        properties: {
          applicationId: { type: 'string', format: 'uuid' },
          state: { type: 'string', enum: ['ENABLED', 'DISABLED', 'TRIAL'] },
          validFrom: { type: 'string', format: 'date-time' },
          validTo: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const tenantId = request.tenant.id;
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    const data = createTenantApplicationSchema.parse(request.body);
    
    // Verify application exists and is active
    const application = await prisma.applicationRegistry.findUnique({
      where: { id: data.applicationId },
    });
    
    if (!application) {
      throw new AppError('Application not found', 404);
    }
    
    if (application.status !== 'ACTIVE') {
      throw new AppError('Application is not active', 400);
    }
    
    // Check if already entitled
    const existing = await prisma.tenantApplication.findFirst({
      where: { tenantId, applicationId: data.applicationId },
    });
    
    if (existing) {
      throw new AppError('Tenant already has entitlement to this application', 409);
    }
    
    const tenantApplication = await prisma.tenantApplication.create({
      data: {
        tenantId,
        applicationId: data.applicationId,
        state: data.state,
        validFrom: data.validFrom ? new Date(data.validFrom) : new Date(),
        validTo: data.validTo ? new Date(data.validTo) : null,
      },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'enabled application',
        target: application.name,
        type: 'CONFIG',
      },
    });
    
    return reply.status(201).send(tenantApplication);
  });

  // Update tenant application
  fastify.patch('/:id', {
    schema: {
      tags: ['tenant-applications'],
      summary: 'Update tenant application',
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
          state: { type: 'string', enum: ['ENABLED', 'DISABLED', 'TRIAL'] },
          validFrom: { type: 'string', format: 'date-time' },
          validTo: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { id } = request.params as { id: string };
    const tenantId = request.tenant.id;
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    const data = updateTenantApplicationSchema.parse(request.body);
    
    const tenantApplication = await prisma.tenantApplication.update({
      where: { id, tenantId },
      data: {
        ...data,
        validFrom: data.validFrom ? new Date(data.validFrom) : undefined,
        validTo: data.validTo ? new Date(data.validTo) : undefined,
      },
      include: {
        application: {
          select: { name: true },
        },
      },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'updated application entitlement',
        target: tenantApplication.application.name,
        type: 'CONFIG',
      },
    });
    
    return tenantApplication;
  });

  // Disable application for tenant
  fastify.delete('/:id', {
    schema: {
      tags: ['tenant-applications'],
      summary: 'Disable application for tenant',
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
    
    const tenantApplication = await prisma.tenantApplication.delete({
      where: { id, tenantId },
      include: {
        application: {
          select: { name: true },
        },
      },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'disabled application',
        target: tenantApplication.application.name,
        type: 'CONFIG',
      },
    });
    
    return reply.status(204).send();
  });

  // Check if tenant has entitlement to application
  fastify.get('/check/:applicationId', {
    schema: {
      tags: ['tenant-applications'],
      summary: 'Check if tenant has entitlement to application',
      params: {
        type: 'object',
        required: ['applicationId'],
        properties: {
          applicationId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { applicationId } = request.params as { applicationId: string };
    const tenantId = request.tenant.id;
    
    const tenantApplication = await prisma.tenantApplication.findFirst({
      where: {
        tenantId,
        applicationId,
        state: 'ENABLED',
        validFrom: { lte: new Date() },
        OR: [
          { validTo: null },
          { validTo: { gt: new Date() } },
        ],
      },
    });
    
    return {
      hasEntitlement: !!tenantApplication,
      tenantApplication: tenantApplication || null,
    };
  });
};
