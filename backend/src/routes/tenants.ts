import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';

const updateTenantSchema = z.object({
  name: z.string().min(2).optional(),
  plan: z.enum(['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE']).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'TRIAL']).optional(),
});

const querySchema = z.object({
  page: z.string().transform(Number).default('1'),
  limit: z.string().transform(Number).default('10'),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'TRIAL']).optional(),
  plan: z.enum(['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE']).optional(),
  search: z.string().optional(),
});

export const tenantRoutes: FastifyPluginAsync = async (fastify) => {
  // List tenants (admin only)
  fastify.get('/', {
    schema: {
      tags: ['tenants'],
      summary: 'List all tenants',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', default: '1' },
          limit: { type: 'string', default: '10' },
          status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'TRIAL'] },
          plan: { type: 'string', enum: ['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE'] },
          search: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    // Check if user is admin
    if (!['PLATFORM_ADMIN', 'TENANT_ADMIN'].includes(request.user.userType)) {
      throw new AppError('Admin access required', 403);
    }

    const { page, limit, status, plan, search } = querySchema.parse(request.query);
    const skip = (page - 1) * limit;

    const where = {
      AND: [
        status ? { status } : {},
        plan ? { plan } : {},
        search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { slug: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };

    const [tenants, total] = await Promise.all([
      prisma.tenant.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              users: true,
              applications: true,
            },
          },
        },
      }),
      prisma.tenant.count({ where }),
    ]);

    return {
      data: tenants,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  });

  // Get current tenant
  fastify.get('/current', {
    schema: {
      tags: ['tenants'],
      summary: 'Get current tenant',
    },
  }, async (request, reply) => {
    const tenant = await prisma.tenant.findUnique({
      where: { id: request.tenant.id },
      include: {
        _count: {
          select: {
            users: true,
            applications: true,
          },
        },
      },
    });

    return tenant;
  });

  // Get tenant by ID
  fastify.get('/:id', {
    schema: {
      tags: ['tenants'],
      summary: 'Get tenant by ID',
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

    // Only admins can view other tenants
    if (!['PLATFORM_ADMIN', 'TENANT_ADMIN'].includes(request.user.userType) && request.tenant.id !== id) {
      throw new AppError('Access denied', 403);
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            users: true,
            applications: true,
          },
        },
      },
    });

    if (!tenant) {
      throw new AppError('Tenant not found', 404);
    }

    return tenant;
  });

  // Update tenant
  fastify.patch('/:id', {
    schema: {
      tags: ['tenants'],
      summary: 'Update tenant',
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
          plan: { type: 'string', enum: ['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE'] },
          status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'TRIAL'] },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const data = updateTenantSchema.parse(request.body);

    // Only admins can update tenants
    if (!['PLATFORM_ADMIN', 'TENANT_ADMIN'].includes(request.user.userType)) {
      throw new AppError('Admin access required', 403);
    }

    const tenant = await prisma.tenant.update({
      where: { id },
      data,
    });

    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: id,
        userId: request.user.userId,
        action: 'updated tenant',
        target: tenant.name,
        type: 'CONFIG',
        metadata: data,
      },
    });

    return tenant;
  });

  // Delete tenant
  fastify.delete('/:id', {
    schema: {
      tags: ['tenants'],
      summary: 'Delete tenant',
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

    // Only admins can delete tenants
    if (!['PLATFORM_ADMIN', 'TENANT_ADMIN'].includes(request.user.userType)) {
      throw new AppError('Admin access required', 403);
    }

    await prisma.tenant.delete({
      where: { id },
    });

    return reply.status(204).send();
  });
};
