import { FastifyPluginAsync } from 'fastify';
import { monthOf, usageTotals } from '../lib/product-usage.js';
import { organizationEventFlows } from '../lib/product-events.js';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { CATALOGUE_FIELDS, dataAccessOf } from '../lib/application-fields.js';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType } from '../utils/authorization.js';
import { logActivity } from '../lib/activity.js';
import { audit } from '../lib/audit.js';
import { organizationConnections, setConnectionBlocked } from '../lib/app-connections.js';
import { assertCanTurnOff, assertCanTurnOn, dependenciesOf, isOn, lockEntitlements } from '../lib/app-dependencies.js';
import { pageOf } from '../lib/pagination.js';
import { issuer } from '../lib/oidc/provider.js';
import { forgetApplicationPermissions } from '../lib/application-permissions.js';
import { entitlementChanged, kickLifecycleEvents } from '../lib/product-lifecycle.js';

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
  // A change to entitlements changes which application permissions roles may hold
  fastify.addHook('onResponse', async (request) => {
    if (request.method !== 'GET') forgetApplicationPermissions(request.tenant?.id);
  });

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
      applications: rows.map(({ application: a, state, validTo, provisioningStatus, provisioningError }) => {
        // Not until the application has set the organization up (lib/product-lifecycle.ts)
        const ready = provisioningStatus === 'READY' || provisioningStatus === 'NOT_REQUIRED';
        const signIn = a.signIn?.enabled ? a.signIn : null;
        let openUrl: string | null = null;
        if (ready && signIn?.initiateLoginUri) {
          const u = new URL(signIn.initiateLoginUri);
          u.searchParams.set('iss', issuer());
          openUrl = u.href;
        }
        return {
          id: a.id, key: a.key, name: a.name, description: a.description, state, validTo, signIn: !!signIn, openUrl,
          setup: ready ? 'READY' : provisioningStatus, ...(provisioningStatus === 'FAILED' && { setupError: provisioningError }),
        };
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
              healthStatus: true,
              healthChangedAt: true,
              _count: {
                select: { permissions: true },
              },
            },
          },
        },
      }),
      controlDb.tenantApplication.count({ where }),
    ]);
    
    // What each can learn about the organization's people (lib/application-fields.ts)
    const access = await dataAccessOf(tenantApplications.map((t) => t.applicationId));
    const deps = await dependenciesOf(tenantApplications.map((t) => t.applicationId));
    const plans = await planAndUsageOf(request.tenant.id, tenantApplications.map((t) => t.applicationId));
    return {
      tenantApplications: tenantApplications.map(({ application: { healthStatus, healthChangedAt, ...application }, ...t }) => ({ ...t, application: { ...application,
        // Having problems right now (lib/product-health.ts): no details
        health: healthStatus === 'DOWN' || healthStatus === 'DEGRADED' ? { problem: healthStatus === 'DOWN' ? 'down' : 'degraded', since: healthChangedAt } : null,
        dataAccess: access.get(t.applicationId), ...deps.get(t.applicationId), ...plans.get(t.applicationId) } })),
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
        // Explicit fields (lib/application-fields.ts)
        application: { select: { ...CATALOGUE_FIELDS, permissions: true } },
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
    
    // With the product told, if it takes lifecycle events (lib/product-lifecycle.ts)
    const tenantApplication = await controlDb.$transaction(async (tx) => {
      // What it requires must be on already (lib/app-dependencies.ts)
      await lockEntitlements(tx, tenantId);
      if (isOn({ state: data.state, validTo: data.validTo ? new Date(data.validTo) : null })) await assertCanTurnOn(tx, tenantId, [data.applicationId]);
      const created = await tx.tenantApplication.create({
        data: {
          tenantId,
          applicationId: data.applicationId,
          state: data.state,
          validFrom: data.validFrom ? new Date(data.validFrom) : new Date(),
          validTo: data.validTo ? new Date(data.validTo) : null,
        },
      });
      await entitlementChanged(tx, null, created);
      return tx.tenantApplication.findUniqueOrThrow({ where: { id: created.id } });
    });
    kickLifecycleEvents();
    
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
    
    const tenantApplication = await controlDb.$transaction(async (tx) => {
      await lockEntitlements(tx, tenantId);
      const before = await tx.tenantApplication.findFirst({ where: { id, tenantId } });
      if (!before) throw new AppError('Entitlement not found', 404);
      // Turning on needs what it requires; turning off, nothing on that requires it (lib/app-dependencies.ts)
      const after = { state: data.state ?? before.state, validTo: data.validTo ? new Date(data.validTo) : before.validTo };
      if (!isOn(before) && isOn(after)) await assertCanTurnOn(tx, tenantId, [before.applicationId]);
      if (isOn(before) && !isOn(after)) await assertCanTurnOff(tx, tenantId, [before.applicationId]);
      const updated = await tx.tenantApplication.update({
        where: { id, tenantId },
        data: {
          ...data,
          validFrom: data.validFrom ? new Date(data.validFrom) : undefined,
          validTo: data.validTo ? new Date(data.validTo) : undefined,
        },
      });
      await entitlementChanged(tx, before, updated);
      return tx.tenantApplication.findUniqueOrThrow({ where: { id }, include: { application: { select: { name: true } } } });
    });
    kickLifecycleEvents();
    
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
    
    
    const tenantApplication = await controlDb.$transaction(async (tx) => {
      await lockEntitlements(tx, tenantId);
      const before = await tx.tenantApplication.findFirst({ where: { id, tenantId } });
      if (!before) throw new AppError('Entitlement not found', 404);
      if (isOn(before)) await assertCanTurnOff(tx, tenantId, [before.applicationId]);
      const removed = await tx.tenantApplication.delete({ where: { id, tenantId }, include: { application: { select: { name: true } } } });
      await entitlementChanged(tx, removed, null);
      return removed;
    });
    kickLifecycleEvents();
    
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

  // ---------------------------------------------------------------------------
  // Applications calling each other (docs/adr/0001-app-to-app-calls.md):
  // allowed between applications the organization has on, unless blocked here
  // ---------------------------------------------------------------------------

  // Events between applications (docs/hub/HUB_GAPS.md G4): who publishes what, and who receives it here
  fastify.get('/events', {
    config: { permission: 'applications:read' },
    schema: { tags: ['tenant-applications'], summary: 'The events the organization’s applications publish, and which applications and webhook endpoints receive each' },
  }, async (request) => organizationEventFlows(request.tenant.id));

  fastify.get('/connections', {
    config: { permission: 'applications:read' },
    schema: { tags: ['tenant-applications'], summary: 'Which of the organization’s applications can call which, with what, and whether it’s blocked' },
  }, async (request) => ({ connections: await organizationConnections(request.tenant.id) }));

  fastify.put('/connections', {
    config: { permission: 'applications:manage' },
    schema: { tags: ['tenant-applications'], summary: 'Block or allow one application calling another' },
  }, async (request) => {
    const body = z.object({ callerApplicationId: z.string().uuid(), targetApplicationId: z.string().uuid(), blocked: z.boolean() }).parse(request.body);
    const tenantId = request.tenant.id;
    const connection = (await organizationConnections(tenantId)).find((c) => c.caller.id === body.callerApplicationId && c.target.id === body.targetApplicationId);
    if (!connection) throw new AppError('No such connection between applications this organization has on', 404);
    const who = request.user ? await request.db.user.findFirst({ where: { id: request.user.userId, tenantId }, select: { email: true } }) : null;
    const changed = await setConnectionBlocked(tenantId, body.callerApplicationId, body.targetApplicationId, body.blocked, who?.email ?? null);
    if (changed) {
      await audit(request, body.blocked ? 'app_connection.blocked' : 'app_connection.allowed', {
        resource: { type: 'app_connection', id: `${connection.caller.key}->${connection.target.key}`, label: `${connection.caller.name} → ${connection.target.name}` },
        details: { caller: connection.caller.key, target: connection.target.key, scopes: connection.scopes.map((sc) => sc.name) },
      });
    }
    return { blocked: body.blocked, changed };
  });

  // ---------------------------------------------------------------------------
  // Bundles: named sets of applications turned on together (platform-defined)
  // ---------------------------------------------------------------------------

  fastify.get('/bundles', {
    config: { permission: 'applications:read' },
    schema: { tags: ['tenant-applications'], summary: 'Bundles the organization can turn on, and which of their applications it has on' },
  }, async (request) => {
    const tenantId = request.tenant.id;
    const bundles = await controlDb.bundle.findMany({
      where: { active: true },
      include: { applications: { orderBy: { position: 'asc' }, include: { application: { select: { id: true, key: true, name: true, status: true } } } } },
      orderBy: { name: 'asc' },
    });
    const on = new Set((await controlDb.tenantApplication.findMany({ where: { tenantId } })).filter((e) => isOn(e)).map((e) => e.applicationId));
    return {
      bundles: bundles.map((b) => ({
        id: b.id, key: b.key, name: b.name, description: b.description,
        applications: b.applications.map((x) => ({ ...x.application, on: on.has(x.application.id) })),
      })),
    };
  });

  fastify.post('/bundles/:bundleId', {
    config: { permission: 'applications:manage' },
    schema: { tags: ['tenant-applications'], summary: 'Turn on every application in a bundle the organization doesn’t have on yet', params: { type: 'object', required: ['bundleId'], properties: { bundleId: { type: 'string', format: 'uuid' } } } },
  }, async (request, reply) => {
    const { bundleId } = request.params as { bundleId: string };
    const tenantId = request.tenant.id;
    const bundle = await controlDb.bundle.findFirst({
      where: { id: bundleId, active: true },
      include: { applications: { orderBy: { position: 'asc' }, include: { application: { select: { id: true, name: true, status: true } } } } },
    });
    if (!bundle) throw new AppError('Bundle not found', 404);
    const unavailable = bundle.applications.filter((x) => x.application.status !== 'ACTIVE').map((x) => x.application.name);
    if (unavailable.length) throw new AppError(`Not available now: ${unavailable.join(', ')}`, 409, true, 'BUNDLE_UNAVAILABLE');

    const turnedOn = await controlDb.$transaction(async (tx) => {
      await lockEntitlements(tx, tenantId);
      const existing = new Map((await tx.tenantApplication.findMany({ where: { tenantId, applicationId: { in: bundle.applications.map((x) => x.applicationId) } } })).map((e) => [e.applicationId, e]));
      const toTurnOn = bundle.applications.filter((x) => !isOn(existing.get(x.applicationId)));
      // Together: an application in the bundle may need another in it
      await assertCanTurnOn(tx, tenantId, toTurnOn.map((x) => x.applicationId));
      const done: { id: string; name: string }[] = [];
      for (const x of toTurnOn) {
        const before = existing.get(x.applicationId) ?? null;
        const after = before
          ? await tx.tenantApplication.update({ where: { id: before.id }, data: { state: 'ENABLED', validTo: null } })
          : await tx.tenantApplication.create({ data: { tenantId, applicationId: x.applicationId, state: 'ENABLED', validFrom: new Date() } });
        await entitlementChanged(tx, before, after);
        done.push({ id: x.applicationId, name: x.application.name });
      }
      return done;
    });
    kickLifecycleEvents();
    for (const app of turnedOn) {
      await audit(request, 'entitlement.updated', { resource: { type: 'application', id: app.id, label: app.name }, changes: { enabled: [false, true] }, details: { bundle: bundle.key } });
    }
    return reply.status(turnedOn.length ? 201 : 200).send({
      bundle: { id: bundle.id, name: bundle.name },
      turnedOn: turnedOn.map((a) => a.name),
      alreadyOn: bundle.applications.filter((x) => !turnedOn.some((t) => t.id === x.applicationId)).map((x) => x.application.name),
    });
  });
};

