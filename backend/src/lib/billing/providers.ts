/**
 * The payment providers, behind one interface: Razorpay (INR: UPI, cards,
 * netbanking) and Stripe (every other currency). Plain HTTPS calls, no SDKs:
 * the handful of endpoints used are below, and the API base URLs can point
 * at a stand-in for tests (RAZORPAY_API_URL, STRIPE_API_URL).
 *
 * Webhooks are only a signal: each one is verified, then the subscription is
 * read back from the provider's API, so the payload's shape (which varies
 * with the provider's API version) never decides anything.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config/env.js';
import { AppError } from '../../middleware/error-handler.js';

export type ProviderName = 'RAZORPAY' | 'STRIPE';
export type Interval = 'MONTH' | 'YEAR';
export type Status = 'INCOMPLETE' | 'ACTIVE' | 'PAST_DUE' | 'UNPAID' | 'CANCELED';

export interface ProviderSubscription {
  id: string;
  status: Status;
  customerId: string | null;
  providerPriceId: string;
  /** Stripe's subscription item, needed to change it */
  itemId?: string;
  seats: number;
  currentPeriodEnd: Date | null;
  /** null: the provider doesn't say (Razorpay) */
  cancelAtPeriodEnd: boolean | null;
  /** From the metadata (Stripe) or notes (Razorpay) we set */
  tenantId: string | null;
  /** Where the customer pays or authorises, while that's still to do */
  checkoutUrl: string | null;
}

