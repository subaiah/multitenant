import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { dbForTenant } from '../lib/tenant-db.js';
import { countTenantData, createTenantDefaults, deleteTenantData } from '../lib/tenant-data.js';
import { sendInvitation } from '../lib/invitations.js';
import { isPlatformSlug } from '../lib/platform.js';
import { AppError } from '../middleware/error-handler.js';
import { countBy } from '../lib/stats.js';
import { isPlatformAdmin, isPlatformUser, isTenantAdmin } from '../utils/authorization.js';
import { AUTHENTICATED } from '../middleware/authorize.js';
import { hasPermission, requirePermission } from '../middleware/authorize.js';
import { logActivity, logPlatformActivity } from '../lib/activity.js';

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

const createTenantSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/, 'Use 2-50 lowercase letters, digits and hyphens'),
  plan: z.enum(['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE']).default('FREE'),
  status: z.enum(['ACTIVE', 'TRIAL']).default('ACTIVE'),
  adminEmail: z.string().trim().toLowerCase().email(),
  adminName: z.string().trim().min(2).max(100),
});

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).default(10),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'TRIAL']).optional(),
  plan: z.enum(['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE']).optional(),
  search: z.string().optional(),
});

async function withCounts<T extends { id: string }>(tenant: T | null) {
  if (!tenant) return tenant;
  const c = (await countTenantData([tenant.id])).get(tenant.id)!;
  return { ...tenant, _count: { users: c.users, applications: c.applications } };
}

export const tenantRoutes: FastifyPluginAsync = async (fastify) => {
  // Create a tenant (platform admins only; there is no self sign-up)
  fastify.post('/', {
    config: { permission: 'tenants:manage' },
    schema: {
      tags: ['tenants'],
      summary: 'Create a tenant and invite its first administrator',
      body: {
        type: 'object',
        required: ['name', 'slug', 'adminEmail', 'adminName'],
        properties: {
          name: { type: 'string' },
          slug: { type: 'string' },
          plan: { type: 'string', enum: ['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE'] },
          status: { type: 'string', enum: ['ACTIVE', 'TRIAL'] },
          adminEmail: { type: 'string' },
          adminName: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const data = createTenantSchema.parse(request.body);
    if (isPlatformSlug(data.slug)) {
      throw new AppError('That address is reserved', 409);
    }
    if (await controlDb.tenant.findUnique({ where: { slug: data.slug } })) {
      throw new AppError(`The address "${data.slug}" is already taken`, 409);
    }

    const tenant = await controlDb.tenant.create({
      data: {
        name: data.name,
        slug: data.slug,
        plan: data.plan,
        status: data.status,
        loginTitle: `Welcome to ${data.name}`,
        loginSubtitle: 'Sign in to your account',
        databaseConfig: {
          create: { strategy: 'SHARED_TABLES', provider: 'POSTGRESQL', region: 'default', storageLimit: '5 GB', tenantColumn: 'tenant_id' },
        },
      },
    });

    // Tenant-plane defaults and the first admin. There's no transaction across
    // the two planes, so undo the tenant if this part fails.
    let admin: { id: string; email: string };
    try {
      const db = dbForTenant(tenant.id);
      await createTenantDefaults(tenant.id, db);
      admin = await db.user.create({
        data: { tenantId: tenant.id, email: data.adminEmail, name: data.adminName, userType: 'TENANT_ADMIN', status: 'PENDING' },
        select: { id: true, email: true },
      });
    } catch (err) {
      await deleteTenantData(tenant.id).catch(() => undefined);
      await controlDb.tenant.delete({ where: { id: tenant.id } }).catch(() => undefined);
      throw err;
    }

    await sendInvitation(tenant, admin, request.user.userId);
    await logPlatformActivity({
      tenantId: tenant.id,
      userId: request.user.userId,
      action: 'created tenant',
      target: `${tenant.name} (${tenant.slug})`,
      type: 'CONFIG',
    });
    await logActivity({
      tenantId: tenant.id,
      userId: request.user.userId,
      action: 'invited first administrator',
      target: admin.email,
      type: 'USER',
    });

    return reply.status(201).send({ ...tenant, adminInvited: admin.email });
  });

  // List tenants (admin only)
  fastify.get('/', {
    config: { permission: 'tenants:read' },
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
      controlDb.tenant.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      controlDb.tenant.count({ where }),
      // Counts for the status tabs: same plan/search filters, any status
      controlDb.tenant.groupBy({ by: ['status'], where: { AND: [plan ? { plan } : {}, searchFilter] }, _count: true }),
    ]);

    // Users, apps and last activity live in the tenant plane
    const counts = await countTenantData(tenants.map((t) => t.id));

    return {
      data: tenants.map((t) => {
        const c = counts.get(t.id)!;
        return { ...t, _count: { users: c.users, applications: c.applications }, lastActiveAt: c.lastActiveAt };
      }),
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
    config: { permission: 'tenant:read' },
    schema: {
      tags: ['tenants'],
      summary: 'Get current tenant',
    },
  }, async (request, reply) => {
    if (!request.tenant) {
      throw new AppError('No tenant selected', 400);
    }

    return withCounts(await controlDb.tenant.findUnique({ where: { id: request.tenant.id } }));
  });

  // Get tenant by ID
  fastify.get('/:id', {
    config: { permission: AUTHENTICATED },
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
    if (request.user.tenantId !== id && !(await hasPermission(request, 'tenants:read'))) {
      throw new AppError('Access denied', 403);
    }

    const tenant = await controlDb.tenant.findUnique({ where: { id } });
    if (!tenant) {
      throw new AppError('Tenant not found', 404);
    }

    return withCounts(tenant);
  });

  // Update tenant
  fastify.patch('/:id', {
    config: { permission: ['tenants:manage', 'settings:manage'] },
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
    if (!(await hasPermission(request, 'tenants:manage'))) {
      // Route requires settings:manage otherwise; limit it to the caller's own tenant profile
      const ownTenantProfileOnly =
        isTenantAdmin(userType) && tenantId === id && data.plan === undefined && data.status === undefined;
      if (!ownTenantProfileOnly) {
        throw new AppError('Platform admin access required', 403);
      }
    }

    const tenant = await controlDb.tenant.update({
      where: { id },
      data,
    });

    // Log activity
    await logActivity({
        tenantId: id,
        userId: request.user.userId,
        action: 'updated tenant',
        target: tenant.name,
        type: 'CONFIG',
        metadata: data,
      });

    return tenant;
  });

  // Delete tenant
  fastify.delete('/:id', {
    config: { permission: 'tenants:manage' },
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

    const tenant = await controlDb.tenant.findUnique({ where: { id } });
    if (!tenant) {
      throw new AppError('Tenant not found', 404);
    }

    // The tenant plane has no foreign keys to tenants: delete its data first,
    // then the tenant's control-plane rows (explicitly, not relying on cascades)
    await deleteTenantData(id);
    await controlDb.$transaction([
      controlDb.supportSession.deleteMany({ where: { tenantId: id } }),
      controlDb.tenantApplication.deleteMany({ where: { tenantId: id } }),
      controlDb.databaseConfig.deleteMany({ where: { tenantId: id } }),
      controlDb.tenant.delete({ where: { id } }),
    ]);

    await logPlatformActivity({
      tenantId: id,
      userId: request.user.userId,
      action: 'deleted tenant',
      target: `${tenant.name} (${tenant.slug})`,
      type: 'CONFIG',
    });

    return reply.status(204).send();
  });
};
