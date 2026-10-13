import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';

const createApplicationSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  version: z.string().default('1.0.0'),
  environment: z.enum(['PRODUCTION', 'STAGING', 'DEVELOPMENT']).default('DEVELOPMENT'),
  url: z.string().url(),
});

const updateApplicationSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().optional(),
  status: z.enum(['RUNNING', 'STOPPED', 'DEPLOYING', 'ERROR']).optional(),
  version: z.string().optional(),
  environment: z.enum(['PRODUCTION', 'STAGING', 'DEVELOPMENT']).optional(),
  url: z.string().url().optional(),
  cpu: z.number().min(0).max(100).optional(),
  memory: z.number().min(0).max(100).optional(),
  requests: z.number().min(0).optional(),
});

const querySchema = z.object({
  page: z.string().transform(Number).default('1'),
  limit: z.string().transform(Number).default('10'),
  status: z.enum(['RUNNING', 'STOPPED', 'DEPLOYING', 'ERROR']).optional(),
  environment: z.enum(['PRODUCTION', 'STAGING', 'DEVELOPMENT']).optional(),
  search: z.string().optional(),
});

export const applicationRoutes: FastifyPluginAsync = async (fastify) => {
  // List applications for current tenant
  fastify.get('/', {
    schema: {
      tags: ['applications'],
      summary: 'List applications for current tenant',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', default: '1' },
          limit: { type: 'string', default: '10' },
          status: { type: 'string', enum: ['RUNNING', 'STOPPED', 'DEPLOYING', 'ERROR'] },
          environment: { type: 'string', enum: ['PRODUCTION', 'STAGING', 'DEVELOPMENT'] },
          search: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { page, limit, status, environment, search } = querySchema.parse(request.query);
    const skip = (page - 1) * limit;

    const where = {
      tenantId: request.tenant.id,
      AND: [
        status ? { status } : {},
        environment ? { environment } : {},
        search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };

    const [applications, total] = await Promise.all([
      prisma.application.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.application.count({ where }),
    ]);

    return {
      data: applications,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  });

  // Get application by ID
  fastify.get('/:id', {
    schema: {
      tags: ['applications'],
      summary: 'Get application by ID',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;

    const application = await prisma.application.findFirst({
      where: {
        id,
        tenantId: request.tenant.id,
      },
    });

    if (!application) {
      throw new AppError('Application not found', 404);
    }

    return application;
  });

  // Create application
  fastify.post('/', {
    schema: {
      tags: ['applications'],
      summary: 'Create application',
      body: {
        type: 'object',
        required: ['name', 'url'],
        properties: {
          name: { type: 'string', minLength: 2 },
          description: { type: 'string' },
          version: { type: 'string', default: '1.0.0' },
          environment: { type: 'string', enum: ['PRODUCTION', 'STAGING', 'DEVELOPMENT'], default: 'DEVELOPMENT' },
          url: { type: 'string', format: 'uri' },
        },
      },
    },
  }, async (request, reply) => {
    const data = createApplicationSchema.parse(request.body);

    const application = await prisma.application.create({
      data: {
        ...data,
        tenantId: request.tenant.id,
        status: 'DEPLOYING',
      },
    });

    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'created application',
        target: application.name,
        type: 'DEPLOY',
      },
    });

    return reply.status(201).send(application);
  });

  // Update application
  fastify.patch('/:id', {
    schema: {
      tags: ['applications'],
      summary: 'Update application',
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
          name: { type: 'string', minLength: 2 },
          description: { type: 'string' },
          status: { type: 'string', enum: ['RUNNING', 'STOPPED', 'DEPLOYING', 'ERROR'] },
          version: { type: 'string' },
          environment: { type: 'string', enum: ['PRODUCTION', 'STAGING', 'DEVELOPMENT'] },
          url: { type: 'string', format: 'uri' },
          cpu: { type: 'number', minimum: 0, maximum: 100 },
          memory: { type: 'number', minimum: 0, maximum: 100 },
          requests: { type: 'number', minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const data = updateApplicationSchema.parse(request.body);

    const application = await prisma.application.update({
      where: {
        id,
        tenantId: request.tenant.id,
      },
      data: {
        ...data,
        lastDeployedAt: data.version ? new Date() : undefined,
      },
    });

    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'updated application',
        target: application.name,
        type: 'CONFIG',
        metadata: data,
      },
    });

    return application;
  });

  // Delete application
  fastify.delete('/:id', {
    schema: {
      tags: ['applications'],
      summary: 'Delete application',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;

    const application = await prisma.application.delete({
      where: {
        id,
        tenantId: request.tenant.id,
      },
    });

    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'deleted application',
        target: application.name,
        type: 'CONFIG',
      },
    });

    return reply.status(204).send();
  });

  // Deploy application (simulate deployment)
  fastify.post('/:id/deploy', {
    schema: {
      tags: ['applications'],
      summary: 'Deploy application',
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
          version: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { version } = request.body as { version?: string };

    // Update status to DEPLOYING
    const application = await prisma.application.update({
      where: {
        id,
        tenantId: request.tenant.id,
      },
      data: {
        status: 'DEPLOYING',
        version: version || undefined,
      },
    });

    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'deployed application',
        target: `${application.name} v${application.version}`,
        type: 'DEPLOY',
      },
    });

    // Simulate deployment completion after 2 seconds
    setTimeout(async () => {
      await prisma.application.update({
        where: { id },
        data: {
          status: 'RUNNING',
          lastDeployedAt: new Date(),
        },
      });

      await prisma.activity.create({
        data: {
          tenantId: request.tenant.id,
          action: 'deployment completed',
          target: `${application.name} v${application.version}`,
          type: 'DEPLOY',
        },
      });
    }, 2000);

    return {
      message: 'Deployment started',
      application,
    };
  });
};
