import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { countBy } from '../lib/stats.js';
import { isPlatformAdmin, isPlatformUser, isTenantAdmin } from '../utils/authorization.js';

const emptyToNull = (v: unknown) => (v === '' ? null : v);

const updateTenantSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  // Branding (shown on the tenant's login page)
  logoUrl: z.preprocess(emptyToNull, z.string().url().max(500).nullable()).optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #3b82f6').optional(),
  loginTitle: z.preprocess(emptyToNull, z.string().max(100).nullable()).optional(),
  loginSubtitle: z.preprocess(emptyToNull, z.string().max(200).nullable()).optional(),
  // Platform admins only
  plan: z.enum(['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE']).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'TRIAL']).optional(),
});

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).default(10),
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
    // Listing all tenants is a platform-level operation
    if (!isPlatformUser(request.user.userType)) {
      throw new AppError('Platform access required', 403);
    }

    const { page, limit, status, plan, search } = querySchema.parse(request.query);
    const skip = (page - 1) * limit;

    const searchFilter = search
      ? { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { slug: { contains: search, mode: 'insensitive' as const } }] }
      : {};

    const where = {
      AND: [
        status ? { status } : {},
        plan ? { plan } : {},
        search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { slug: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {},
      ],
    };

    const [tenants, total, statusCounts] = await Promise.all([
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
      // Counts for the status tabs: same plan/search filters, any status
      prisma.tenant.groupBy({ by: ['status'], where: { AND: [plan ? { plan } : {}, searchFilter] }, _count: true }),
    ]);

    // Last activity per tenant on this page
    const lastActivity = await prisma.activity.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: tenants.map((t) => t.id) } },
      _max: { createdAt: true },
    });
    const lastActiveAt = new Map(lastActivity.map((a) => [a.tenantId, a._max.createdAt]));

    return {
      data: tenants.map((t) => ({ ...t, lastActiveAt: lastActiveAt.get(t.id) ?? null })),
      statusCounts: countBy(statusCounts, 'status'),
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
    if (!request.tenant) {
      throw new AppError('No tenant selected', 400);
    }

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
    const { id } = request.params as { id: string };

    // Tenant users can only view their own tenant
    if (!isPlatformUser(request.user.userType) && request.user.tenantId !== id) {
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
          logoUrl: { type: ['string', 'null'] },
          primaryColor: { type: 'string' },
          loginTitle: { type: ['string', 'null'] },
          loginSubtitle: { type: ['string', 'null'] },
          plan: { type: 'string', enum: ['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE'] },
          status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'TRIAL'] },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = updateTenantSchema.parse(request.body);

    // Platform admins can update any tenant. Tenant admins can update their own
    // tenant's name and branding; plan and status (billing/suspension) are platform-only.
    const { userType, tenantId } = request.user;
    if (!isPlatformAdmin(userType)) {
      const ownTenantProfileOnly =
        isTenantAdmin(userType) && tenantId === id && data.plan === undefined && data.status === undefined;
      if (!ownTenantProfileOnly) {
        throw new AppError('Platform admin access required', 403);
      }
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
    const { id } = request.params as { id: string };

    // Deleting a tenant cascades to all its data: platform admins only
    if (!isPlatformAdmin(request.user.userType)) {
      throw new AppError('Platform admin access required', 403);
    }

    await prisma.tenant.delete({
      where: { id },
    });

    return reply.status(204).send();
  });
};