export interface ProviderInvoice {
  id: string;
  number: string | null;
  amount: number;
  currency: string;
  status: string;
  url: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface WebhookEvent {
  id: string;
  type: string;
  subscriptionId: string | null;
  /** Stripe Checkout: the subscription is found through the session */
  checkoutSessionId: string | null;
}

export interface StartCheckout {
  tenantId: string;
  tenantName: string;
  email: string;
  providerPriceId: string;
  interval: Interval;
  seats: number;
  customerId: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface Provider {
  name: ProviderName;
  createPrice(p: { plan: string; planName: string; currency: string; interval: Interval; unitAmount: number }): Promise<string>;
  /** A subscription waiting for payment: where to send the customer, and (Razorpay) the subscription already made */
  startCheckout(c: StartCheckout): Promise<{ url: string; subscription: ProviderSubscription | null }>;
  /** Stripe: the subscription a finished Checkout made */
  subscriptionForCheckout(sessionId: string): Promise<string | null>;
  getSubscription(id: string): Promise<ProviderSubscription>;
  /** Change the seats or the price. `now`: straight away (prorated where the provider does that) */
  update(sub: ProviderSubscription, change: { seats?: number; providerPriceId?: string; now: boolean }): Promise<void>;
  cancel(id: string, atPeriodEnd: boolean): Promise<void>;
  /** Undo a cancellation at the period's end (Stripe only) */
  resume?(id: string): Promise<void>;
  invoices(subscriptionId: string): Promise<ProviderInvoice[]>;
  /** Where the customer manages cards and sees invoices (Stripe's portal) */
  portalUrl?(customerId: string, returnUrl: string): Promise<string>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent;
}

export class ProviderError extends AppError {
  constructor(provider: ProviderName, message: string, public status?: number) {
    super(`${provider === 'RAZORPAY' ? 'Razorpay' : 'Stripe'}: ${message}`, 502, true, 'BILLING_PROVIDER');
  }
}

const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};
const sameHex = (a: string, b: string) => {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};
const fromUnix = (s: unknown) => (typeof s === 'number' && s > 0 ? new Date(s * 1000) : null);
export class BadSignature extends Error {}

// ---------------------------------------------------------------------------
// Razorpay
// ---------------------------------------------------------------------------

function razorpay(cfg: NonNullable<typeof config.billing.razorpay>): Provider {
  const auth = `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')}`;
  async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${cfg.apiUrl}/v1${path}`, {
      method,
      headers: { authorization: auth, ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    }).catch((err) => {
      throw new ProviderError('RAZORPAY', `could not be reached (${(err as Error).message})`);
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new ProviderError('RAZORPAY', json?.error?.description ?? `request failed (${res.status})`, res.status);
    return json as T;
  }
  const STATUS: Record<string, Status> = {
    created: 'INCOMPLETE', authenticated: 'ACTIVE', active: 'ACTIVE', pending: 'PAST_DUE',
    halted: 'UNPAID', paused: 'UNPAID', cancelled: 'CANCELED', completed: 'CANCELED', expired: 'CANCELED',
  };
  const toSub = (s: any): ProviderSubscription => ({
    id: s.id,
    status: STATUS[s.status] ?? 'INCOMPLETE',
    customerId: s.customer_id ?? null,
    providerPriceId: s.plan_id,
    seats: Number(s.quantity ?? 1),
    currentPeriodEnd: fromUnix(s.current_end),
    cancelAtPeriodEnd: null,
    tenantId: (s.notes && !Array.isArray(s.notes) ? s.notes.tenantId : null) ?? null,
    checkoutUrl: s.status === 'created' ? (s.short_url ?? null) : null,
  });

  return {
    name: 'RAZORPAY',
    async createPrice({ plan, planName, currency, interval, unitAmount }) {
      const created = await call('POST', '/plans', {
        period: interval === 'YEAR' ? 'yearly' : 'monthly',
        interval: 1,
        item: { name: `${planName} (per user, ${interval === 'YEAR' ? 'yearly' : 'monthly'})`, amount: unitAmount, currency },
        notes: { plan },
      });
      return created.id as string;
    },
    async startCheckout(c) {
      const s = await call('POST', '/subscriptions', {
        plan_id: c.providerPriceId,
        quantity: c.seats,
        // Cycles to bill before it ends on its own: ten years
        total_count: c.interval === 'YEAR' ? 10 : 120,
        customer_notify: 1,
        notes: { tenantId: c.tenantId, organization: c.tenantName.slice(0, 200) },
      });
      if (!s.short_url) throw new ProviderError('RAZORPAY', 'no payment link came back for the subscription');
      return { url: s.short_url as string, subscription: toSub(s) };
    },
    async subscriptionForCheckout() {
      return null;
    },
    getSubscription: async (id) => toSub(await call('GET', `/subscriptions/${encodeURIComponent(id)}`)),
    async update(sub, change) {
      await call('PATCH', `/subscriptions/${encodeURIComponent(sub.id)}`, {
        ...(change.providerPriceId && { plan_id: change.providerPriceId }),
        ...(change.seats !== undefined && { quantity: change.seats }),
        schedule_change_at: change.now ? 'now' : 'cycle_end',
        customer_notify: true,
      });
    },
    async cancel(id, atPeriodEnd) {
      await call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atPeriodEnd ? 1 : 0 });
    },
    async invoices(subscriptionId) {
      const list = await call('GET', `/invoices?subscription_id=${encodeURIComponent(subscriptionId)}&count=50`);
      return ((list.items ?? []) as any[]).map((i) => ({
        id: i.id,
        number: i.invoice_number ?? i.receipt ?? null,
        amount: Number(i.amount ?? 0),
        currency: String(i.currency ?? 'INR').toUpperCase(),
        status: String(i.status ?? 'issued'),
        url: i.short_url ?? null,
        periodStart: fromUnix(i.billing_start),
        periodEnd: fromUnix(i.billing_end),
        paidAt: fromUnix(i.paid_at),
        createdAt: fromUnix(i.date) ?? fromUnix(i.created_at) ?? new Date(),
      }));
    },
    verifyWebhook(rawBody, headers) {
      const signature = header(headers, 'x-razorpay-signature') ?? '';
      const expected = createHmac('sha256', cfg.webhookSecret).update(rawBody).digest('hex');
      if (!sameHex(signature, expected)) throw new BadSignature('Razorpay signature does not match');
      const body = JSON.parse(rawBody.toString('utf8'));
      const p = body.payload ?? {};
      return {
        // Razorpay sends the event's id in a header; retries keep it
        id: header(headers, 'x-razorpay-event-id') ?? `${body.event}:${p.subscription?.entity?.id ?? p.payment?.entity?.id ?? ''}:${body.created_at}`,
        type: String(body.event ?? ''),
        subscriptionId: p.subscription?.entity?.id ?? p.invoice?.entity?.subscription_id ?? null,
        checkoutSessionId: null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

/** The API version our requests use; responses are read so that older and newer ones work too */
export const STRIPE_API_VERSION = '2025-03-31.basil';
const SIGNATURE_TOLERANCE_S = 300;

/** Stripe's form encoding: nested keys in brackets */
export function formEncode(data: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) formEncode(v as Record<string, unknown>, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? formEncode(item as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else out.append(key, String(v));
  }
  return out;
}

function stripe(cfg: NonNullable<typeof config.billing.stripe>): Provider {
  async function call<T = any>(method: string, path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const res = await fetch(`${cfg.apiUrl}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.secretKey}`,
        'stripe-version': STRIPE_API_VERSION,
        ...(body && { 'content-type': 'application/x-www-form-urlencoded' }),
        ...(idempotencyKey && { 'idempotency-key': idempotencyKey }),
      },
      body: body ? formEncode(body).toString() : undefined,
      signal: AbortSignal.timeout(20_000),
    }).catch((err) => {
      throw new ProviderError('STRIPE', `could not be reached (${(err as Error).message})`);
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new ProviderError('STRIPE', json?.error?.message ?? `request failed (${res.status})`, res.status);
    return json as T;
  }
  const STATUS: Record<string, Status> = {
    incomplete: 'INCOMPLETE', trialing: 'ACTIVE', active: 'ACTIVE', past_due: 'PAST_DUE',
    unpaid: 'UNPAID', paused: 'UNPAID', canceled: 'CANCELED', incomplete_expired: 'CANCELED',
  };
  const toSub = (s: any): ProviderSubscription => {
    const item = s.items?.data?.[0] ?? {};
    return {
      id: s.id,
      status: STATUS[s.status] ?? 'INCOMPLETE',
      customerId: typeof s.customer === 'string' ? s.customer : s.customer?.id ?? null,
      providerPriceId: item.price?.id ?? item.plan?.id ?? '',
      itemId: item.id,
      seats: Number(item.quantity ?? 1),
      // On the item since 2025-03-31.basil, on the subscription before
      currentPeriodEnd: fromUnix(item.current_period_end ?? s.current_period_end),
      cancelAtPeriodEnd: Boolean(s.cancel_at_period_end || s.cancel_at),
      tenantId: s.metadata?.tenantId ?? null,
      checkoutUrl: null,
    };
  };

  return {
    name: 'STRIPE',
    async createPrice({ plan, planName, currency, interval, unitAmount }) {
      const price = await call('POST', '/prices', {
        currency: currency.toLowerCase(),
        unit_amount: unitAmount,
        recurring: { interval: interval === 'YEAR' ? 'year' : 'month' },
        product_data: { name: `${planName} (per user)` },
        metadata: { plan },
      });
      return price.id as string;
    },
    async startCheckout(c) {
      const session = await call('POST', '/checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price: c.providerPriceId, quantity: c.seats }],
        success_url: c.successUrl,
        cancel_url: c.cancelUrl,
        client_reference_id: c.tenantId,
        ...(c.customerId ? { customer: c.customerId } : { customer_email: c.email }),
        metadata: { tenantId: c.tenantId },
        subscription_data: { metadata: { tenantId: c.tenantId } },
      });
      if (!session.url) throw new ProviderError('STRIPE', 'no checkout page came back');
      return { url: session.url as string, subscription: null };
    },
    async subscriptionForCheckout(sessionId) {
      const session = await call('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
      const sub = session.subscription;
      return (typeof sub === 'string' ? sub : sub?.id) ?? null;
    },
    getSubscription: async (id) => toSub(await call('GET', `/subscriptions/${encodeURIComponent(id)}`)),
    async update(sub, change) {
      if (!sub.itemId) throw new ProviderError('STRIPE', 'the subscription has no item to change');
      await call('POST', `/subscriptions/${encodeURIComponent(sub.id)}`, {
        items: [{ id: sub.itemId, ...(change.seats !== undefined && { quantity: change.seats }), ...(change.providerPriceId && { price: change.providerPriceId }) }],
        // Stripe charges or credits the difference for the rest of the period
        proration_behavior: change.now ? 'create_prorations' : 'none',
      });
    },
    async cancel(id, atPeriodEnd) {
      if (atPeriodEnd) await call('POST', `/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: true });
      else await call('DELETE', `/subscriptions/${encodeURIComponent(id)}`);
    },
    async resume(id) {
      await call('POST', `/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: false });
    },
    async invoices(subscriptionId) {
      const list = await call('GET', `/invoices?subscription=${encodeURIComponent(subscriptionId)}&limit=50`);
      return ((list.data ?? []) as any[]).map((i) => ({
        id: i.id,
        number: i.number ?? null,
        amount: Number(i.total ?? i.amount_due ?? 0),
        currency: String(i.currency ?? 'usd').toUpperCase(),
        status: String(i.status ?? 'open'),
        url: i.hosted_invoice_url ?? i.invoice_pdf ?? null,
        periodStart: fromUnix(i.lines?.data?.[0]?.period?.start ?? i.period_start),
        periodEnd: fromUnix(i.lines?.data?.[0]?.period?.end ?? i.period_end),
        paidAt: fromUnix(i.status_transitions?.paid_at),
        createdAt: fromUnix(i.created) ?? new Date(),
      }));
    },
    async portalUrl(customerId, returnUrl) {
      const session = await call('POST', '/billing_portal/sessions', { customer: customerId, return_url: returnUrl });
      return session.url as string;
    },
    verifyWebhook(rawBody, headers) {
      const sig = header(headers, 'stripe-signature') ?? '';
      const parts = Object.fromEntries(sig.split(',').map((kv) => kv.split('=') as [string, string]).filter((kv) => kv.length === 2));
      const t = Number(parts.t);
      const v1 = sig.split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
      if (!t || !v1.length) throw new BadSignature('Stripe signature missing');
      if (Math.abs(Date.now() / 1000 - t) > SIGNATURE_TOLERANCE_S) throw new BadSignature('Stripe signature too old');
      const expected = createHmac('sha256', cfg.webhookSecret).update(`${t}.`).update(rawBody).digest('hex');
      if (!v1.some((s) => sameHex(s, expected))) throw new BadSignature('Stripe signature does not match');
      const event = JSON.parse(rawBody.toString('utf8'));
      const obj = event.data?.object ?? {};
      const subOf = (v: unknown) => (typeof v === 'string' ? v : (v as { id?: string } | null)?.id ?? null);
      let subscriptionId: string | null = null;
      if (obj.object === 'subscription') subscriptionId = obj.id;
      else if (obj.object === 'invoice') subscriptionId = subOf(obj.subscription) ?? subOf(obj.parent?.subscription_details?.subscription);
      else if (obj.object === 'checkout.session') subscriptionId = subOf(obj.subscription);
      return {
        id: String(event.id ?? ''),
        type: String(event.type ?? ''),
        subscriptionId,
        checkoutSessionId: obj.object === 'checkout.session' ? obj.id : null,
      };
    },
  };
}

// ---------------------------------------------------------------------------

export function provider(name: ProviderName): Provider {
  if (name === 'RAZORPAY') {
    if (!config.billing.razorpay) throw new AppError('Payments through Razorpay are not set up', 503, true, 'BILLING_OFF');
    return razorpay(config.billing.razorpay);
  }
  if (!config.billing.stripe) throw new AppError('Payments through Stripe are not set up', 503, true, 'BILLING_OFF');
  return stripe(config.billing.stripe);
}

/** INR goes through Razorpay, every other currency through Stripe */
export const providerForCurrency = (currency: string): ProviderName => (currency.toUpperCase() === 'INR' ? 'RAZORPAY' : 'STRIPE');

export const enabledProviders = (): ProviderName[] => [
  ...(config.billing.razorpay ? (['RAZORPAY'] as const) : []),
  ...(config.billing.stripe ? (['STRIPE'] as const) : []),
];
