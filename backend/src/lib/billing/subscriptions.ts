/**
 * Organizations' subscriptions: starting one, keeping our copy in step with
 * the payment provider, and what follows from its state.
 *
 * The provider is the source of truth. Whatever happens (a webhook, the
 * customer coming back from checkout, the hourly job), we read the
 * subscription from the provider's API and apply it (applySubscription):
 *
 *   ACTIVE      the organization is on the subscription's plan; a trial ends
 *   PAST_DUE    a payment failed and the provider is retrying: it keeps
 *   UNPAID      working for BILLING_GRACE_DAYS from the first failure, then
 *               it's read-only (tenants.payment_required_since) until paid
 *   CANCELED    back to the Free plan
 *
 * Seats follow the number of people (active and invited): checked hourly and
 * changed at the provider when they differ. Stripe prorates straight away;
 * Razorpay applies the new count from the next billing cycle.
 */
import { config } from '../../config/env.js';
import { controlDb } from '../prisma.js';
import { recordAudit, type AuditActor } from '../audit.js';
import { AppError } from '../../middleware/error-handler.js';
import { appOriginForTenant } from '../domains.js';
import { forgetPlans, planRules, usageOf, type PlanCode } from './plans.js';
import { BadSignature, provider, providerForCurrency, type Interval, type ProviderName, type ProviderSubscription, type Status } from './providers.js';

export const LIVE: Status[] = ['ACTIVE', 'PAST_DUE', 'UNPAID'];
const DAY = 86_400_000;


