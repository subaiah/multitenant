/**
 * Plans and billing for platform staff (Platform → Plans and billing).
 *
 *   GET    /platform/billing/plans                     plans, prices, how many organizations are on each
 *   PUT    /platform/billing/plans/:code               a plan's name, limits and features
 *   POST   /platform/billing/plans/:code/prices        a new per-seat price (made at the provider)
 *   DELETE /platform/billing/plans/:code/prices/:id    stop offering a price (subscriptions on it continue)
 *   GET    /platform/billing/subscriptions             organizations' subscriptions
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env.js';
import { controlDb } from '../lib/prisma.js';
import { audit, diff } from '../lib/audit.js';
import { AppError } from '../middleware/error-handler.js';
import { forgetPlans, PLAN_CODES, type PlanCode } from '../lib/billing/plans.js';
import { enabledProviders, providerForCurrency } from '../lib/billing/providers.js';
import { setPrice } from '../lib/billing/subscriptions.js';

const codeParam = z.object({ code: z.enum(PLAN_CODES as [PlanCode, ...PlanCode[]]) });
const limit = z.number().int().min(0).max(1_000_000).nullable();

async function actorOf(request: FastifyRequest) {
  const u = await controlDb.platformUser.findUnique({ where: { id: request.user.userId }, select: { email: true } });
  return { id: request.user.userId, email: u?.email ?? null, type: 'PLATFORM' as const };
}

export const platformBillingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/plans', {
    config: { permission: 'plans:read' },
    schema: { tags: ['platform-billing'], summary: 'Plans with their limits, prices and how many organizations are on each' },
  }, async () => {
    const [plans, onPlan, subscribed] = await Promise.all([
      controlDb.billingPlan.findMany({ orderBy: { sortOrder: 'asc' }, include: { prices: { orderBy: [{ active: 'desc' }, { createdAt: 'desc' }] } } }),
      controlDb.tenant.groupBy({ by: ['plan'], _count: { _all: true } }),
      controlDb.subscription.groupBy({ by: ['planCode'], where: { status: { in: ['ACTIVE', 'PAST_DUE', 'UNPAID'] } }, _count: { _all: true } }),
    ]);
    return {
      providers: enabledProviders(),
      graceDays: config.billing.graceDays,
      plans: plans.map((p) => ({
        ...p,
        organizations: onPlan.find((x) => x.plan === p.code)?._count._all ?? 0,
        subscriptions: subscribed.find((x) => x.planCode === p.code)?._count._all ?? 0,
        prices: p.prices.map((x) => ({ id: x.id, provider: x.provider, currency: x.currency, interval: x.interval, unitAmount: x.unitAmount, active: x.active, providerPriceId: x.providerPriceId, createdAt: x.createdAt })),
      })),
    };
  });

  fastify.put('/plans/:code', {
    config: { permission: 'plans:manage' },
    schema: { tags: ['platform-billing'], summary: "Change a plan's name, limits and features" },
  }, async (request) => {
    const { code } = codeParam.parse(request.params);
    const body = z.object({
      name: z.string().trim().min(1).max(60),
      description: z.string().trim().max(300).nullable().optional(),
      public: z.boolean(),
      sortOrder: z.number().int().min(0).max(1000).optional(),
      maxUsers: limit,
      maxOrganizations: limit,
      maxGroups: limit,
      allowSso: z.boolean(),
      allowCustomDomain: z.boolean(),
    }).parse(request.body);
    if (code === 'FREE' && body.maxUsers === 0) throw new AppError('The Free plan must allow at least one user', 400);
    const before = await controlDb.billingPlan.findUniqueOrThrow({ where: { code } });
    const plan = await controlDb.billingPlan.update({ where: { code }, data: body });
    forgetPlans();
    const changes = diff(before as unknown as Record<string, unknown>, body as Record<string, unknown>);
    if (Object.keys(changes).length) await audit(request, 'billing.plan_updated', { resource: { type: 'billing_plan', id: code, label: plan.name }, changes });
    return plan;
  });

  fastify.post('/plans/:code/prices', {
    config: { permission: 'plans:manage', rateLimit: { max: 30, timeWindow: '10 minutes' } },
    schema: { tags: ['platform-billing'], summary: 'Set a per-seat price for a currency and interval (replaces the current one for new subscriptions)' },
  }, async (request, reply) => {
    const { code } = codeParam.parse(request.params);
    if (code === 'FREE') throw new AppError('The Free plan has no price', 400);
    const body = z.object({
      currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'A three-letter currency code, like INR or USD'),
      interval: z.enum(['MONTH', 'YEAR']),
      // Smallest unit: paise, cents. At least 1.00 (both providers have minimums around there)
      unitAmount: z.number().int().min(100).max(100_000_000),
    }).parse(request.body);
    const name = providerForCurrency(body.currency);
    if (!enabledProviders().includes(name)) {
      throw new AppError(`${body.currency.toUpperCase() === 'INR' ? 'Razorpay' : 'Stripe'} isn't set up, so prices in ${body.currency.toUpperCase()} can't be made (docs/BILLING.md)`, 400, true, 'BILLING_OFF');
    }
    const price = await setPrice(code, body, await actorOf(request));
    return reply.status(201).send(price);
  });

  fastify.delete('/plans/:code/prices/:id', {
    config: { permission: 'plans:manage' },
    schema: { tags: ['platform-billing'], summary: 'Stop offering a price (existing subscriptions keep it)' },
  }, async (request, reply) => {
    const { code } = codeParam.parse(request.params);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const updated = await controlDb.billingPrice.updateMany({ where: { id, planCode: code, active: true }, data: { active: false } });
    if (!updated.count) throw new AppError('Price not found', 404);
    await audit(request, 'billing.price_set', { resource: { type: 'billing_plan', id: code, label: code }, details: { retired: id } });
    return reply.status(204).send();
  });

  fastify.get('/subscriptions', {
    config: { permission: 'plans:read' },
    schema: { tags: ['platform-billing'], summary: "Organizations' subscriptions" },
  }, async () => {
    const subs = await controlDb.subscription.findMany({ orderBy: { updatedAt: 'desc' }, take: 500 });
    const tenants = await controlDb.tenant.findMany({ where: { id: { in: subs.map((s) => s.tenantId) } }, select: { id: true, name: true, slug: true, paymentRequiredSince: true } });
    const prices = await controlDb.billingPrice.findMany({ where: { id: { in: subs.map((s) => s.priceId) } }, select: { id: true, unitAmount: true } });
    return {
      subscriptions: subs.map((s) => {
        const t = tenants.find((x) => x.id === s.tenantId);
        const unit = prices.find((p) => p.id === s.priceId)?.unitAmount ?? 0;
        return {
          tenantId: s.tenantId, tenant: t?.name ?? '(deleted)', slug: t?.slug ?? null, readOnly: !!t?.paymentRequiredSince,
          provider: s.provider, plan: s.planCode, interval: s.interval, currency: s.currency, seats: s.seats, status: s.status,
          amount: unit * s.seats, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, pastDueSince: s.pastDueSince,
          seatSyncError: s.seatSyncError, updatedAt: s.updatedAt,
        };
      }),
    };
  });
};
