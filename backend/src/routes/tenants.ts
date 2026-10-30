import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { config } from '../config/env.js';
import { deprovisionTenant, rotateTenantCredentials, startProvisioning } from '../lib/provisioning.js';
import { createTenantRecord, slugSchema, trialEnd } from '../lib/new-tenant.js';
import { latestMigration, tenantsBehind } from '../lib/tenant-migrations.js';
import { isPlatformSlug } from '../lib/platform.js';
import { AppError } from '../middleware/error-handler.js';
import { countBy } from '../lib/stats.js';
import { isPlatformAdmin, isPlatformUser, isTenantAdmin } from '../utils/authorization.js';
import { AUTHENTICATED } from '../middleware/authorize.js';
import { hasPermission, requirePermission } from '../middleware/authorize.js';
import { logActivity, logPlatformActivity } from '../lib/activity.js';
import { audit, diff } from '../lib/audit.js';
import { dbForTenant } from '../lib/tenant-db.js';
import { sendInvitation } from '../lib/invitations.js';
import { limitSchema, pageSchema } from '../lib/pagination.js';

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
  // When a trial ends (null: no end); read-only after it
  trialEndsAt: z.coerce.date().nullable().optional(),
});

const createTenantSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: slugSchema,
  plan: z.enum(['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE']).default('FREE'),
  status: z.enum(['ACTIVE', 'TRIAL']).default('ACTIVE'),
  // Where its data lives; fixed once created
  strategy: z.enum(['SHARED_TABLES', 'SCHEMA_PER_TENANT', 'DATABASE_PER_TENANT']).default(config.defaultTenantStrategy),
  adminEmail: z.string().trim().toLowerCase().email(),
  adminName: z.string().trim().min(2).max(100),
});