async function auditTenant(tenantId: string, event: string, actor: AuditActor, details: Record<string, unknown> = {}) {
  await recordAudit({ actor, tenantId }, event, { resource: { type: 'subscription', label: 'Subscription' }, details }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Applying the provider's view
// ---------------------------------------------------------------------------

export interface ApplyResult {
  tenantId: string;
  status: Status;
  plan: PlanCode;
}

/**
 * Bring our subscription row, and the organization's plan and access, in line
 * with the provider's subscription. Safe to repeat.
 */
export async function applySubscription(name: ProviderName, ps: ProviderSubscription, now = new Date()): Promise<ApplyResult | null> {
  const ours = await controlDb.subscription.findUnique({ where: { providerSubscriptionId: ps.id } });
  const tenantId = ours?.tenantId ?? ps.tenantId;
  if (!tenantId) return null;
  const tenant = await controlDb.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, plan: true, status: true, paymentRequiredSince: true } });
  if (!tenant) return null;

  const current = ours ?? (await controlDb.subscription.findUnique({ where: { tenantId } }));
  // An old subscription's news doesn't replace the organization's current one
  if (current && current.providerSubscriptionId !== ps.id && current.status !== 'CANCELED' && current.status !== 'INCOMPLETE' && ps.status === 'CANCELED') {
    return null;
  }

  const price = await controlDb.billingPrice.findUnique({ where: { providerPriceId: ps.providerPriceId } });
  if (!price) throw new Error(`No plan has the provider price ${ps.providerPriceId}`);

  const failing = ps.status === 'PAST_DUE' || ps.status === 'UNPAID';
  const sameSub = current?.providerSubscriptionId === ps.id;
  const pastDueSince = failing ? (sameSub && current?.pastDueSince ? current.pastDueSince : now) : null;
  const data = {
    tenantId,
    provider: name,
    providerSubscriptionId: ps.id,
    providerCustomerId: ps.customerId ?? (sameSub ? current?.providerCustomerId : null) ?? null,
    planCode: price.planCode,
    priceId: price.id,
    currency: price.currency,
    interval: price.interval,
    seats: ps.seats,
    status: ps.status,
    currentPeriodEnd: ps.currentPeriodEnd,
    // Razorpay doesn't say: keep what we asked for
    cancelAtPeriodEnd: ps.status === 'CANCELED' ? false : (ps.cancelAtPeriodEnd ?? (sameSub ? current?.cancelAtPeriodEnd : false) ?? false),
    pastDueSince,
    checkoutUrl: ps.status === 'INCOMPLETE' ? (ps.checkoutUrl ?? (sameSub ? current?.checkoutUrl : null) ?? null) : null,
  };
  if (current && !sameSub) await controlDb.subscription.delete({ where: { id: current.id } });
  const saved = sameSub
    ? await controlDb.subscription.update({ where: { id: current!.id }, data })
    : await controlDb.subscription.create({ data });

  // What it means for the organization
  const before = sameSub ? current : null;
  const plan = (ps.status === 'CANCELED' ? 'FREE' : LIVE.includes(ps.status) ? price.planCode : tenant.plan) as PlanCode;
  const overdue = failing && pastDueSince!.getTime() + config.billing.graceDays * DAY <= now.getTime();
  const tenantData: Record<string, unknown> = {};
  if (plan !== tenant.plan) tenantData.plan = plan;
  // Paying (or having paid) ends a trial
  if (LIVE.includes(ps.status) && tenant.status === 'TRIAL') tenantData.status = 'ACTIVE';
  if (overdue && !tenant.paymentRequiredSince) tenantData.paymentRequiredSince = now;
  if (!overdue && tenant.paymentRequiredSince) tenantData.paymentRequiredSince = null;
  if (Object.keys(tenantData).length) await controlDb.tenant.update({ where: { id: tenantId }, data: tenantData });

  // The audit trail (and, through it, notifications)
  const system = { type: 'SYSTEM' } as const;
  const info = { plan: price.planCode, seats: ps.seats, provider: name, status: ps.status };
  if (LIVE.includes(ps.status) && (!before || !LIVE.includes(before.status as Status))) await auditTenant(tenantId, 'billing.subscribed', system, info);
  else if (before && LIVE.includes(ps.status) && before.planCode !== price.planCode) await auditTenant(tenantId, 'billing.plan_changed', system, { ...info, from: before.planCode });
  if (before && before.seats !== ps.seats && LIVE.includes(ps.status)) await auditTenant(tenantId, 'billing.seats_changed', system, { from: before.seats, to: ps.seats });
  if (failing && (!before || !before.pastDueSince)) {
    await auditTenant(tenantId, 'billing.payment_failed', system, { ...info, graceEnds: new Date(pastDueSince!.getTime() + config.billing.graceDays * DAY).toISOString() });
  }
  if (tenantData.paymentRequiredSince) await auditTenant(tenantId, 'billing.payment_required', system, info);
  if (tenantData.paymentRequiredSince === null || (!failing && before?.pastDueSince)) await auditTenant(tenantId, 'billing.payment_recovered', system, info);
  if (ps.status === 'CANCELED' && before && before.status !== 'CANCELED') await auditTenant(tenantId, 'billing.ended', system, info);

  return { tenantId, status: saved.status as Status, plan };
}

/** Read a subscription from its provider and apply it, with its invoices */
export async function syncSubscription(name: ProviderName, subscriptionId: string): Promise<ApplyResult | null> {
  const p = provider(name);
  const ps = await p.getSubscription(subscriptionId);
  const applied = await applySubscription(name, ps);
  if (applied) await syncInvoices(name, subscriptionId, applied.tenantId);
  return applied;
}

export async function syncInvoices(name: ProviderName, subscriptionId: string, tenantId: string) {
  const invoices = await provider(name).invoices(subscriptionId);
  for (const i of invoices) {
    const data = { tenantId, provider: name, number: i.number, amount: i.amount, currency: i.currency, status: i.status, url: i.url, periodStart: i.periodStart, periodEnd: i.periodEnd, paidAt: i.paidAt, createdAt: i.createdAt };
    await controlDb.invoice.upsert({ where: { providerInvoiceId: i.id }, create: { providerInvoiceId: i.id, ...data }, update: data });
  }
}

// ---------------------------------------------------------------------------
// What an organization's administrators do
// ---------------------------------------------------------------------------

/** Seats to pay for: everyone active or invited, at least one */
export async function seatsNeeded(tenantId: string) {
  return Math.max(1, (await usageOf(tenantId)).users);
}

