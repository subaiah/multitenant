/**
 * Billing (lib/billing/, routes/billing.ts, routes/platform-billing.ts):
 * plan limits, prices made at the providers, subscriptions through Razorpay
 * and Stripe (stand-ins: fake-payments.ts) with signed webhooks, seats that
 * follow the number of people, failed payments and the grace period.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, baseUrl, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';
import { RAZORPAY, STRIPE, sendWebhook, startFakePayments, type FakePayments } from './fake-payments.js';

let pay: FakePayments;
let platform: string;
const base = () => baseUrl();

before(async () => {
  pay = await startFakePayments();
  // Before anything reads the settings: this process and the servers it starts
  Object.assign(process.env, {
    RAZORPAY_KEY_ID: RAZORPAY.keyId, RAZORPAY_KEY_SECRET: RAZORPAY.keySecret, RAZORPAY_WEBHOOK_SECRET: RAZORPAY.webhookSecret, RAZORPAY_API_URL: pay.url,
    STRIPE_SECRET_KEY: STRIPE.secretKey, STRIPE_WEBHOOK_SECRET: STRIPE.webhookSecret, STRIPE_API_URL: pay.url,
    BILLING_GRACE_DAYS: '7',
  });
  const P = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', P.adminEmail)).cookie;
  // Prices to subscribe with: monthly and yearly, in rupees (Razorpay) and dollars (Stripe)
  for (const [plan, inr, usd] of [['STARTER', 49900, 900], ['PROFESSIONAL', 99900, 1900]] as const) {
    for (const [currency, amount] of [['INR', inr], ['USD', usd]] as const) {
      for (const interval of ['MONTH', 'YEAR'] as const) {
        const res = await api('POST', `/platform/billing/plans/${plan}/prices`, { cookie: platform, body: { currency, interval, unitAmount: interval === 'YEAR' ? amount * 10 : amount } });
        assert.equal(res.status, 201, JSON.stringify(res.json));
      }
    }
  }
});
after(async () => {
  await stopServerAndCleanUp();
  await pay.stop();
});

const as = (cookie: string, body?: unknown) => ({ cookie, ...(body === undefined ? {} : { body }) });
const invite = (cookie: string, n: string) => api('POST', '/users', as(cookie, { email: `person-${n}-${Date.now()}@test.local`, name: `Person ${n}` }));
async function setPlan(t: TenantSeed, plan: string, extra: Record<string, unknown> = {}) {
  const { controlDb } = await db();
  await controlDb.tenant.update({ where: { id: t.tenantId }, data: { plan: plan as never, ...extra } });
}
const control = async () => (await db()).controlDb;
const maintenance = async () => (await import('../src/lib/billing/subscriptions.js')).runBillingMaintenance();

test('plan limits: people, organizations, groups, single sign-on, custom domains', async () => {
  const T = await seedTenant('bill-free', undefined, 'FREE');
  const admin = (await loginSession(T.slug, T.adminEmail)).cookie;
  const overview = (await api('GET', '/billing', as(admin))).json;
  assert.equal(overview.plan.code, 'FREE');
  assert.equal(overview.plan.maxUsers, 5);
  const start = overview.usage.users;

  for (let i = start; i < 5; i++) assert.equal((await invite(admin, `ok${i}`)).status, 201);
  const refused = await invite(admin, 'six');
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, 'PLAN_LIMIT');
  assert.match(refused.json.message, /allows 5 users/);

  assert.equal((await api('POST', '/organizations', as(admin, { name: 'First org' }))).status, 201);
  assert.equal((await api('POST', '/organizations', as(admin, { name: 'Second org' }))).json.code, 'PLAN_LIMIT');
  assert.equal((await api('PUT', '/custom-domain', as(admin, { domain: `bill-${Date.now()}.example.com` }))).json.code, 'PLAN_LIMIT');
  assert.equal((await api('POST', '/auth-config/providers', as(admin, { provider: 'GOOGLE', clientId: 'x', clientSecret: 'y' }))).json.code, 'PLAN_LIMIT');

  // A bigger plan lifts them (Professional: single sign-on, no organization limit)
  await setPlan(T, 'PROFESSIONAL');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await invite(admin, 'six-again')).status, 201);
  assert.equal((await api('POST', '/organizations', as(admin, { name: 'Second org' }))).status, 201);

  // Reactivating someone takes a seat again
  await setPlan(T, 'FREE');
  const users = (await api('GET', '/users?limit=100', as(admin))).json.data as { id: string; email: string }[];
  const someone = users.find((u) => u.email.startsWith('person-'))!;
  assert.equal((await api('PATCH', `/users/${someone.id}`, as(admin, { status: 'INACTIVE' }))).status, 200);
  assert.equal((await api('PATCH', `/users/${someone.id}`, as(admin, { status: 'ACTIVE' }))).json.code, 'PLAN_LIMIT');
});

test('platform staff set limits and prices; prices are made at the provider', async () => {
  const plans = (await api('GET', '/platform/billing/plans', as(platform))).json;
  assert.deepEqual(plans.providers.sort(), ['RAZORPAY', 'STRIPE']);
  const starter = plans.plans.find((p: any) => p.code === 'STARTER');
  const inr = starter.prices.find((p: any) => p.currency === 'INR' && p.interval === 'MONTH' && p.active);
  assert.equal(inr.provider, 'RAZORPAY');
  assert.equal(pay.razorpay.plans.get(inr.providerPriceId)!.item.amount, 49900);
  assert.equal(pay.razorpay.plans.get(inr.providerPriceId)!.period, 'monthly');
  const usd = starter.prices.find((p: any) => p.currency === 'USD' && p.interval === 'YEAR' && p.active);
  assert.equal(usd.provider, 'STRIPE');
  assert.equal(pay.stripe.prices.get(usd.providerPriceId)!.unit_amount, 9000);

  // A new price replaces the old one for new subscriptions
  const again = await api('POST', '/platform/billing/plans/STARTER/prices', as(platform, { currency: 'eur', interval: 'MONTH', unitAmount: 800 }));
  assert.equal(again.status, 201);
  const second = await api('POST', '/platform/billing/plans/STARTER/prices', as(platform, { currency: 'EUR', interval: 'MONTH', unitAmount: 850 }));
  const eur = (await api('GET', '/platform/billing/plans', as(platform))).json.plans.find((p: any) => p.code === 'STARTER').prices.filter((p: any) => p.currency === 'EUR');
  assert.deepEqual(eur.map((p: any) => [p.unitAmount, p.active]), [[850, true], [800, false]]);
  assert.equal((await api('DELETE', `/platform/billing/plans/STARTER/prices/${second.json.id}`, as(platform))).status, 204);
  assert.equal((await api('POST', '/platform/billing/plans/FREE/prices', as(platform, { currency: 'USD', interval: 'MONTH', unitAmount: 500 }))).status, 400);

  // Limits and features
  const free = plans.plans.find((p: any) => p.code === 'FREE');
  const changed = await api('PUT', '/platform/billing/plans/FREE', as(platform, { ...free, maxGroups: 7 }));
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.equal(changed.json.maxGroups, 7);
  await api('PUT', '/platform/billing/plans/FREE', as(platform, { ...free }));

  // Not for organizations
  const T = await seedTenant('bill-noplat');
  const admin = (await loginSession(T.slug, T.adminEmail)).cookie;
  assert.equal((await api('GET', '/platform/billing/plans', as(admin))).status, 403);
  assert.equal((await api('PUT', '/platform/billing/plans/FREE', as(admin, { ...free, maxUsers: null }))).status, 403);
});

test('Stripe: checkout, webhook, seats, plan change, cancel, failed payments and the grace period', async () => {
  const T = await seedTenant('bill-stripe', undefined, 'FREE');
  const admin = (await loginSession(T.slug, T.adminEmail)).cookie;
  const before = (await api('GET', '/billing', as(admin))).json;
  assert.equal(before.billingEnabled, true);
  assert.ok(before.plans.find((p: any) => p.code === 'STARTER').prices.some((p: any) => p.currency === 'USD'));

  const checkout = await api('POST', '/billing/checkout', as(admin, { plan: 'STARTER', interval: 'MONTH', currency: 'usd' }));
  assert.equal(checkout.status, 200, JSON.stringify(checkout.json));
  assert.equal(checkout.json.provider, 'STRIPE');
  const sessionId = checkout.json.url.split('/').pop();
  const session = pay.stripe.sessions.get(sessionId)!;
  assert.equal(session.quantity, before.usage.users, 'a seat for each person');
  assert.equal(session.tenantId, T.tenantId);
  assert.match(session.success_url, /\/billing\?checkout=done&session=\{CHECKOUT_SESSION_ID\}$/);

  // The customer pays; Stripe tells us
  const sub = pay.stripe.complete(sessionId);
  const event = { id: `evt_${Date.now()}`, type: 'checkout.session.completed', data: { object: { object: 'checkout.session', id: sessionId, subscription: sub.id } } };
  assert.equal((await sendWebhook(base(), 'stripe', event, { badSignature: true })).status, 400);
  const delivered = await sendWebhook(base(), 'stripe', event);
  assert.equal(delivered.status, 200, JSON.stringify(delivered.json));
  assert.equal((await sendWebhook(base(), 'stripe', event)).json.message, 'Already handled');

  let now = (await api('GET', '/billing', as(admin))).json;
  assert.equal(now.plan.code, 'STARTER');
  assert.equal(now.subscription.status, 'ACTIVE');
  assert.equal(now.subscription.seats, before.usage.users);
  assert.equal(now.subscription.unitAmount, 900);
  assert.ok(now.subscription.currentPeriodEnd);
  assert.equal(now.invoices.length, 1);
  assert.equal(now.invoices[0].amount, 900 * before.usage.users);
  assert.equal(now.invoices[0].currency, 'USD');
  assert.equal((await api('POST', '/billing/checkout', as(admin, { plan: 'PROFESSIONAL', interval: 'MONTH', currency: 'USD' }))).json.code, 'ALREADY_SUBSCRIBED');

  // Seats follow people (prorated straight away at Stripe)
  assert.equal((await invite(admin, 'seat')).status, 201);
  await maintenance();
  assert.equal(sub.items.data[0].quantity, before.usage.users + 1);
  assert.equal(sub.last_proration, 'create_prorations');
  assert.equal((await api('GET', '/billing', as(admin))).json.subscription.seats, before.usage.users + 1);

  // Another plan
  now = (await api('POST', '/billing/change', as(admin, { plan: 'PROFESSIONAL', interval: 'MONTH' }))).json;
  assert.equal(now.plan.code, 'PROFESSIONAL');
  assert.equal(pay.stripe.prices.get(sub.items.data[0].price.id)!.unit_amount, 1900);

  // Stripe's portal for cards and invoices
  assert.match((await api('POST', '/billing/portal', as(admin))).json.url, /\/stripe\/portal\/cus_/);

  // Cancel at the period's end, then change of mind
  now = (await api('POST', '/billing/cancel', as(admin))).json;
  assert.equal(now.subscription.cancelAtPeriodEnd, true);
  assert.equal(sub.cancel_at_period_end, true);
  now = (await api('POST', '/billing/resume', as(admin))).json;
  assert.equal(now.subscription.cancelAtPeriodEnd, false);

  // A payment fails: still working, admins told, grace period shown
  pay.stripe.setStatus(sub.id, 'past_due');
  await sendWebhook(base(), 'stripe', { id: `evt_pd_${Date.now()}`, type: 'customer.subscription.updated', data: { object: { object: 'subscription', id: sub.id } } });
  now = (await api('GET', '/billing', as(admin))).json;
  assert.equal(now.subscription.status, 'PAST_DUE');
  assert.ok(now.subscription.graceEndsAt);
  assert.equal(now.paymentRequiredSince, null);
  assert.equal((await api('POST', '/groups', as(admin, { name: `Still fine ${Date.now()}` }))).status, 201);
  const entries: { event: string }[] = await T.db.auditEvent.findMany({ where: { tenantId: T.tenantId, event: { startsWith: 'billing.' } }, select: { event: true } });
  assert.ok(entries.some((e: { event: string }) => e.event === 'billing.payment_failed'), JSON.stringify(entries));
  assert.ok(entries.some((e: { event: string }) => e.event === 'billing.subscribed'));

  // Past the grace period: read-only, except for sorting out the payment
  await (await control()).subscription.update({ where: { tenantId: T.tenantId }, data: { pastDueSince: new Date(Date.now() - 8 * 86_400_000) } });
  await maintenance();
  const blocked = await api('POST', '/groups', as(admin, { name: `Blocked ${Date.now()}` }));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, 'PAYMENT_REQUIRED');
  assert.equal((await api('GET', '/billing', as(admin))).status, 200);
  assert.equal((await api('POST', '/billing/portal', as(admin))).status, 200);

  // Paid: back to normal
  pay.stripe.setStatus(sub.id, 'active');
  assert.equal((await api('POST', '/billing/refresh', as(admin, {}))).status, 200);
  assert.equal((await api('POST', '/groups', as(admin, { name: `Back ${Date.now()}` }))).status, 201);

  // Platform staff see it, and can't change a paid plan by hand
  const subs = (await api('GET', '/platform/billing/subscriptions', as(platform))).json.subscriptions;
  const mine = subs.find((s: any) => s.tenantId === T.tenantId);
  assert.equal(mine.plan, 'PROFESSIONAL');
  assert.equal(mine.amount, 1900 * (before.usage.users + 1));
  assert.equal((await api('PATCH', `/tenants/${T.tenantId}`, as(platform, { plan: 'ENTERPRISE' }))).json.code, 'SUBSCRIBED');

  // It ends: back to Free
  pay.stripe.setStatus(sub.id, 'canceled');
  await sendWebhook(base(), 'stripe', { id: `evt_end_${Date.now()}`, type: 'customer.subscription.deleted', data: { object: { object: 'subscription', id: sub.id } } });
  now = (await api('GET', '/billing', as(admin))).json;
  assert.equal(now.subscription.status, 'CANCELED');
  assert.equal(now.plan.code, 'FREE');
});

test('Razorpay: an ended trial subscribes in rupees; seats change from the next cycle; UPI', async () => {
  const T = await seedTenant('bill-rzp', undefined, 'STARTER');
  await setPlan(T, 'STARTER', { status: 'TRIAL', trialEndsAt: new Date(Date.now() - 86_400_000) });
  const admin = (await loginSession(T.slug, T.adminEmail)).cookie;
  const ended = await api('POST', '/groups', as(admin, { name: 'During trial' }));
  assert.equal(ended.json.code, 'TRIAL_ENDED');
  assert.match(ended.json.message, /Billing page/);

  // Checkout works while read-only
  const checkout = await api('POST', '/billing/checkout', as(admin, { plan: 'STARTER', interval: 'MONTH', currency: 'INR' }));
  assert.equal(checkout.status, 200, JSON.stringify(checkout.json));
  assert.equal(checkout.json.provider, 'RAZORPAY');
  const subId = checkout.json.url.split('/').pop();
  const sub = pay.razorpay.subs.get(subId)!;
  assert.equal(sub.total_count, 120);
  assert.equal(sub.notes.tenantId, T.tenantId);
  let now = (await api('GET', '/billing', as(admin))).json;
  assert.equal(now.subscription.status, 'INCOMPLETE');
  assert.equal(now.subscription.checkoutUrl, checkout.json.url, 'the link to finish paying');

  // Paid by card; Razorpay tells us
  pay.razorpay.authorize(subId, 'card');
  const event = { entity: 'event', event: 'subscription.activated', contains: ['subscription'], payload: { subscription: { entity: { id: subId } } }, created_at: Math.floor(Date.now() / 1000) };
  assert.equal((await sendWebhook(base(), 'razorpay', event, { badSignature: true })).status, 400);
  assert.equal((await sendWebhook(base(), 'razorpay', event, { eventId: `evt_rzp_${subId}` })).status, 200);
  assert.equal((await sendWebhook(base(), 'razorpay', event, { eventId: `evt_rzp_${subId}` })).json.message, 'Already handled');

  now = (await api('GET', '/billing', as(admin))).json;
  assert.equal(now.subscription.status, 'ACTIVE');
  assert.equal(now.status, 'ACTIVE', 'paying ends the trial');
  assert.equal(now.invoices[0].currency, 'INR');
  assert.equal((await api('POST', '/groups', as(admin, { name: 'After paying' }))).status, 201);

  // Another person: Razorpay bills the new count from the next cycle
  const seatsBefore = now.subscription.seats;
  assert.equal((await invite(admin, 'rzp')).status, 201);
  await maintenance();
  assert.equal(sub.quantity, seatsBefore, 'not changed mid-cycle');
  assert.equal(sub.scheduled.quantity, seatsBefore + 1);
  pay.razorpay.renew(subId);
  await maintenance();
  assert.equal((await api('GET', '/billing', as(admin))).json.subscription.seats, seatsBefore + 1);

  // UPI subscriptions can't be changed: shown, not hidden
  sub.method = 'upi';
  assert.equal((await invite(admin, 'upi')).status, 201);
  await maintenance();
  now = (await api('GET', '/billing', as(admin))).json;
  assert.match(now.subscription.seatSyncError, /UPI/);

  // Cancel at the cycle's end; Razorpay can't undo that
  sub.method = 'card';
  now = (await api('POST', '/billing/cancel', as(admin))).json;
  assert.equal(now.subscription.cancelAtPeriodEnd, true);
  assert.equal(sub.cancel_at_cycle_end, true);
  assert.equal((await api('POST', '/billing/resume', as(admin))).json.code, 'CANNOT_RESUME');
  assert.equal((await api('POST', '/billing/portal', as(admin))).json.code, 'NO_PORTAL');
});

test('who may see and change billing', async () => {
  const T = await seedTenant('bill-who', undefined, 'FREE');
  const user = (await loginSession(T.slug, T.userEmail)).cookie;
  assert.equal((await api('GET', '/billing', as(user))).status, 403);
  assert.equal((await api('POST', '/billing/checkout', as(user, { plan: 'STARTER', interval: 'MONTH', currency: 'USD' }))).status, 403);

  // Another organization's Stripe checkout can't be claimed
  const other = await seedTenant('bill-other', undefined, 'FREE');
  const otherAdmin = (await loginSession(other.slug, other.adminEmail)).cookie;
  const theirs = (await api('POST', '/billing/checkout', as(otherAdmin, { plan: 'STARTER', interval: 'MONTH', currency: 'USD' }))).json;
  const sessionId = theirs.url.split('/').pop();
  pay.stripe.complete(sessionId);
  const admin = (await loginSession(T.slug, T.adminEmail)).cookie;
  assert.equal((await api('POST', '/billing/refresh', as(admin, { session: sessionId }))).status, 403);
  // ...while their own refresh finds it, without waiting for the webhook
  const own = (await api('POST', '/billing/refresh', as(otherAdmin, { session: sessionId }))).json;
  assert.equal(own.subscription.status, 'ACTIVE');
  assert.equal(own.plan.code, 'STARTER');

  // A plan the organization is already too big for
  await (await control()).tenant.update({ where: { id: T.tenantId }, data: { plan: 'ENTERPRISE' } });
  for (let i = 0; i < 3; i++) await invite(admin, `big${i}`);
  await api('PUT', '/platform/billing/plans/STARTER', as(platform, { ...(await api('GET', '/platform/billing/plans', as(platform))).json.plans.find((p: any) => p.code === 'STARTER'), maxUsers: 2 }));
  try {
    const small = await api('POST', '/billing/checkout', as(admin, { plan: 'STARTER', interval: 'MONTH', currency: 'USD' }));
    assert.equal(small.json.code, 'PLAN_TOO_SMALL');
  } finally {
    await api('PUT', '/platform/billing/plans/STARTER', as(platform, { ...(await api('GET', '/platform/billing/plans', as(platform))).json.plans.find((p: any) => p.code === 'STARTER'), maxUsers: 50 }));
  }
});
