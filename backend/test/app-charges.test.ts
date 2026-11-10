/**
 * Charging for applications on the organization's subscription
 * (docs/hub/HUB_GAPS.md G6; lib/billing/app-charges.ts): platform staff
 * price an application (flat or per seat) and its meters; when a period ends,
 * its charges go on the next invoice (Razorpay add-ons, Stripe invoice
 * items), once each; failures are retried; administrators see the estimate
 * and past charges. Against the payment stand-ins (fake-payments.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { api, baseUrl, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';
import { RAZORPAY, STRIPE, sendWebhook, startFakePayments, type FakePayments } from './fake-payments.js';

let pay: FakePayments;
let platform: string;
const sfx = randomBytes(3).toString('hex');
const key = `forge-${sfx}`;
const trialKey = `trial-${sfx}`;
let app: { id: string };
let trialApp: { id: string };
let token: string; // usage.report

const as = (cookie: string, body?: unknown) => ({ cookie, ...(body === undefined ? {} : { body }) });
const maintenance = async () => (await import('../src/lib/billing/subscriptions.js')).runBillingMaintenance();
const manifest = (k: string, extra: Record<string, unknown> = {}) => ({
  manifestVersion: 2, productId: k, name: `App ${k}`, version: '1.0.0', baseUrl: `https://${k}.example.com`,
  signIn: { clientType: 'CONFIDENTIAL', redirectUris: [`https://${k}.example.com/cb`] }, ...extra,
});

before(async () => {
  pay = await startFakePayments();
  Object.assign(process.env, {
    RAZORPAY_KEY_ID: RAZORPAY.keyId, RAZORPAY_KEY_SECRET: RAZORPAY.keySecret, RAZORPAY_WEBHOOK_SECRET: RAZORPAY.webhookSecret, RAZORPAY_API_URL: pay.url,
    STRIPE_SECRET_KEY: STRIPE.secretKey, STRIPE_WEBHOOK_SECRET: STRIPE.webhookSecret, STRIPE_API_URL: pay.url,
  });
  const P = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', P.adminEmail)).cookie;
  for (const [currency, amount] of [['INR', 49900], ['USD', 900]] as const) {
    const res = await api('POST', '/platform/billing/plans/STARTER/prices', as(platform, { currency, interval: 'MONTH', unitAmount: amount }));
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
  const a = await api('POST', '/applications/manifest', as(platform, manifest(key, { usage: [{ key: `${key}.tokens`, label: 'AI tokens', unit: 'tokens' }] })));
  assert.equal(a.status, 201, JSON.stringify(a.json));
  app = { id: a.json.application.id };
  const t = await api('POST', '/applications/manifest', as(platform, manifest(trialKey)));
  trialApp = { id: t.json.application.id };
  const c = await api('POST', `/applications/${app.id}/service-credentials`, as(platform, { name: 'Server', scopes: ['usage.report'] }));
  const tok = await fetch(`${baseUrl()}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${c.json.clientId}:${c.json.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'usage.report' }),
  });
  token = ((await tok.json()) as { access_token: string }).access_token;
});
after(async () => {
  const { controlDb } = await db();
  await controlDb.billingPrice.deleteMany({ where: { providerPriceId: { in: [...pay.razorpay.plans.keys(), ...pay.stripe.prices.keys()] } } });
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: { in: [app?.id, trialApp?.id].filter(Boolean) } } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: { in: [app?.id, trialApp?.id].filter(Boolean) } } });
  await stopServerAndCleanUp();
  await pay.stop();
});

async function onFor(T: TenantSeed, admin: string) {
  assert.equal((await api('POST', '/tenant-applications', as(admin, { applicationId: app.id, state: 'ENABLED' }))).status, 201);
  assert.equal((await api('POST', '/tenant-applications', as(admin, { applicationId: trialApp.id, state: 'TRIAL' }))).status, 201);
}
const report = (T: TenantSeed, quantity: number, idempotencyKey: string) =>
  api('POST', `/v1/product-integrations/organizations/${T.tenantId}/usage`, { headers: { authorization: `Bearer ${token}` }, body: { key: `${key}.tokens`, quantity, idempotencyKey } });

test('platform staff price an application and its meters; mistakes refused; audited', async () => {
  const bad = async (body: unknown, re: RegExp) => {
    const r = await api('PUT', `/applications/${app.id}/prices`, as(platform, body));
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(JSON.stringify(r.json), re);
  };
  await bad({ prices: [{ currency: 'INR', interval: 'MONTH', model: 'flat', unitAmount: 1 }, { currency: 'inr', interval: 'MONTH', model: 'per_seat', unitAmount: 2 }] }, /Two prices for INR MONTH/);
  await bad({ prices: [], meters: [{ key: `${key}.storage`, currency: 'INR', unitAmount: 1 }] }, /isn't one of this application's meters/);
  await bad({ prices: [{ currency: 'RUPEES', interval: 'MONTH', model: 'flat', unitAmount: 1 }] }, /three-letter/);

  const set = await api('PUT', `/applications/${app.id}/prices`, as(platform, {
    prices: [
      { currency: 'INR', interval: 'MONTH', model: 'per_seat', unitAmount: 10000 },
      { currency: 'USD', interval: 'MONTH', model: 'flat', unitAmount: 500 },
    ],
    meters: [
      { key: `${key}.tokens`, currency: 'INR', unitAmount: 100, perQuantity: 1000, includedQuantity: 1000 },
      { key: `${key}.tokens`, currency: 'USD', unitAmount: 2, perQuantity: 1000 },
    ],
  }));
  assert.equal(set.status, 200, JSON.stringify(set.json));
  // The trial app has a price too: a trial isn't charged
  assert.equal((await api('PUT', `/applications/${trialApp.id}/prices`, as(platform, { prices: [{ currency: 'INR', interval: 'MONTH', model: 'flat', unitAmount: 7777 }] }))).status, 200);
  const read = (await api('GET', `/applications/${app.id}/prices`, as(platform))).json;
  assert.ok(read.currencies.includes('INR') && read.currencies.includes('USD'));
  assert.deepEqual(read.meters[0].prices.map((p: any) => [p.currency, p.unitAmount, p.perQuantity, p.includedQuantity]), [['INR', 100, 1000, 1000], ['USD', 2, 1000, 0]]);
  assert.ok(JSON.stringify((await api('GET', '/platform-audit?limit=20', as(platform))).json).includes('application.prices_changed'));
});

test('Razorpay: the period ends, its charges become add-ons on the next invoice, once; a refused one is retried', async () => {
  const T = await seedTenant(`chg-rzp`, undefined, 'FREE');
  const admin = (await loginSession(T.slug, T.adminEmail)).cookie;
  await onFor(T, admin);
  const checkout = await api('POST', '/billing/checkout', as(admin, { plan: 'STARTER', interval: 'MONTH', currency: 'INR' }));
  assert.equal(checkout.status, 200, JSON.stringify(checkout.json));
  const subId = checkout.json.url.split('/').pop();
  pay.razorpay.authorize(subId, 'card');
  const activated = { entity: 'event', event: 'subscription.activated', contains: ['subscription'], payload: { subscription: { entity: { id: subId } } }, created_at: Math.floor(Date.now() / 1000) };
  assert.equal((await sendWebhook(baseUrl(), 'razorpay', activated, { eventId: `evt_a_${subId}` })).status, 200);
  const seats = pay.razorpay.subs.get(subId)!.quantity;

  assert.equal((await report(T, 2000, 'u1')).status, 202);
  assert.equal((await report(T, 1500, 'u2')).status, 202);
  // The estimate: per seat, and usage over the allowance (3500 - 1000 = 2500 → 3 lots of 1000)
  let billing = (await api('GET', '/billing', as(admin))).json.applications;
  assert.deepEqual(billing.estimate.lines.map((l: any) => [l.kind, l.amount]), [['base', 10000 * seats], ['usage', 300]], 'not the trial app');
  assert.equal(billing.estimate.total, 10000 * seats + 300);
  assert.equal(billing.estimate.currency, 'INR');

  // The cycle ends, but Razorpay refuses add-ons for now (halted): recorded, failed
  pay.razorpay.renew(subId);
  pay.razorpay.setStatus(subId, 'halted');
  await maintenance();
  const { controlDb } = await db();
  let rows = await controlDb.applicationCharge.findMany({ where: { tenantId: T.tenantId }, orderBy: { kind: 'asc' } });
  assert.deepEqual(rows.map((r) => [r.kind, r.amount, r.status]), [['base', 10000 * seats, 'FAILED'], ['usage', 300, 'FAILED']]);
  assert.equal(pay.razorpay.addons.filter((a) => a.subscription_id === subId).length, 0);

  // Active again: the hourly pass sends them
  pay.razorpay.setStatus(subId, 'active');
  await maintenance();
  const addons = pay.razorpay.addons.filter((a) => a.subscription_id === subId);
  assert.deepEqual(addons.map((a) => [a.item.amount, a.item.currency]).sort(), [[300, 'INR'], [10000 * seats, 'INR']].sort());
  assert.match(addons.find((a) => a.item.amount === 300).item.name, new RegExp(`App ${key}: 3,500 tokens`));
  rows = await controlDb.applicationCharge.findMany({ where: { tenantId: T.tenantId } });
  assert.ok(rows.every((r) => r.status === 'ADDED' && r.providerChargeId?.startsWith('ao_')));

  // Again: nothing more
  await maintenance();
  assert.equal(pay.razorpay.addons.filter((a) => a.subscription_id === subId).length, 2);
  billing = (await api('GET', '/billing', as(admin))).json.applications;
  assert.deepEqual(billing.charges.map((c: any) => c.status), ['ADDED', 'ADDED']);
  assert.deepEqual(billing.estimate.lines.map((l: any) => l.kind), ['base'], 'the new period: no usage yet');
});

test('Stripe: invoice items on the next invoice, with an idempotency key; flat price and usage', async () => {
  const T = await seedTenant(`chg-st`, undefined, 'FREE');
  const admin = (await loginSession(T.slug, T.adminEmail)).cookie;
  await onFor(T, admin);
  const checkout = await api('POST', '/billing/checkout', as(admin, { plan: 'STARTER', interval: 'MONTH', currency: 'USD' }));
  const sessionId = checkout.json.url.split('/').pop();
  const sub = pay.stripe.complete(sessionId);
  const event = { id: `evt_${Date.now()}_${sfx}`, type: 'checkout.session.completed', data: { object: { object: 'checkout.session', id: sessionId, subscription: sub.id } } };
  assert.equal((await sendWebhook(baseUrl(), 'stripe', event)).status, 200);
  assert.equal((await report(T, 1500, 's1')).status, 202);

  pay.stripe.renew(sub.id);
  const renewed = { id: `evt_r_${Date.now()}_${sfx}`, type: 'invoice.paid', data: { object: { object: 'invoice', subscription: sub.id } } };
  assert.equal((await sendWebhook(baseUrl(), 'stripe', renewed)).status, 200);
  const items = pay.stripe.invoiceItems.filter((i) => i.subscription === sub.id);
  assert.deepEqual(items.map((i) => [i.amount, i.currency, i.customer]).sort(), [[4, 'usd', sub.customer], [500, 'usd', sub.customer]].sort(), 'flat $5, and 1500 tokens → 2 lots of 1000 at 2¢');
  const calls = pay.calls.filter((c) => c.path === '/v1/invoiceitems');
  assert.ok(calls.length >= 2);

  // A charge stuck in SENDING (a crash mid-call) is retried for Stripe: the key makes it one item
  const { controlDb } = await db();
  const one = await controlDb.applicationCharge.findFirstOrThrow({ where: { tenantId: T.tenantId, kind: 'base' } });
  await controlDb.applicationCharge.update({ where: { id: one.id }, data: { status: 'SENDING', updatedAt: new Date(Date.now() - 2 * 3600_000) } });
  await maintenance();
  assert.equal(pay.stripe.invoiceItems.filter((i) => i.subscription === sub.id).length, 2, 'the same item, not a second');
  assert.equal((await controlDb.applicationCharge.findUniqueOrThrow({ where: { id: one.id } })).status, 'ADDED');
});