async function priceFor(plan: PlanCode, interval: Interval, currency: string) {
  const price = await controlDb.billingPrice.findFirst({ where: { planCode: plan, interval, currency: currency.toUpperCase(), active: true }, orderBy: { createdAt: 'desc' } });
  if (!price) throw new AppError(`The ${plan.toLowerCase()} plan has no ${interval === 'YEAR' ? 'yearly' : 'monthly'} price in ${currency.toUpperCase()}`, 400, true, 'NO_PRICE');
  return price;
}

/** Refuse a plan whose limits the organization is already over */
async function assertFits(tenantId: string, plan: PlanCode) {
  const rules = await planRules(plan);
  const usage = await usageOf(tenantId);
  const over = ([['users', rules.maxUsers], ['organizations', rules.maxOrganizations], ['groups', rules.maxGroups]] as const)
    .filter(([what, max]) => max !== null && usage[what] > max)
    .map(([what, max]) => `${usage[what]} ${what} (the plan allows ${max})`);
  if (over.length) throw new AppError(`The ${rules.name} plan is too small: you have ${over.join(' and ')}.`, 409, true, 'PLAN_TOO_SMALL');
}

export interface Actor { id: string; email: string | null; type: 'USER' | 'PLATFORM' }

export async function startCheckout(tenantId: string, actor: Actor, choice: { plan: PlanCode; interval: Interval; currency: string }, email: string) {
  const existing = await controlDb.subscription.findUnique({ where: { tenantId } });
  if (existing && LIVE.includes(existing.status as Status)) {
    throw new AppError('This organization already has a subscription: change its plan instead', 409, true, 'ALREADY_SUBSCRIBED');
  }
  if (choice.plan === 'FREE') throw new AppError('The Free plan needs no subscription', 400);
  await assertFits(tenantId, choice.plan);
  const price = await priceFor(choice.plan, choice.interval, choice.currency);
  const name = price.provider as ProviderName;
  const p = provider(name);
  const tenant = await controlDb.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
  const origin = await appOriginForTenant(tenantId);
  const seats = await seatsNeeded(tenantId);

  // A checkout left unfinished at Razorpay is replaced by this one
  if (existing?.status === 'INCOMPLETE' && existing.provider === 'RAZORPAY') {
    await provider('RAZORPAY').cancel(existing.providerSubscriptionId, false).catch(() => {});
  }
  const started = await p.startCheckout({
    tenantId, tenantName: tenant.name, email, providerPriceId: price.providerPriceId, interval: price.interval as Interval, seats,
    customerId: existing?.provider === name ? existing.providerCustomerId : null,
    successUrl: `${origin}/billing?checkout=done&session={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/billing?checkout=cancelled`,
  });
  if (started.subscription) {
    // Razorpay: the subscription exists already, waiting for the first payment
    const data = {
      provider: name, providerSubscriptionId: started.subscription.id, providerCustomerId: started.subscription.customerId,
      planCode: price.planCode, priceId: price.id, currency: price.currency, interval: price.interval, seats,
      status: 'INCOMPLETE' as const, currentPeriodEnd: null, cancelAtPeriodEnd: false, pastDueSince: null, checkoutUrl: started.url, createdById: actor.id,
    };
    await controlDb.subscription.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
  }
  await auditTenant(tenantId, 'billing.checkout_started', { type: actor.type, id: actor.id, email: actor.email }, { plan: choice.plan, interval: choice.interval, currency: price.currency, seats, provider: name });
  return { url: started.url, provider: name };
}

/** After checkout: look the subscription up now rather than wait for the webhook */
export async function refreshAfterCheckout(tenantId: string, stripeSessionId?: string) {
  if (stripeSessionId && enabled('STRIPE')) {
    const subId = await provider('STRIPE').subscriptionForCheckout(stripeSessionId);
    if (subId) {
      const ps = await provider('STRIPE').getSubscription(subId);
      if (ps.tenantId !== tenantId) throw new AppError('That checkout belongs to another organization', 403);
      return syncSubscription('STRIPE', subId);
    }
  }
  const ours = await controlDb.subscription.findUnique({ where: { tenantId } });
  if (ours && enabled(ours.provider as ProviderName)) return syncSubscription(ours.provider as ProviderName, ours.providerSubscriptionId);
  return null;
}

