/**
 * An application's limits by plan, and its usage (platform staff;
 * docs/hub/HUB_GAPS.md G6). The application declares its limits (manifest v2
 * limits); staff set each plan's value here, and organizations that have it
 * on are told their new limits (lib/product-limits.ts).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { AppError } from '../middleware/error-handler.js';
import { scheduleLimitsCheck, type LimitValue } from '../lib/product-limits.js';
import { monthOf, usageTotals } from '../lib/product-usage.js';
import { PLAN_CODES, type PlanCode } from '../lib/billing/plans.js';

const params = z.object({ id: z.string().uuid() });
const v = (json: unknown): LimitValue => {
  const x = (json as { v?: unknown } | null)?.v;
  return typeof x === 'number' || typeof x === 'boolean' ? x : null;
};

export const applicationLimitRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/:id/limits', {
    config: { permission: 'app-registry:manage' },
    schema: { tags: ['applications'], summary: 'The application’s limits, with each plan’s value' },
  }, async (request) => {
    const { id } = params.parse(request.params);
    const [limits, plans] = await Promise.all([
      controlDb.productLimit.findMany({ where: { applicationId: id, retiredAt: null }, include: { planValues: true }, orderBy: { position: 'asc' } }),
      controlDb.billingPlan.findMany({ select: { code: true, name: true }, orderBy: { sortOrder: 'asc' } }),
    ]);
    return {
      plans: plans.length ? plans : PLAN_CODES.map((code) => ({ code, name: code })),
      limits: limits.map((l) => ({
        key: l.key, label: l.label, type: l.type, unlimited: l.unlimited, unit: l.unit, default: v(l.defaultValue),
        /** Only the plans that set their own; the others get the default */
        values: Object.fromEntries(l.planValues.map((p) => [p.planCode, v(p.value)])),
      })),
    };
  });

  // One limit's values: a plan left out gets the default
  fastify.put('/:id/limits/:key', {
    config: { permission: 'app-registry:manage' },
    schema: { tags: ['applications'], summary: 'Set each plan’s value for one of the application’s limits' },
  }, async (request) => {
    const { id, key } = z.object({ id: z.string().uuid(), key: z.string().max(100) }).parse(request.params);
    const body = z.object({ values: z.partialRecord(z.enum(PLAN_CODES as [PlanCode, ...PlanCode[]]), z.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.boolean(), z.null()])) }).parse(request.body);
    const limit = await controlDb.productLimit.findFirst({ where: { applicationId: id, key, retiredAt: null }, include: { application: { select: { name: true } }, planValues: true } });
    if (!limit) throw new AppError('No such limit for this application', 404);
    for (const [plan, value] of Object.entries(body.values)) {
      const ok = limit.type === 'boolean' ? typeof value === 'boolean' : typeof value === 'number' || (value === null && limit.unlimited);
      if (!ok) {
        throw new AppError(limit.type === 'boolean' ? `${plan}: on or off (true or false)` : `${plan}: a whole number${limit.unlimited ? ', or no limit' : ''}`, 400, true, 'INVALID_LIMIT');
      }
    }
    const before = Object.fromEntries(limit.planValues.map((p) => [p.planCode, v(p.value)]));
    await controlDb.$transaction(async (tx) => {
      await tx.productPlanLimit.deleteMany({ where: { limitId: limit.id, planCode: { notIn: Object.keys(body.values) as PlanCode[] } } });
      for (const [plan, value] of Object.entries(body.values)) {
        await tx.productPlanLimit.upsert({
          where: { limitId_planCode: { limitId: limit.id, planCode: plan as PlanCode } },
          create: { limitId: limit.id, planCode: plan as PlanCode, value: { v: value } },
          update: { value: { v: value } },
        });
      }
    });
    await audit(request, 'application.plan_limits_changed', {
      resource: { type: 'application', id, label: limit.application.name },
      changes: { values: [before, body.values] },
      details: { limit: key },
    });
    scheduleLimitsCheck({ applicationId: id });
    return { key, values: body.values };
  });

  // Usage reported for a month, per organization and meter
  fastify.get('/:id/usage', {
    config: { permission: 'app-registry:manage' },
    schema: { tags: ['applications'], summary: 'Usage the application reported in a month, per organization' },
  }, async (request) => {
    const { id } = params.parse(request.params);
    const { month } = z.object({ month: z.string().optional() }).parse(request.query);
    const period = monthOf(month);
    const [meters, totals] = await Promise.all([
      controlDb.productUsageMeter.findMany({ where: { applicationId: id }, orderBy: { position: 'asc' } }),
      usageTotals({ applicationId: id }, period.from, period.to),
    ]);
    const tenants = new Map((await controlDb.tenant.findMany({ where: { id: { in: [...new Set(totals.map((t) => t.tenantId))] } }, select: { id: true, name: true, slug: true } })).map((t) => [t.id, t]));
    const byTenant = new Map<string, Record<string, number>>();
    for (const t of totals) byTenant.set(t.tenantId, { ...(byTenant.get(t.tenantId) ?? {}), [t.key]: t.total });
    return {
      month: period.month,
      meters: meters.map((m) => ({ key: m.key, label: m.label, unit: m.unit, retired: !!m.retiredAt, total: totals.filter((t) => t.key === m.key).reduce((n, t) => n + t.total, 0) })),
      organizations: [...byTenant.entries()]
        .map(([tenantId, used]) => ({ id: tenantId, name: tenants.get(tenantId)?.name ?? tenantId, slug: tenants.get(tenantId)?.slug ?? null, used }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
};
