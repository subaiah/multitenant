/**
 * Lifecycle events for external products (lib/product-lifecycle.ts): a local
 * receiver plays the product. Events arrive signed and in order; the answer
 * (2xx, 202 then a report, or failures) sets the organization's setup status,
 * which the Applications page and the sidebar wait for.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { api, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type PlatformSeed, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let P: PlatformSeed;
let platform: string;
let adminA: string;
let receiver: Server;
let callbackUrl: string;
let answer = 200;
const received: { headers: Record<string, string | string[] | undefined>; body: string; json: any }[] = [];
const productIds: string[] = [];

before(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body, json: JSON.parse(body || 'null') });
      res.writeHead(answer).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  callbackUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/platform-events`;
  A = await seedTenant('lc-a');
  P = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', P.adminEmail)).cookie;
  adminA = (await loginSession(A.slug, A.adminEmail)).cookie;
});
after(async () => {
  receiver.close();
  const { controlDb } = await db();
  const apps = await controlDb.applicationRegistry.findMany({ where: { key: { in: productIds } }, select: { id: true } });
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: { in: apps.map((a) => a.id) } } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: { in: apps.map((a) => a.id) } } });
  await stopServerAndCleanUp();
});

const eventually = async <T>(what: string, check: () => T | undefined | Promise<T | undefined>, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await check();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const eventsFor = (productId: string, tenantId = A.tenantId) =>
  received.filter((r) => r.json?.data?.application?.key === productId && r.json?.data?.organization?.id === tenantId);

async function importProduct(provisioning: Record<string, unknown> | null = { callbackUrl, deletesDataOnDeprovision: true }) {
  const productId = `life-${randomBytes(3).toString('hex')}`;
  productIds.push(productId);
  const res = await api('POST', '/applications/manifest', {
    cookie: platform,
    body: {
      manifestVersion: 1, productId, name: `Life ${productId}`, version: '1.0.0', baseUrl: 'https://life.example.com',
      signIn: { clientType: 'CONFIDENTIAL', redirectUris: ['https://life.example.com/cb'], openPath: '/login' },
      ...(provisioning && { provisioning }),
      menu: [{ label: 'Home', path: '/home' }],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { productId, id: res.json.application.id as string, clientId: res.json.clientId as string, clientSecret: res.json.clientSecret as string, signingSecret: res.json.callbackSigningSecret as string | undefined };
}
const turnOn = async (applicationId: string, state = 'ENABLED') => {
  const res = await api('POST', '/tenant-applications', { cookie: adminA, body: { applicationId, state } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id as string;
};
const setup = async (applicationId: string) => {
  const { controlDb } = await db();
  return (await controlDb.tenantApplication.findFirst({ where: { tenantId: A.tenantId, applicationId } }))?.provisioningStatus;
};
const launchpadEntry = async (applicationId: string) =>
  (await api('GET', '/tenant-applications/launchpad', { cookie: adminA })).json.applications.find((a: { id: string }) => a.id === applicationId);
const hasSidebarSection = async (productId: string) =>
  (await api('GET', '/menu-items/portal/TENANT', { cookie: adminA })).json.menuItems.some((i: { path: string }) => i.path === `#app-${productId}`);
const report = (p: { clientId: string; clientSecret: string }, tenantId: string, body: unknown, secret = p.clientSecret) =>
  api('POST', `/product-api/organizations/${tenantId}/provisioning`, {
    headers: { authorization: `Basic ${Buffer.from(`${p.clientId}:${secret}`).toString('base64')}` },
    body,
  });

test('turned on: organization.entitled arrives signed; a 2xx answer means set up', async () => {
  answer = 200;
  const p = await importProduct();
  assert.match(p.signingSecret ?? '', /^whsec_/, 'the signing secret, once');
  await turnOn(p.id);
  const [e] = await eventually('entitled', () => (eventsFor(p.productId).length ? eventsFor(p.productId) : undefined));
  assert.equal(e.json.type, 'organization.entitled');
  assert.equal(e.json.data.organization.slug, A.slug);
  assert.equal(e.json.data.entitlement.state, 'ENABLED');
  assert.equal(e.headers['user-agent'], 'Multitenant-Lifecycle/1');
  // Standard Webhooks signature with the product's secret
  const id = e.headers['webhook-id'] as string;
  const ts = e.headers['webhook-timestamp'] as string;
  const expected = createHmac('sha256', Buffer.from(p.signingSecret!.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${e.body}`).digest('base64');
  assert.equal(e.headers['webhook-signature'], `v1,${expected}`);
  assert.equal(id, e.json.id);

  await eventually('ready', async () => (await setup(p.id)) === 'READY' || undefined);
  const entry = await launchpadEntry(p.id);
  assert.equal(entry.setup, 'READY');
  assert.match(entry.openUrl, /^https:\/\/life\.example\.com\/login\?iss=/);
  assert.equal(await hasSidebarSection(p.productId), true);
});

test('202 then a report: Open and the sidebar wait until the product says it is ready', async () => {
  answer = 202;
  const p = await importProduct();
  await turnOn(p.id);
  await eventually('entitled', () => eventsFor(p.productId)[0]);
  await sleep(300);
  assert.equal(await setup(p.id), 'PENDING');
  const waiting = await launchpadEntry(p.id);
  assert.equal(waiting.setup, 'PENDING');
  assert.equal(waiting.openUrl, null);
  assert.equal(await hasSidebarSection(p.productId), false);

  // Only the product itself can report
  assert.equal((await report(p, A.tenantId, { status: 'READY' }, 'wrong')).status, 401);
  assert.equal((await api('POST', `/product-api/organizations/${A.tenantId}/provisioning`, { body: { status: 'READY' } })).status, 401);
  assert.equal((await report(p, '00000000-0000-4000-8000-000000000000', { status: 'READY' })).status, 404);

  // It failed, then it worked
  assert.equal((await report(p, A.tenantId, { status: 'FAILED', message: 'Quota exceeded' })).status, 204);
  const failed = await launchpadEntry(p.id);
  assert.equal(failed.setup, 'FAILED');
  assert.equal(failed.setupError, 'Quota exceeded');
  assert.equal((await report(p, A.tenantId, { status: 'READY' })).status, 204);
  assert.equal((await launchpadEntry(p.id)).setup, 'READY');
  assert.equal(await hasSidebarSection(p.productId), true);
  answer = 200;
});

test('changes, suspension and resumption arrive in order; removing it tells the product to clean up', async () => {
  answer = 200;
  const p = await importProduct();
  const entitlementId = await turnOn(p.id);
  await eventually('ready', async () => (await setup(p.id)) === 'READY' || undefined);
  assert.equal((await api('PATCH', `/tenant-applications/${entitlementId}`, { cookie: adminA, body: { state: 'TRIAL' } })).status, 200);
  assert.equal((await api('PATCH', `/tenants/${A.tenantId}`, { cookie: platform, body: { status: 'SUSPENDED' } })).status, 200);
  assert.equal((await api('PATCH', `/tenants/${A.tenantId}`, { cookie: platform, body: { status: 'ACTIVE' } })).status, 200);
  adminA = (await loginSession(A.slug, A.adminEmail)).cookie;
  assert.equal((await api('DELETE', `/tenant-applications/${entitlementId}`, { cookie: adminA })).status, 204);

  const all = await eventually('five events', () => (eventsFor(p.productId).length >= 5 ? eventsFor(p.productId) : undefined));
  assert.deepEqual(all.map((e) => e.json.type), [
    'organization.entitled', 'organization.entitlement_changed', 'organization.suspended', 'organization.resumed', 'organization.deprovisioned',
  ]);
  assert.equal(all[1].json.data.entitlement.state, 'TRIAL');
  assert.equal(all[2].json.data.organization.suspended, true);
  assert.equal(all[4].json.data.reason, 'entitlement_removed');
  assert.equal(all[4].json.data.deleteData, true);
  assert.equal(all[4].json.data.entitlement, null);
});

test('failures are retried later, and later events for that organization wait; platform staff can retry now', async () => {
  answer = 500;
  const p = await importProduct();
  const entitlementId = await turnOn(p.id);
  await eventually('first attempt', () => eventsFor(p.productId)[0]);
  await sleep(300);
  const lifecycle = await api('GET', `/applications/${p.id}/lifecycle`, { cookie: platform });
  assert.equal(lifecycle.status, 200);
  const first = lifecycle.json.events[0];
  assert.equal(first.status, 'PENDING');
  assert.equal(first.attempts, 1);
  assert.equal(first.lastStatus, 500);
  assert.ok(new Date(first.nextAttemptAt).getTime() > Date.now(), 'tried again later');
  assert.equal(await setup(p.id), 'PENDING');

  // A later change waits behind it
  await api('PATCH', `/tenant-applications/${entitlementId}`, { cookie: adminA, body: { state: 'TRIAL' } });
  await sleep(500);
  assert.equal(eventsFor(p.productId).length, 1, 'nothing out of order');

  // Fixed: platform staff retry, and both go, in order
  answer = 200;
  assert.equal((await api('POST', `/applications/${p.id}/lifecycle/events/${first.id}/retry`, { cookie: platform })).status, 202);
  const both = await eventually('both', () => (eventsFor(p.productId).length >= 3 ? eventsFor(p.productId) : undefined));
  assert.deepEqual(both.map((e) => e.json.type), ['organization.entitled', 'organization.entitled', 'organization.entitlement_changed']);
  assert.equal(both[0].json.id, both[1].json.id, 'the same event, delivered again');
  await eventually('ready', async () => (await setup(p.id)) === 'READY' || undefined);
});

test('a product without a callback needs no setup; adding one tells the organizations that have it', async () => {
  answer = 200;
  const p = await importProduct(null);
  assert.equal(p.signingSecret, undefined);
  await turnOn(p.id);
  await sleep(300);
  assert.equal(await setup(p.id), 'NOT_REQUIRED');
  assert.equal(eventsFor(p.productId).length, 0);
  assert.equal((await launchpadEntry(p.id)).setup, 'READY');

  const set = await api('PUT', `/applications/${p.id}/lifecycle`, { cookie: platform, body: { callbackUrl, deletesDataOnDeprovision: false } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.match(set.json.signingSecret, /^whsec_/);
  assert.equal(set.json.organizationsTold, 1);
  const [e] = await eventually('entitled', () => eventsFor(p.productId)[0] && eventsFor(p.productId));
  assert.equal(e.json.type, 'organization.entitled');
  await eventually('ready', async () => (await setup(p.id)) === 'READY' || undefined);

  // Tenants can't see or change it
  assert.equal((await api('GET', `/applications/${p.id}/lifecycle`, { cookie: adminA })).status, 403);
  // Removed: nothing to wait for
  const off = await api('PUT', `/applications/${p.id}/lifecycle`, { cookie: platform, body: { callbackUrl: null } });
  assert.equal(off.status, 200);
});

test('deleting an organization tells its products to clean up', async () => {
  answer = 200;
  const p = await importProduct();
  const C = await seedTenant('lc-c');
  const { controlDb } = await db();
  await controlDb.tenantApplication.create({ data: { tenantId: C.tenantId, applicationId: p.id, state: 'ENABLED' } });
  const { deprovisionTenant } = await import('../src/lib/provisioning.js');
  await deprovisionTenant(C.tenantId);
  const [e] = await eventually('deprovisioned', () => eventsFor(p.productId, C.tenantId)[0] && eventsFor(p.productId, C.tenantId));
  assert.equal(e.json.type, 'organization.deprovisioned');
  assert.equal(e.json.data.reason, 'organization_deleted');
  assert.equal(e.json.data.organization.slug, C.slug);
  assert.equal(e.json.data.deleteData, true);
});