const enabled = (name: ProviderName) => (name === 'RAZORPAY' ? !!config.billing.razorpay : !!config.billing.stripe);

async function liveSubscription(tenantId: string) {
  const sub = await controlDb.subscription.findUnique({ where: { tenantId } });
  if (!sub || !LIVE.includes(sub.status as Status)) throw new AppError('This organization has no subscription', 404, true, 'NO_SUBSCRIPTION');
  return sub;
}

export async function changePlan(tenantId: string, actor: Actor, choice: { plan: PlanCode; interval: Interval }) {
  const sub = await liveSubscription(tenantId);
  if (choice.plan === 'FREE') throw new AppError('To go back to the Free plan, cancel the subscription', 400);
  if (sub.planCode === choice.plan && sub.interval === choice.interval) return sub;
  await assertFits(tenantId, choice.plan);
  const price = await priceFor(choice.plan, choice.interval, sub.currency);
  const name = sub.provider as ProviderName;
  const p = provider(name);
  const ps = await p.getSubscription(sub.providerSubscriptionId);
  const order = (c: string) => ['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE'].indexOf(c);
  const upgrade = order(choice.plan) > order(sub.planCode) || (order(choice.plan) === order(sub.planCode) && choice.interval === 'YEAR');
  // Upgrades straight away; downgrades from the next billing cycle at
  // Razorpay (which doesn't prorate), straight away with credit at Stripe
  await p.update(ps, { providerPriceId: price.providerPriceId, now: upgrade || name === 'STRIPE' });
  await auditTenant(tenantId, 'billing.plan_changed', { type: actor.type, id: actor.id, email: actor.email }, { from: sub.planCode, to: choice.plan, interval: choice.interval, when: upgrade || name === 'STRIPE' ? 'now' : 'next billing cycle' });
  await syncSubscription(name, sub.providerSubscriptionId);
  return controlDb.subscription.findUniqueOrThrow({ where: { tenantId } });
}

export async function cancelSubscription(tenantId: string, actor: Actor) {
  const sub = await liveSubscription(tenantId);
  if (sub.cancelAtPeriodEnd) return sub;
  const name = sub.provider as ProviderName;
  await provider(name).cancel(sub.providerSubscriptionId, true);
  await controlDb.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
  await auditTenant(tenantId, 'billing.canceled', { type: actor.type, id: actor.id, email: actor.email }, { plan: sub.planCode, endsAt: sub.currentPeriodEnd });
  await syncSubscription(name, sub.providerSubscriptionId);
  return controlDb.subscription.findUniqueOrThrow({ where: { tenantId } });
}

export async function resumeSubscription(tenantId: string, actor: Actor) {
  const sub = await liveSubscription(tenantId);
  const p = provider(sub.provider as ProviderName);
  if (!p.resume) throw new AppError("A Razorpay subscription can't be un-cancelled: subscribe again once it has ended", 409, true, 'CANNOT_RESUME');
  if (!sub.cancelAtPeriodEnd) return sub;
  await p.resume(sub.providerSubscriptionId);
  await controlDb.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false } });
  await auditTenant(tenantId, 'billing.resumed', { type: actor.type, id: actor.id, email: actor.email }, { plan: sub.planCode });
  await syncSubscription(sub.provider as ProviderName, sub.providerSubscriptionId);
  return controlDb.subscription.findUniqueOrThrow({ where: { tenantId } });
}

export async function portalUrl(tenantId: string) {
  const sub = await controlDb.subscription.findUnique({ where: { tenantId } });
  if (!sub?.providerCustomerId) throw new AppError('There is no payment account for this organization yet', 404);
  const p = provider(sub.provider as ProviderName);
  if (!p.portalUrl) throw new AppError('Razorpay has no customer portal: payment methods are changed from the payment link Razorpay emails', 409, true, 'NO_PORTAL');
  return p.portalUrl(sub.providerCustomerId, `${await appOriginForTenant(tenantId)}/billing`);
}

