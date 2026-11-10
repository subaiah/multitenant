/**
 * Charging for applications on the organization's subscription
 * (docs/hub/HUB_GAPS.md G6).
 *
 * - Platform staff price an application per currency and interval: flat (per
 *   organization) or per seat (times the subscription's seats). Its meters
 *   can be priced too: unitAmount per perQuantity, after includedQuantity
 *   each period.
 * - Charged in arrears: when a subscription's period ends (the provider
 *   moves it on: applySubscription), the period just ended is settled. Each
 *   application the organization had ENABLED (not a trial) at any time in it
 *   is charged its price, and each priced meter its usage. The charges go on
 *   the next invoice: a Razorpay subscription add-on, a Stripe invoice item.
 *   Both providers do it the same way, and neither needs a second
 *   subscription.
 * - Once per organization, application, period and kind (a unique row), and
 *   marked SENDING before the provider is called. A failed call is retried by
 *   the hourly billing pass. Stripe calls carry an idempotency key, so one
 *   stuck in SENDING is retried too. Razorpay has no such key, so one stuck
 *   there is left for staff to check (never charged twice).
 * - Administrators see this period's estimate and past charges on Billing.
 */
import { controlDb } from '../prisma.js';
import { provider, type ProviderName } from './providers.js';
import { usageTotals } from '../product-usage.js';

const DAY = 86_400_000;
export const MAX_ATTEMPTS = 6;

/** The period that ends at `end` for this interval */
export function periodBefore(end: Date, interval: string): Date {
  const d = new Date(end);
  if (interval === 'YEAR') d.setUTCFullYear(d.getUTCFullYear() - 1);
  else d.setUTCMonth(d.getUTCMonth() - 1);
  return d;
}

interface Sub { id: string; tenantId: string; provider: string; providerSubscriptionId: string; providerCustomerId: string | null; currency: string; interval: string; seats: number }

export interface ChargeLine {
  applicationId: string;
  application: string;
  kind: 'base' | 'usage';
  meterKey: string;
  quantity: number;
  amount: number;
  currency: string;
  description: string;
}

/** What the organization owes for applications in [start, end), as lines (nothing priced: none) */
export async function chargesFor(sub: Sub, start: Date, end: Date): Promise<ChargeLine[]> {
  const currency = sub.currency.toUpperCase();
  const entitled = await controlDb.tenantApplication.findMany({
    where: { tenantId: sub.tenantId, state: 'ENABLED', validFrom: { lt: end }, OR: [{ validTo: null }, { validTo: { gt: start } }] },
    select: { applicationId: true, application: { select: { name: true } } },
  });
  const appIds = entitled.map((e) => e.applicationId);
  const nameOf = new Map(entitled.map((e) => [e.applicationId, e.application.name]));
  const [prices, meterPrices, totals] = await Promise.all([
    controlDb.applicationPrice.findMany({ where: { applicationId: { in: appIds }, currency, interval: sub.interval as 'MONTH' | 'YEAR' } }),
    controlDb.meterPrice.findMany({ where: { currency }, include: { meter: { select: { applicationId: true, key: true, label: true, unit: true, application: { select: { name: true } } } } } }),
    usageTotals({ tenantId: sub.tenantId }, start, end),
  ]);
  const period = `${start.toISOString().slice(0, 10)} to ${new Date(end.getTime() - 1).toISOString().slice(0, 10)}`;
  const lines: ChargeLine[] = [];
  for (const p of prices) {
    const quantity = p.model === 'per_seat' ? sub.seats : 1;
    const amount = p.unitAmount * quantity;
    if (amount <= 0) continue;
    const name = nameOf.get(p.applicationId)!;
    lines.push({
      applicationId: p.applicationId, application: name, kind: 'base', meterKey: '', quantity, amount, currency,
      description: p.model === 'per_seat' ? `${name}: ${quantity} seat${quantity === 1 ? '' : 's'}, ${period}` : `${name}, ${period}`,
    });
  }
  // Usage is charged whether or not the application is still on: it was used
  for (const mp of meterPrices) {
    const used = totals.filter((t) => t.applicationId === mp.meter.applicationId && t.key === mp.meter.key).reduce((n, t) => n + t.total, 0);
    const billable = Math.max(0, used - mp.includedQuantity);
    const units = Math.ceil(billable / Math.max(1, mp.perQuantity));
    const amount = units * mp.unitAmount;
    if (amount <= 0) continue;
    lines.push({
      applicationId: mp.meter.applicationId, application: mp.meter.application.name, kind: 'usage', meterKey: mp.meter.key, quantity: used, amount, currency,
      description: `${mp.meter.application.name}: ${used.toLocaleString('en')} ${mp.meter.unit} (${mp.meter.label}), ${period}`,
    });
  }
  return lines;
}