/** For administrators: each application's limits on the organization's plan, and its usage this month (G6) */
async function planAndUsageOf(tenantId: string, applicationIds: string[]) {
  const ids = [...new Set(applicationIds)];
  const tenant = await controlDb.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  const period = monthOf();
  const [limits, meters, totals] = await Promise.all([
    controlDb.productLimit.findMany({ where: { applicationId: { in: ids }, retiredAt: null }, include: { planValues: { where: { planCode: tenant?.plan ?? 'FREE' } } }, orderBy: { position: 'asc' } }),
    controlDb.productUsageMeter.findMany({ where: { applicationId: { in: ids }, retiredAt: null }, orderBy: { position: 'asc' } }),
    usageTotals({ tenantId }, period.from, period.to),
  ]);
  const val = (j: unknown) => { const x = (j as { v?: unknown } | null)?.v; return typeof x === 'number' || typeof x === 'boolean' ? x : null; };
  const out = new Map<string, { limits: unknown[]; usage: { month: string; meters: unknown[] } }>();
  for (const id of ids) {
    out.set(id, {
      limits: limits.filter((l) => l.applicationId === id).map((l) => ({ key: l.key, label: l.label, type: l.type, unit: l.unit, value: l.planValues[0] ? val(l.planValues[0].value) : val(l.defaultValue) })),
      usage: {
        month: period.month,
        meters: meters.filter((m) => m.applicationId === id).map((m) => ({ key: m.key, label: m.label, unit: m.unit, total: totals.find((t) => t.applicationId === id && t.key === m.key)?.total ?? 0 })),
      },
    });
  }
  return out;
}