const querySchema = z.object({
  page: pageSchema.default(1),
  limit: limitSchema(10),
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
  const latest = latestMigration();
  return {
    ...tenant,
    // Who the first administrator's invitation went to (shown when it needs resending)
    firstAdminEmail: initialAdminEmail ?? null,
    isolation: databaseConfig?.strategy ?? null,
    migration: databaseConfig
      ? {
          last: databaseConfig.lastMigration,
          at: databaseConfig.migratedAt,
          error: databaseConfig.migrationError,
          // On an older schema than this server's newest migration
          behind: t.provisioningStatus === 'READY' && !!latest && databaseConfig.lastMigration !== latest,
        }
      : null,
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
    const created = await createTenantRecord({ ...data, createdById: request.user.userId });
    const tenant = await controlDb.tenant.findUniqueOrThrow({ where: { id: created.id }, include: tenantInclude });
    await logPlatformActivity({
      tenantId: tenant.id,
      userId: request.user.userId,
      action: 'created tenant',
      target: `${tenant.name} (${tenant.slug})`,
      type: 'CONFIG',
      metadata: { isolation: data.strategy, firstAdmin: data.adminEmail },
    });
await audit(request, 'tenant.created', { tenantId: tenant.id, resource: { type: 'tenant', id: tenant.id, label: tenant.slug }, details: { name: tenant.name, plan: tenant.plan, isolation: data.strategy, firstAdmin: data.adminEmail } });

    // Provisioning runs in the background: database role, schema or database,
    // tables, row-level security, defaults, then the first admin's invitation.
    // The Tenants page follows its progress.
    void startProvisioning(tenant.id);

    return reply.status(202).send({ ...present(tenant), adminInvited: data.adminEmail });
  });

  // New password for the tenant's database role
  fastify.post('/:id/rotate-credentials', {
    config: { permission: 'tenants:manage' },
    schema: {
      tags: ['tenants'],
      summary: "Rotate the tenant's database credentials",
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    if (!(await controlDb.tenant.findUnique({ where: { id }, select: { id: true } }))) throw new AppError('Tenant not found', 404);
    await rotateTenantCredentials(id, request.user.userId);
    return { message: 'Database credentials rotated' };
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
    // Pending until the job picks it up, so nobody reads the old failure as the outcome
    await controlDb.tenant.update({ where: { id }, data: { provisioningStatus: 'PENDING', provisioningError: null } });
    await logPlatformActivity({ tenantId: id, userId: request.user.userId, action: 'retried provisioning', target: tenant.slug, type: 'CONFIG' });
    await audit(request, 'tenant.provisioning_retried', { tenantId: id, resource: { type: 'tenant', id, label: tenant.slug } });
    void startProvisioning(id);
    return reply.status(202).send({ id, provisioningStatus: 'PROVISIONING' });
  });

  // The first administrator's invitation again: after its email failed, or expired
  fastify.post('/:id/resend-invite', {
    config: { permission: 'tenants:manage' },
    schema: {
      tags: ['tenants'],
      summary: "Invite the tenant's first administrator again (a new link; the old one stops working)",
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const tenant = await controlDb.tenant.findUnique({ where: { id } });
    if (!tenant) throw new AppError('Tenant not found', 404);
    if (tenant.provisioningStatus !== 'READY') throw new AppError('This tenant is not set up yet', 409);
    if (!tenant.initialAdminEmail) throw new AppError('This tenant has no first administrator to invite', 409);
    const admin = await (await dbForTenant(id)).user.findFirst({
      where: { tenantId: id, email: tenant.initialAdminEmail },
      select: { id: true, email: true, status: true },
    });
    if (!admin) throw new AppError('The first administrator is no longer a user of this tenant', 409);
    if (admin.status !== 'PENDING') throw new AppError(`${admin.email} has already accepted the invitation`, 409);

    const invite = await sendInvitation(tenant, admin, request.user.userId);
    await controlDb.tenant.update({ where: { id }, data: { adminInvitedAt: new Date(), adminInviteError: invite.sent ? null : (invite.error ?? 'The email could not be sent') } });
    await audit(request, 'tenant.invitation_resent', { tenantId: id, resource: { type: 'tenant', id, label: tenant.slug }, details: { to: admin.email, emailed: invite.sent } });
    // The link only when the email didn't go out, to share another way
    return invite.sent
      ? { invitationSent: true, to: admin.email }
      : { invitationSent: false, to: admin.email, inviteLink: invite.link, emailError: invite.error };
  });

  // Undo an organization's own closure during its grace period
  fastify.post('/:id/restore', {
    config: { permission: 'tenants:manage' },
    schema: {
      tags: ['tenants'],
      summary: 'Restore an organization its admins closed (before it is deleted)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const tenant = await controlDb.tenant.findUnique({ where: { id } });
    if (!tenant) throw new AppError('Tenant not found', 404);
    if (!tenant.closedAt) throw new AppError('This organization was not closed', 409);
    const restored = await controlDb.tenant.update({
      where: { id },
      data: { status: tenant.statusBeforeClose ?? 'ACTIVE', closedAt: null, closedBy: null, deleteAfter: null, statusBeforeClose: null },
    });
    await logPlatformActivity({ tenantId: id, userId: request.user.userId, action: 'restored closed tenant', target: tenant.slug, type: 'CONFIG' });
    await audit(request, 'tenant.restored', { tenantId: id, resource: { type: 'tenant', id, label: tenant.slug }, details: { name: tenant.name, status: restored.status } });
    return restored;
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
      migrations: { latest: latestMigration(), tenantsBehind: await tenantsBehind() },
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
          trialEndsAt: { type: ['string', 'null'] },
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
        isTenantAdmin(userType) && tenantId === id && data.plan === undefined && data.status === undefined && data.trialEndsAt === undefined;
      if (!ownTenantProfileOnly) {
        throw new AppError('Platform admin access required', 403);
      }
    }

    const before = await controlDb.tenant.findUnique({ where: { id } });
    if (!before) throw new AppError('Tenant not found', 404);
    // A paid subscription decides the plan (lib/billing/): changing it here would be undone
    if (data.plan !== undefined && data.plan !== before.plan) {
      const sub = await controlDb.subscription.findUnique({ where: { tenantId: id }, select: { status: true } });
      if (sub && ['ACTIVE', 'PAST_DUE', 'UNPAID'].includes(sub.status)) {
        throw new AppError("This organization pays for its plan through a subscription: it changes its plan on its Billing page", 409, true, 'SUBSCRIBED');
      }
    }
    const extra: Record<string, unknown> = {};
    // Becoming a trial without an end date gets the usual length
    if (data.status === 'TRIAL' && before.status !== 'TRIAL' && data.trialEndsAt === undefined && !before.trialEndsAt) extra.trialEndsAt = trialEnd();
    // A new end date: remind and notify again for it
    if (data.trialEndsAt !== undefined || extra.trialEndsAt) Object.assign(extra, { trialReminderSentAt: null, trialEndedNotifiedAt: null });
    // Any status but suspended cancels a pending closure (it would otherwise be deleted)
    if (data.status && data.status !== 'SUSPENDED' && before.closedAt) Object.assign(extra, { closedAt: null, closedBy: null, deleteAfter: null, statusBeforeClose: null });
    const tenant = await controlDb.tenant.update({
      where: { id },
      data: { ...data, ...extra },
    });

    // In the tenant's own log once it has one; the platform log before that
    const entry = { tenantId: id, userId: request.user.userId, action: 'updated tenant', target: tenant.name, type: 'CONFIG' as const, metadata: data };
    await (tenant.provisioningStatus === 'READY' ? logActivity(entry) : logPlatformActivity(entry));
    // Platform staff in the platform's audit log; the tenant's own admins in the tenant's
    const changes = diff(before, data);
    if (isPlatformUser(userType)) {
      await audit(request, 'tenant.updated', { tenantId: id, resource: { type: 'tenant', id, label: tenant.slug }, changes });
    } else {
      await audit(request, 'tenant_profile.updated', { resource: { type: 'tenant', id, label: tenant.name }, changes });
    }

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
      if (err instanceof AppError) throw err; // e.g. busy: another job is changing this tenant
      request.log.error({ err, tenantId: id }, 'Deleting tenant failed');
      throw new AppError('Deleting the tenant failed. The error is shown on the tenant; deleting again retries.', 500);
    }

    return reply.status(204).send();
  });
};