/** Settle a period that just ended: record its charges once, then send them */
export async function settlePeriod(sub: Sub, periodEnd: Date): Promise<number> {
  const start = periodBefore(periodEnd, sub.interval);
  const lines = await chargesFor(sub, start, periodEnd);
  if (lines.length) {
    await controlDb.applicationCharge.createMany({
      data: lines.map((l) => ({
        tenantId: sub.tenantId, applicationId: l.applicationId, provider: sub.provider as ProviderName, subscriptionId: sub.providerSubscriptionId,
        periodStart: start, periodEnd, kind: l.kind, meterKey: l.meterKey, quantity: l.quantity, amount: l.amount, currency: l.currency, description: l.description,
      })),
      skipDuplicates: true,
    });
  }
  return sendCharges({ tenantId: sub.tenantId });
}

/**
 * Send charges that aren't at the provider yet (PENDING, FAILED under the
 * attempt limit, and Stripe's stuck in SENDING for over an hour).
 */
export async function sendCharges(filter: { tenantId?: string } = {}): Promise<number> {
  const stale = new Date(Date.now() - 60 * 60_000);
  const due = await controlDb.applicationCharge.findMany({
    where: {
      ...filter,
      OR: [
        { status: 'PENDING' },
        { status: 'FAILED', attempts: { lt: MAX_ATTEMPTS } },
        { status: 'SENDING', provider: 'STRIPE', updatedAt: { lt: stale }, attempts: { lt: MAX_ATTEMPTS } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  let added = 0;
  for (const c of due) {
    // Claim it: only one sender, and a crash leaves SENDING (see above)
    const claimed = await controlDb.applicationCharge.updateMany({ where: { id: c.id, status: c.status, attempts: c.attempts }, data: { status: 'SENDING', attempts: { increment: 1 } } });
    if (!claimed.count) continue;
    try {
      const sub = await controlDb.subscription.findUnique({ where: { providerSubscriptionId: c.subscriptionId }, select: { providerCustomerId: true } });
      const id = await provider(c.provider as ProviderName).addCharge(
        { id: c.subscriptionId, customerId: sub?.providerCustomerId ?? null },
        { amount: c.amount, currency: c.currency, description: c.description, idempotencyKey: `app-charge-${c.id}` },
      );
      await controlDb.applicationCharge.update({ where: { id: c.id }, data: { status: 'ADDED', providerChargeId: id, error: null } });
      added++;
    } catch (err) {
      await controlDb.applicationCharge.update({ where: { id: c.id }, data: { status: 'FAILED', error: (err as Error).message.slice(0, 500) } });
    }
  }
  return added;
}

/** For the Billing page: this period so far (an estimate), and past charges */
export async function applicationBilling(tenantId: string) {
  const sub = await controlDb.subscription.findUnique({ where: { tenantId } });
  const live = sub && ['ACTIVE', 'PAST_DUE', 'UNPAID'].includes(sub.status) && sub.currentPeriodEnd;
  let estimate: { periodStart: string; periodEnd: string; lines: ChargeLine[]; total: number; currency: string } | null = null;
  if (live) {
    const start = periodBefore(sub.currentPeriodEnd!, sub.interval);
    const lines = await chargesFor(sub, start, new Date(Math.min(Date.now() + DAY, sub.currentPeriodEnd!.getTime())));
    estimate = { periodStart: start.toISOString(), periodEnd: sub.currentPeriodEnd!.toISOString(), lines, total: lines.reduce((n, l) => n + l.amount, 0), currency: sub.currency.toUpperCase() };
  }
  const past = await controlDb.applicationCharge.findMany({ where: { tenantId }, orderBy: [{ periodEnd: 'desc' }, { createdAt: 'asc' }], take: 50 });
  return {
    estimate,
    charges: past.map((c) => ({
      id: c.id, description: c.description, amount: c.amount, currency: c.currency, periodStart: c.periodStart, periodEnd: c.periodEnd,
      // SENDING for a while: shown as being added
      status: c.status === 'ADDED' ? 'ADDED' : c.status === 'FAILED' && c.attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
    })),
  };
}
