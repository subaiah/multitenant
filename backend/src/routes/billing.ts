/**
 * An organization's billing (the Billing page). docs/BILLING.md.
 *
 *   GET  /billing                the plan, what it allows and what's used, the
 *                                subscription, plans on offer, invoices
 *   POST /billing/checkout       start a subscription: { plan, interval, currency } → { url } to pay at
 *   POST /billing/refresh        after paying: look the subscription up now ({ session } from Stripe)
 *   POST /billing/change         another plan or interval
 *   POST /billing/cancel         cancel at the end of the period
 *   POST /billing/resume         withdraw that (Stripe)
 *   POST /billing/portal         Stripe's page for cards and invoices → { url }
 *
 * All of it works while the organization is read-only (an ended trial, an
 * overdue payment): paying is how it gets out of that. Changes are for the
 * organization's own people with billing:manage, not platform staff in a
 * support session.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env.js';
import { controlDb } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { PLAN_CODES, planRules, usageOf, type PlanCode } from '../lib/billing/plans.js';
import { enabledProviders, providerForCurrency } from '../lib/billing/providers.js';
import {
  cancelSubscription, changePlan, portalUrl, refreshAfterCheckout, resumeSubscription, startCheckout, type Actor,
} from '../lib/billing/subscriptions.js';

async function actorOf(request: FastifyRequest): Promise<Actor & { email: string }> {
  if (request.supportSession) throw new AppError("Billing is for the organization's own people, not support sessions", 403);
  const user = await request.db.user.findFirst({ where: { id: request.user.userId, tenantId: request.tenant.id }, select: { email: true } });
  if (!user) throw new AppError('Account not found', 404);
  return { id: request.user.userId, email: user.email, type: 'USER' };
}

export async function billingOverview(tenantId: string) {
  const [tenant, sub, usage, plans, invoices] = await Promise.all([
    controlDb.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { plan: true, status: true, trialEndsAt: true, paymentRequiredSince: true } }),
    controlDb.subscription.findUnique({ where: { tenantId } }),
    usageOf(tenantId),
    controlDb.billingPlan.findMany({ orderBy: { sortOrder: 'asc' }, include: { prices: { where: { active: true }, orderBy: [{ currency: 'asc' }, { interval: 'asc' }] } } }),
    controlDb.invoice.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 24 }),
  ]);
  const providers = enabledProviders();
  const offered = (code: string) => code === tenant.plan || code === sub?.planCode;
  const current = await planRules(tenant.plan);
  return {
    billingEnabled: providers.length > 0,
    graceDays: config.billing.graceDays,
    plan: current,
    usage,
    status: tenant.status,
    trialEndsAt: tenant.trialEndsAt,
    paymentRequiredSince: tenant.paymentRequiredSince,
    subscription: sub && {
      provider: sub.provider,
      plan: sub.planCode,
      interval: sub.interval,
      currency: sub.currency,
      seats: sub.seats,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      pastDueSince: sub.pastDueSince,
      graceEndsAt: sub.pastDueSince ? new Date(sub.pastDueSince.getTime() + config.billing.graceDays * 86_400_000) : null,
      checkoutUrl: sub.checkoutUrl,
      seatSyncError: sub.seatSyncError,
      unitAmount: (await controlDb.billingPrice.findUnique({ where: { id: sub.priceId }, select: { unitAmount: true } }))?.unitAmount ?? null,
      canResume: sub.provider === 'STRIPE',
      hasPortal: sub.provider === 'STRIPE' && !!sub.providerCustomerId,
    },
    plans: plans
      .filter((p) => p.public || offered(p.code))
      .map((p) => ({
        code: p.code, name: p.name, description: p.description, public: p.public,
        maxUsers: p.maxUsers, maxOrganizations: p.maxOrganizations, maxGroups: p.maxGroups, allowSso: p.allowSso, allowCustomDomain: p.allowCustomDomain,
        // Only prices someone can pay with here
        prices: p.prices
          .filter((x) => providers.includes(x.provider as never))
          .map((x) => ({ currency: x.currency, interval: x.interval, unitAmount: x.unitAmount, provider: x.provider })),
      })),
    invoices: invoices.map((i) => ({ id: i.id, number: i.number, amount: i.amount, currency: i.currency, status: i.status, url: i.url, periodStart: i.periodStart, periodEnd: i.periodEnd, paidAt: i.paidAt, createdAt: i.createdAt })),
  };
}

const planCode = z.enum(PLAN_CODES as [PlanCode, ...PlanCode[]]);
const interval = z.enum(['MONTH', 'YEAR']);
// Works while read-only (paying is the way out of it); a few changes per few minutes
const changing = { allowWhenTrialEnded: true, rateLimit: { max: 20, timeWindow: '10 minutes' } };

export const billingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    config: { permission: 'billing:read' },
    schema: { tags: ['billing'], summary: 'The plan, usage, subscription, plans on offer and invoices' },
  }, async (request) => billingOverview(request.tenant.id));

  fastify.post('/checkout', {
    config: { permission: 'billing:manage', ...changing },
    schema: { tags: ['billing'], summary: 'Start a subscription: returns the page to pay at' },
  }, async (request) => {
    const body = z.object({ plan: planCode, interval, currency: z.string().trim().length(3) }).parse(request.body);
    if (!enabledProviders().includes(providerForCurrency(body.currency))) throw new AppError(`Payments in ${body.currency.toUpperCase()} are not set up`, 400);
    const actor = await actorOf(request);
    return startCheckout(request.tenant.id, actor, body, actor.email);
  });

  fastify.post('/refresh', {
    config: { permission: 'billing:read', allowWhenTrialEnded: true, rateLimit: { max: 30, timeWindow: '10 minutes' } },
    schema: { tags: ['billing'], summary: 'Look the subscription up at the payment provider now (after checkout)' },
  }, async (request) => {
    const body = z.object({ session: z.string().max(300).regex(/^cs_[A-Za-z0-9_]+$/).optional() }).parse(request.body ?? {});
    await refreshAfterCheckout(request.tenant.id, body.session);
    return billingOverview(request.tenant.id);
  });

  fastify.post('/change', {
    config: { permission: 'billing:manage', ...changing },
    schema: { tags: ['billing'], summary: 'Move the subscription to another plan or billing interval' },
  }, async (request) => {
    const body = z.object({ plan: planCode, interval }).parse(request.body);
    await changePlan(request.tenant.id, await actorOf(request), body);
    return billingOverview(request.tenant.id);
  });

  fastify.post('/cancel', {
    config: { permission: 'billing:manage', ...changing },
    schema: { tags: ['billing'], summary: 'Cancel at the end of the current period (then the Free plan)' },
  }, async (request) => {
    await cancelSubscription(request.tenant.id, await actorOf(request));
    return billingOverview(request.tenant.id);
  });

  fastify.post('/resume', {
    config: { permission: 'billing:manage', ...changing },
    schema: { tags: ['billing'], summary: 'Keep a subscription that was set to cancel' },
  }, async (request) => {
    await resumeSubscription(request.tenant.id, await actorOf(request));
    return billingOverview(request.tenant.id);
  });

  fastify.post('/portal', {
    config: { permission: 'billing:manage', ...changing },
    schema: { tags: ['billing'], summary: "Stripe's page for payment methods and invoices" },
  }, async (request) => {
    await actorOf(request);
    return { url: await portalUrl(request.tenant.id) };
  });
};
