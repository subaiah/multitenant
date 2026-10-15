import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { config } from '../config/env.js';
import { deprovisionTenant, startProvisioning } from '../lib/provisioning.js';
import { RESERVED_ROLE_SLUGS, roleNameFor } from '../lib/tenant-targets.js';
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
  // Where its data lives; fixed once created
  strategy: z.enum(['SHARED_TABLES', 'SCHEMA_PER_TENANT', 'DATABASE_PER_TENANT']).default(config.defaultTenantStrategy),
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

/** Control-plane rows for a tenant as the API returns them: usage snapshot and where its data lives. */
const tenantInclude = {
  usage: { select: { users: true, applications: true, lastActiveAt: true, refreshedAt: true } },
  databaseConfig: { select: { strategy: true, lastMigration: true, migratedAt: true, migrationError: true } },
} as const;

type TenantRow = Awaited<ReturnType<typeof controlDb.tenant.findMany<{ include: typeof tenantInclude }>>>[number];

function present(t: TenantRow) {
  const { usage, databaseConfig, initialAdminEmail, initialAdminName, ...tenant } = t;
  return {
    ...tenant,
    isolation: databaseConfig?.strategy ?? null,
    migration: databaseConfig ? { last: databaseConfig.lastMigration, at: databaseConfig.migratedAt, error: databaseConfig.migrationError } : null,
    // Snapshot from the periodic usage job (lib/tenant-usage.ts); may lag a few minutes
    _count: { users: usage?.users ?? 0, applications: usage?.applications ?? 0 },
    lastActiveAt: usage?.lastActiveAt ?? null,
    usageRefreshedAt: usage?.refreshedAt ?? null,
  };
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
          strategy: { type: 'string', enum: ['SHARED_TABLES', 'SCHEMA_PER_TENANT', 'DATABASE_PER_TENANT'] },
          adminEmail: { type: 'string' },
          adminName: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const data = createTenantSchema.parse(request.body);
    if (isPlatformSlug(data.slug) || RESERVED_ROLE_SLUGS.includes(data.slug)) {
      throw new AppError('That address is reserved', 409);
    }
    if (await controlDb.tenant.findUnique({ where: { slug: data.slug } })) {
      throw new AppError(`The address "${data.slug}" is already taken`, 409);
    }

    // The tenant's database role (and its schema or database) is named from the slug
    if (await controlDb.databaseConfig.findUnique({ where: { dbRoleName: roleNameFor(data.slug) } })) {
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
        provisioningStatus: 'PENDING',
        initialAdminEmail: data.adminEmail,
        initialAdminName: data.adminName,
        createdById: request.user.userId,
        databaseConfig: {
          create: { strategy: data.strategy, provider: 'POSTGRESQL', region: 'default', storageLimit: '5 GB', tenantColumn: 'tenant_id' },
        },
      },
      include: tenantInclude,
    });
    await logPlatformActivity({
      tenantId: tenant.id,
      userId: request.user.userId,
      action: 'created tenant',
      target: `${tenant.name} (${tenant.slug})`,
      type: 'CONFIG',
      metadata: { isolation: data.strategy, firstAdmin: data.adminEmail },
    });

    // Provisioning runs in the background: database role, schema or database,
    // tables, row-level security, defaults, then the first admin's invitation.
    // The Tenants page follows its progress.
    void startProvisioning(tenant.id);

    return reply.status(202).send({ ...present(tenant), adminInvited: data.adminEmail });
  });

  // Retry provisioning a tenant that failed
  fastify.post('/:id/provision', {
    config: { permission: 'tenants:manage' },
    schema: {
      tags: ['tenants'],
      summary: 'Retry provisioning a tenant',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenant = await controlDb.tenant.findUnique({ where: { id } });
    if (!tenant) throw new AppError('Tenant not found', 404);
    if (tenant.provisioningStatus === 'READY') throw new AppError('This tenant is already set up', 409);
    if (tenant.provisioningStatus === 'DEPROVISIONING') throw new AppError('This tenant is being deleted', 409);
    await logPlatformActivity({ tenantId: id, userId: request.user.userId, action: 'retried provisioning', target: tenant.slug, type: 'CONFIG' });
    void startProvisioning(id);
    return reply.status(202).send({ id, provisioningStatus: 'PROVISIONING' });
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
        include: tenantInclude,
      }),
      controlDb.tenant.count({ where }),
      // Counts for the status tabs: same plan/search filters, any status
      controlDb.tenant.groupBy({ by: ['status'], where: { AND: [plan ? { plan } : {}, searchFilter] }, _count: true }),
    ]);

    return {
      data: tenants.map(present),
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

    return present(await controlDb.tenant.findUniqueOrThrow({ where: { id: request.tenant.id }, include: tenantInclude }));
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

    const tenant = await controlDb.tenant.findUnique({ where: { id }, include: tenantInclude });
    if (!tenant) {
      throw new AppError('Tenant not found', 404);
    }

    return present(tenant);
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

    // In the tenant's own log once it has one; the platform log before that
    const entry = { tenantId: id, userId: request.user.userId, action: 'updated tenant', target: tenant.name, type: 'CONFIG' as const, metadata: data };
    await (tenant.provisioningStatus === 'READY' ? logActivity(entry) : logPlatformActivity(entry));

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

    // Drops its schema or database (or deletes its rows from the shared
    // tables) and its database role, then its control-plane rows
    try {
      await deprovisionTenant(id, request.user.userId);
    } catch (err) {
      request.log.error({ err, tenantId: id }, 'Deleting tenant failed');
      throw new AppError('Deleting the tenant failed. The error is shown on the tenant; deleting again retries.', 500);
    }

    return reply.status(204).send();
  });
};
