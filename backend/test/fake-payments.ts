/**
 * Stand-ins for Razorpay's and Stripe's APIs (the endpoints lib/billing uses),
 * with what a customer does at their checkout pages, and signed webhooks.
 * One server; Razorpay calls carry Basic auth, Stripe's a Bearer key.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const RAZORPAY = { keyId: 'rzp_test_key', keySecret: 'rzp_test_secret', webhookSecret: 'rzp_webhook_secret' };
export const STRIPE = { secretKey: 'sk_test_fake', webhookSecret: 'whsec_fake' };

type Any = Record<string, any>;
const now = () => Math.floor(Date.now() / 1000);

export interface FakePayments {
  url: string;
  stop: () => Promise<void>;
  calls: { method: string; path: string; body: Any }[];
  razorpay: {
    plans: Map<string, Any>;
    subs: Map<string, Any>;
    /** The customer pays at the link: the subscription becomes active */
    authorize: (subId: string, method?: 'card' | 'upi') => Any;
    /** A new billing cycle: scheduled changes apply, an invoice is paid */
    renew: (subId: string) => void;
    setStatus: (subId: string, status: string) => void;
  };
  stripe: {
    prices: Map<string, Any>;
    sessions: Map<string, Any>;
    subs: Map<string, Any>;
    /** The customer pays at Checkout: a subscription is made */
    complete: (sessionId: string) => Any;
    setStatus: (subId: string, status: string) => void;
  };
}