// ---------------------------------------------------------------------------
// Seats and grace periods (the hourly job)
// ---------------------------------------------------------------------------

/** Make the provider's seat count match the organization's people */
export async function syncSeats(tenantId: string): Promise<'unchanged' | 'changed' | 'failed' | 'none'> {
  const sub = await controlDb.subscription.findUnique({ where: { tenantId } });
  if (!sub || !LIVE.includes(sub.status as Status) || sub.cancelAtPeriodEnd || !enabled(sub.provider as ProviderName)) return 'none';
  const seats = await seatsNeeded(tenantId);
  if (seats === sub.seats) {
    if (sub.seatSyncError) await controlDb.subscription.update({ where: { id: sub.id }, data: { seatSyncError: null } });
    return 'unchanged';
  }
  const name = sub.provider as ProviderName;
  const p = provider(name);
  try {
    const ps = await p.getSubscription(sub.providerSubscriptionId);
    if (ps.seats !== seats) await p.update(ps, { seats, now: name === 'STRIPE' });
    await controlDb.subscription.update({ where: { id: sub.id }, data: { seatSyncError: null, seatsSyncedAt: new Date() } });
    // Razorpay keeps the current count until the next cycle: our row shows what's billed
    if (name === 'STRIPE') await syncSubscription(name, sub.providerSubscriptionId);
    else await auditTenant(tenantId, 'billing.seats_changed', { type: 'SYSTEM' }, { from: sub.seats, to: seats, from_next_cycle: true });
    return 'changed';
  } catch (err) {
    await controlDb.subscription.update({ where: { id: sub.id }, data: { seatSyncError: (err as Error).message.slice(0, 500), seatsSyncedAt: new Date() } });
    return 'failed';
  }
}

