import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType } from '../utils/authorization.js';
import { logActivity } from '../lib/activity.js';
import { audit } from '../lib/audit.js';
import { pageOf } from '../lib/pagination.js';
import { issuer } from '../lib/oidc/provider.js';

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
  // The organization's applications, for everyone in it: those turned on now,
  // and how to open each (its sign-in start address, with this issuer)
  fastify.get('/launchpad', {
    config: { permission: 'applications:read' },
    schema: { tags: ['tenant-applications'], summary: "Applications your organization has turned on, and how to open them" },
  }, async (request) => {
    const now = new Date();
    const rows = await controlDb.tenantApplication.findMany({
      where: {
        tenantId: request.tenant.id,
        state: { in: ['ENABLED', 'TRIAL'] },
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
        application: { status: 'ACTIVE' },
      },
      include: {
        application: {
          select: { id: true, key: true, name: true, description: true, signIn: { select: { enabled: true, initiateLoginUri: true } } },
        },
      },
      orderBy: { application: { name: 'asc' } },
    });
    return {
      applications: rows.map(({ application: a, state, validTo }) => {
        const signIn = a.signIn?.enabled ? a.signIn : null;
        let openUrl: string | null = null;
        if (signIn?.initiateLoginUri) {
          const u = new URL(signIn.initiateLoginUri);
          u.searchParams.set('iss', issuer());
          openUrl = u.href;
        }
        return { id: a.id, key: a.key, name: a.name, description: a.description, state, validTo, signIn: !!signIn, openUrl };
      }),
    };
  });

  // List tenant applications (entitlements)
  fastify.get('/', {
    config: { permission: 'applications:read' },
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
    const paging = pageOf(page, limit);
    
    const skip = paging.skip;
    
    const where = {
      tenantId,
      AND: [
        state ? { state } : {},
      ],
    };
    
    const [tenantApplications, total] = await Promise.all([
      controlDb.tenantApplication.findMany({
        where,
        skip,
        take: paging.limit,
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
      controlDb.tenantApplication.count({ where }),
    ]);
    
    return {
      tenantApplications,
      pagination: {
        page: paging.page,
        limit: paging.limit,
        total,
        pages: Math.ceil(total / paging.limit),
      },
    };
  });

  // Get tenant application by ID
  fastify.get('/:id', {
    config: { permission: 'applications:read' },
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
    
    const tenantApplication = await controlDb.tenantApplication.findFirst({
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
    config: { permission: 'applications:manage' },
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
    
    
    const data = createTenantApplicationSchema.parse(request.body);
    
    // Verify application exists and is active
    const application = await controlDb.applicationRegistry.findUnique({
      where: { id: data.applicationId },
    });
    
    if (!application) {
      throw new AppError('Application not found', 404);
    }
    
    if (application.status !== 'ACTIVE') {
      throw new AppError('Application is not active', 400);
    }
    
    // Check if already entitled
    const existing = await controlDb.tenantApplication.findFirst({
      where: { tenantId, applicationId: data.applicationId },
    });
    
    if (existing) {
      throw new AppError('Tenant already has entitlement to this application', 409);
    }
    
    const tenantApplication = await controlDb.tenantApplication.create({
      data: {
        tenantId,
        applicationId: data.applicationId,
        state: data.state,
        validFrom: data.validFrom ? new Date(data.validFrom) : new Date(),
        validTo: data.validTo ? new Date(data.validTo) : null,
      },
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'enabled application',
        target: application.name,
        type: 'CONFIG',
      });
    await audit(request, 'entitlement.updated', { resource: { type: 'application', id: application.id, label: application.name }, changes: { enabled: [false, true] }, details: { entitlementId: tenantApplication.id } });
    
    return reply.status(201).send(tenantApplication);
  });

  // Update tenant application
  fastify.patch('/:id', {
    config: { permission: 'applications:manage' },
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
    
    
    const data = updateTenantApplicationSchema.parse(request.body);
    
    const tenantApplication = await controlDb.tenantApplication.update({
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
    await logActivity({
        tenantId,
        userId,
        action: 'updated application entitlement',
        target: tenantApplication.application.name,
        type: 'CONFIG',
      });
    await audit(request, 'entitlement.updated', { resource: { type: 'application', id: tenantApplication.applicationId, label: tenantApplication.application.name }, details: { set: data } });
    
    return tenantApplication;
  });

  // Disable application for tenant
  fastify.delete('/:id', {
    config: { permission: 'applications:manage' },
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
    
    
    const tenantApplication = await controlDb.tenantApplication.delete({
      where: { id, tenantId },
      include: {
        application: {
          select: { name: true },
        },
      },
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'disabled application',
        target: tenantApplication.application.name,
        type: 'CONFIG',
      });
    await audit(request, 'entitlement.updated', { resource: { type: 'application', id: tenantApplication.applicationId, label: tenantApplication.application.name }, changes: { enabled: [true, false] } });
    
    return reply.status(204).send();
  });

  // Check if tenant has entitlement to application
  fastify.get('/check/:applicationId', {
    config: { permission: 'applications:read' },
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
    
    const tenantApplication = await controlDb.tenantApplication.findFirst({
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