export async function startFakePayments(): Promise<FakePayments> {
  let n = 0;
  const id = (prefix: string) => `${prefix}_${(++n).toString().padStart(6, '0')}`;
  const calls: FakePayments['calls'] = [];
  const rz = { plans: new Map<string, Any>(), subs: new Map<string, Any>(), invoices: [] as Any[] };
  const st = { prices: new Map<string, Any>(), sessions: new Map<string, Any>(), subs: new Map<string, Any>(), invoices: [] as Any[] };
  let base = '';

  const rzInvoice = (sub: Any) => {
    const plan = rz.plans.get(sub.plan_id);
    rz.invoices.push({
      id: id('inv'), subscription_id: sub.id, amount: (plan?.item.amount ?? 0) * sub.quantity, currency: 'INR', status: 'paid',
      short_url: `${base}/rzp/invoice`, billing_start: sub.current_start, billing_end: sub.current_end, paid_at: now(), date: now(),
    });
  };
  const stInvoice = (sub: Any) => {
    const item = sub.items.data[0];
    st.invoices.push({
      id: id('in'), object: 'invoice', number: `INV-${n}`, subscription: sub.id, total: st.prices.get(item.price.id)!.unit_amount * item.quantity,
      currency: st.prices.get(item.price.id)!.currency, status: 'paid', hosted_invoice_url: `${base}/stripe/invoice`, created: now(),
      lines: { data: [{ period: { start: now(), end: item.current_period_end } }] }, status_transitions: { paid_at: now() },
    });
  };

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      const auth = String(req.headers.authorization ?? '');
      const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      let body: Any = {};
      if (raw) {
        if (String(req.headers['content-type']).includes('json')) body = JSON.parse(raw);
        else body = Object.fromEntries(new URLSearchParams(raw));
      }
      calls.push({ method: req.method ?? '', path: `${path}${url.search}`, body });

      // ---- Razorpay
      if (auth.startsWith('Basic ')) {
        if (auth !== `Basic ${Buffer.from(`${RAZORPAY.keyId}:${RAZORPAY.keySecret}`).toString('base64')}`) return json(401, { error: { description: 'Authentication failed' } });
        let m: RegExpMatchArray | null;
        if (req.method === 'POST' && path === '/v1/plans') {
          const plan = { id: id('plan'), entity: 'plan', ...body };
          rz.plans.set(plan.id, plan);
          return json(200, plan);
        }
        if (req.method === 'POST' && path === '/v1/subscriptions') {
          if (!rz.plans.has(body.plan_id)) return json(400, { error: { description: 'The id provided does not exist' } });
          const sub = { id: id('sub'), entity: 'subscription', plan_id: body.plan_id, quantity: body.quantity ?? 1, status: 'created', notes: body.notes ?? [], short_url: `${base}/rzp/pay`, customer_id: null, current_start: null, current_end: null, total_count: body.total_count, method: null as string | null, scheduled: null as Any | null };
          sub.short_url = `${base}/rzp/pay/${sub.id}`;
          rz.subs.set(sub.id, sub);
          return json(200, sub);
        }
        if ((m = path.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
          const sub = rz.subs.get(m[1]);
          if (!sub) return json(400, { error: { description: 'The id provided does not exist' } });
          if (req.method === 'GET') return json(200, sub);
          if (req.method === 'PATCH') {
            if (sub.method === 'upi') return json(400, { error: { description: 'subscriptions cannot be updated when payment mode is UPI' } });
            if (!['authenticated', 'active'].includes(sub.status)) return json(400, { error: { description: "Can't update Subscription when Subscription is not in Authenticated or Active state" } });
            const change = { ...(body.plan_id && { plan_id: body.plan_id }), ...(body.quantity !== undefined && { quantity: body.quantity }) };
            if (body.schedule_change_at === 'cycle_end') sub.scheduled = { ...sub.scheduled, ...change };
            else Object.assign(sub, change);
            return json(200, sub);
          }
        }
        if ((m = path.match(/^\/v1\/subscriptions\/([^/]+)\/cancel$/)) && req.method === 'POST') {
          const sub = rz.subs.get(m[1]);
          if (!sub) return json(400, { error: { description: 'The id provided does not exist' } });
          if (Number(body.cancel_at_cycle_end) === 1) sub.cancel_at_cycle_end = true;
          else sub.status = 'cancelled';
          return json(200, sub);
        }
        if (req.method === 'GET' && path === '/v1/invoices') {
          return json(200, { entity: 'collection', items: rz.invoices.filter((i) => i.subscription_id === url.searchParams.get('subscription_id')) });
        }
        return json(404, { error: { description: `No fake for ${req.method} ${path}` } });
      }

      // ---- Stripe
      if (auth.startsWith('Bearer ')) {
        if (auth !== `Bearer ${STRIPE.secretKey}`) return json(401, { error: { message: 'Invalid API Key provided' } });
        if (!req.headers['stripe-version']) return json(400, { error: { message: 'No API version' } });
        let m: RegExpMatchArray | null;
        if (req.method === 'POST' && path === '/v1/prices') {
          const price = { id: id('price'), object: 'price', currency: body.currency, unit_amount: Number(body.unit_amount), recurring: { interval: body['recurring[interval]'] } };
          st.prices.set(price.id, price);
          return json(200, price);
        }
        if (req.method === 'POST' && path === '/v1/checkout/sessions') {
          const s = {
            id: id('cs_test'), object: 'checkout.session', url: '', price: body['line_items[0][price]'], quantity: Number(body['line_items[0][quantity]']),
            tenantId: body['subscription_data[metadata][tenantId]'], customer: body.customer ?? null, email: body.customer_email ?? null,
            success_url: body.success_url, cancel_url: body.cancel_url, subscription: null as string | null,
          };
          s.url = `${base}/stripe/pay/${s.id}`;
          st.sessions.set(s.id, s);
          return json(200, s);
        }
        if ((m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/)) && req.method === 'GET') {
          const s = st.sessions.get(m[1]);
          return s ? json(200, { id: s.id, object: 'checkout.session', subscription: s.subscription }) : json(404, { error: { message: 'No such checkout.session' } });
        }
        if ((m = path.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
          const sub = st.subs.get(m[1]);
          if (!sub) return json(404, { error: { message: 'No such subscription' } });
          if (req.method === 'GET') return json(200, sub);
          if (req.method === 'DELETE') {
            sub.status = 'canceled';
            return json(200, sub);
          }
          if (req.method === 'POST') {
            const item = sub.items.data[0];
            if (body['items[0][quantity]'] !== undefined) item.quantity = Number(body['items[0][quantity]']);
            if (body['items[0][price]']) item.price = { id: body['items[0][price]'] };
            if (body.cancel_at_period_end !== undefined) sub.cancel_at_period_end = body.cancel_at_period_end === 'true';
            sub.last_proration = body.proration_behavior ?? null;
            return json(200, sub);
          }
        }
        if (req.method === 'GET' && path === '/v1/invoices') return json(200, { object: 'list', data: st.invoices.filter((i) => i.subscription === url.searchParams.get('subscription')) });
        if (req.method === 'POST' && path === '/v1/billing_portal/sessions') return json(200, { id: id('bps'), url: `${base}/stripe/portal/${body.customer}` });
        return json(404, { error: { message: `No fake for ${req.method} ${path}` } });
      }
      return json(401, { error: 'No credentials' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: base,
    calls,
    stop: () => new Promise<void>((r) => server.close(() => r())),
    razorpay: {
      plans: rz.plans,
      subs: rz.subs,
      authorize(subId, method = 'card') {
        const sub = rz.subs.get(subId)!;
        Object.assign(sub, { status: 'active', method, customer_id: sub.customer_id ?? id('cust'), current_start: now(), current_end: now() + 30 * 86400 });
        rzInvoice(sub);
        return sub;
      },
      renew(subId) {
        const sub = rz.subs.get(subId)!;
        if (sub.scheduled) Object.assign(sub, sub.scheduled);
        sub.scheduled = null;
        if (sub.cancel_at_cycle_end) sub.status = 'cancelled';
        Object.assign(sub, { current_start: now(), current_end: now() + 30 * 86400 });
        rzInvoice(sub);
      },
      setStatus(subId, status) {
        rz.subs.get(subId)!.status = status;
      },
    },
    stripe: {
      prices: st.prices,
      sessions: st.sessions,
      subs: st.subs,
      complete(sessionId) {
        const s = st.sessions.get(sessionId)!;
        const sub = {
          id: id('sub'), object: 'subscription', status: 'active', customer: s.customer ?? id('cus'), cancel_at_period_end: false, cancel_at: null,
          metadata: { tenantId: s.tenantId },
          // Billing periods on the item, as in 2025-03-31.basil and later
          items: { data: [{ id: id('si'), price: { id: s.price }, quantity: s.quantity, current_period_end: now() + 30 * 86400 }] },
        };
        st.subs.set(sub.id, sub);
        s.subscription = sub.id;
        stInvoice(sub);
        return sub;
      },
      setStatus(subId, status) {
        st.subs.get(subId)!.status = status;
      },
    },
  };
}

/** A signed webhook delivery, as the provider would send it */
export async function sendWebhook(apiBase: string, provider: 'razorpay' | 'stripe', event: Any, opts: { badSignature?: boolean; eventId?: string } = {}) {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (provider === 'razorpay') {
    headers['x-razorpay-signature'] = createHmac('sha256', opts.badSignature ? 'wrong' : RAZORPAY.webhookSecret).update(body).digest('hex');
    headers['x-razorpay-event-id'] = opts.eventId ?? `evt_${Math.random().toString(36).slice(2)}`;
  } else {
    const t = Math.floor(Date.now() / 1000);
    headers['stripe-signature'] = `t=${t},v1=${createHmac('sha256', opts.badSignature ? 'wrong' : STRIPE.webhookSecret).update(`${t}.${body}`).digest('hex')}`;
  }
  const res = await fetch(`${apiBase}/bff/billing/webhooks/${provider}`, { method: 'POST', headers, body });
  return { status: res.status, json: (await res.json().catch(() => null)) as Any };
}