/** The hourly pass: grace periods running out, seats, and subscriptions we may have missed news of */
export async function runBillingMaintenance(now = new Date()) {
  const result = { checked: 0, readOnly: 0, seats: { changed: 0, failed: 0 }, errors: [] as string[] };
  const subs = await controlDb.subscription.findMany({ where: { status: { in: [...LIVE, 'INCOMPLETE'] } }, select: { tenantId: true, provider: true, providerSubscriptionId: true, status: true, createdAt: true } });
  for (const s of subs) {
    const name = s.provider as ProviderName;
    if (!enabled(name)) continue;
    // An unfinished checkout older than a day: Razorpay keeps it; nothing to do
    if (s.status === 'INCOMPLETE' && now.getTime() - s.createdAt.getTime() > DAY) continue;
    try {
      const applied = await syncSubscription(name, s.providerSubscriptionId);
      result.checked++;
      if (applied && LIVE.includes(applied.status)) {
        const seats = await syncSeats(s.tenantId);
        if (seats === 'changed') result.seats.changed++;
        if (seats === 'failed') result.seats.failed++;
      }
    } catch (err) {
      result.errors.push(`${s.tenantId}: ${(err as Error).message}`);
    }
  }
  result.readOnly = await controlDb.tenant.count({ where: { paymentRequiredSince: { not: null } } });
  return result;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * A webhook delivery: verified, recorded once by its event id, then the
 * subscription it's about is read from the provider and applied. Returns the
 * HTTP status to answer with: 400 for a bad signature, 500 to have the
 * provider try again later.
 */
export async function handleWebhook(name: ProviderName, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ status: number; message: string }> {
  const p = provider(name);
  let event;
  try {
    event = p.verifyWebhook(rawBody, headers);
  } catch (err) {
    if (err instanceof BadSignature || err instanceof SyntaxError) return { status: 400, message: (err as Error).message };
    throw err;
  }
  if (!event.id) return { status: 400, message: 'The event has no id' };

  const seen = await controlDb.billingEvent.findUnique({ where: { provider_eventId: { provider: name, eventId: event.id } } });
  if (seen?.processedAt) return { status: 200, message: 'Already handled' };
  const row = seen ?? (await controlDb.billingEvent.create({ data: { provider: name, eventId: event.id, type: event.type.slice(0, 100) } }).catch(() => null));
  if (!row) return { status: 200, message: 'Already being handled' };

  try {
    let subscriptionId = event.subscriptionId;
    if (!subscriptionId && event.checkoutSessionId) subscriptionId = await p.subscriptionForCheckout(event.checkoutSessionId);
    const applied = subscriptionId ? await syncSubscription(name, subscriptionId) : null;
    await controlDb.billingEvent.update({ where: { id: row.id }, data: { processedAt: new Date(), tenantId: applied?.tenantId ?? null, error: null } });
    return { status: 200, message: applied ? `Applied to ${applied.tenantId}` : 'Nothing to do' };
  } catch (err) {
    await controlDb.billingEvent.update({ where: { id: row.id }, data: { error: (err as Error).message.slice(0, 500) } }).catch(() => {});
    return { status: 500, message: 'Could not be handled; it will be retried' };
  }
}

// ---------------------------------------------------------------------------
// Prices (platform staff)
// ---------------------------------------------------------------------------

/** A new per-seat price for a plan: made at the provider, and the previous one retired */
export async function setPrice(plan: PlanCode, input: { currency: string; interval: Interval; unitAmount: number }, actor: Actor) {
  const currency = input.currency.toUpperCase();
  const name = providerForCurrency(currency);
  const p = provider(name);
  const rules = await controlDb.billingPlan.findUniqueOrThrow({ where: { code: plan } });
  const providerPriceId = await p.createPrice({ plan, planName: rules.name, currency, interval: input.interval, unitAmount: input.unitAmount });
  const price = await controlDb.$transaction(async (tx) => {
    await tx.billingPrice.updateMany({ where: { planCode: plan, currency, interval: input.interval, active: true }, data: { active: false } });
    return tx.billingPrice.create({ data: { planCode: plan, provider: name, currency, interval: input.interval, unitAmount: input.unitAmount, providerPriceId } });
  });
  forgetPlans();
  await recordAudit({ actor: { type: actor.type, id: actor.id, email: actor.email }, tenantId: null }, 'billing.price_set', {
    resource: { type: 'billing_plan', id: plan, label: rules.name }, details: { currency, interval: input.interval, unitAmount: input.unitAmount, provider: name, providerPriceId },
  }).catch(() => {});
  return price;
}

// ---------------------------------------------------------------------------
// Closing and deleting organizations
// ---------------------------------------------------------------------------

/**
 * An organization closed by its admins stops renewing (it keeps what it paid
 * for until the period ends); a deleted one is cancelled at once and its
 * billing rows removed. Best effort: a provider that can't be reached doesn't
 * stop either.
 */
export async function endBillingFor(tenantId: string, how: 'period_end' | 'now') {
  const sub = await controlDb.subscription.findUnique({ where: { tenantId } });
  if (sub && LIVE.concat('INCOMPLETE').includes(sub.status as Status) && enabled(sub.provider as ProviderName)) {
    const atEnd = how === 'period_end' && sub.status !== 'INCOMPLETE';
    if (!(atEnd && sub.cancelAtPeriodEnd)) {
      await provider(sub.provider as ProviderName).cancel(sub.providerSubscriptionId, atEnd).catch(() => {});
    }
    if (atEnd) {
      await controlDb.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
      await auditTenant(tenantId, 'billing.canceled', { type: 'SYSTEM' }, { reason: 'organization closed', endsAt: sub.currentPeriodEnd });
    }
  }
  if (how === 'now') {
    await controlDb.subscription.deleteMany({ where: { tenantId } });
    await controlDb.invoice.deleteMany({ where: { tenantId } });
    await controlDb.billingEvent.updateMany({ where: { tenantId }, data: { tenantId: null } });
  }
}
