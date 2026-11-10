/**
 * Applications publishing events (docs/hub/HUB_GAPS.md G4;
 * lib/product-events.ts): declared in manifest v2 (events.emits and
 * subscribes), published for an organization, delivered signed to the
 * subscribing applications it has on and set up, and to its webhook
 * endpoints that want them; idempotent; and shown to its administrators.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { api, baseUrl, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let B: TenantSeed;
let platform: string;
let admin: string;
let receiver: Server;
let callbackUrl: string;
const received: { path: string; headers: Record<string, unknown>; body: string; json: any }[] = [];
const keys: string[] = [];
const sfx = randomBytes(3).toString('hex');
const crmKey = `crm-${sfx}`;
const chatKey = `chat-${sfx}`;
const opsKey = `ops-${sfx}`;
const WON = `${crmKey}.deal.won`;
let crm: { id: string };
let chat: { id: string; signingSecret: string };
let ops: { id: string };
let token: string; // crm: events.publish
let narrow: string; // crm: organizations.read

const bearer = (t: string, body?: unknown) => ({ headers: { authorization: `Bearer ${t}` }, ...(body === undefined ? {} : { body }) });
const publish = (body: unknown, t = token, org = A.tenantId) => api('POST', `/v1/product-integrations/organizations/${org}/events`, bearer(t, body));

function manifest(key: string, extra: Record<string, unknown> = {}) {
  return {
    manifestVersion: 2, productId: key, name: `App ${key}`, version: '1.0.0', baseUrl: `https://${key}.example.com`,
    signIn: { clientType: 'CONFIDENTIAL', redirectUris: [`https://${key}.example.com/cb`] },
    ...extra,
  };
}
async function importManifest(body: Record<string, unknown>) {
  const res = await api('POST', '/applications/manifest', { cookie: platform, body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  keys.push(body.productId as string);
  return res.json;
}
async function serviceToken(applicationId: string, scopes: string[]) {
  const c = await api('POST', `/applications/${applicationId}/service-credentials`, { cookie: platform, body: { name: scopes.join(' '), scopes } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const t = await fetch(`${baseUrl()}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${c.json.clientId}:${c.json.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: scopes.join(' ') }),
  });
  return ((await t.json()) as { access_token: string }).access_token;
}
async function waitFor<T>(what: string, find: () => T | undefined): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const v = find();
    if (v !== undefined) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

before(async () => {
  process.env.BFF_URL = baseUrl();
  process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let json: any = null;
      try { json = JSON.parse(body); } catch { /* not JSON */ }
      received.push({ path: req.url ?? '', headers: req.headers, body, json });
      // Ops answers its setup with 202 and never reports back: it stays "being set up"
      res.writeHead(req.url === '/ops' && json?.type === 'organization.entitled' ? 202 : 200).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  callbackUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  A = await seedTenant('evt-a');
  B = await seedTenant('evt-b');
  const PS = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', PS.adminEmail)).cookie;
  admin = (await loginSession(A.slug, A.adminEmail)).cookie;

  crm = (await importManifest(manifest(crmKey, {
    events: { emits: [{ type: WON, label: 'Deal won', description: 'A deal was closed as won', schemaUrl: `https://${crmKey}.example.com/schemas/deal.won.json` }] },
  }))).application;
  const c = await importManifest(manifest(chatKey, {
    provisioning: { callbackUrl: `${callbackUrl}/chat` },
    events: { subscribes: [{ type: WON, reason: 'Celebrate in #sales' }] },
  }));
  chat = { id: c.application.id, signingSecret: c.callbackSigningSecret };
  ops = (await importManifest(manifest(opsKey, {
    provisioning: { callbackUrl: `${callbackUrl}/ops` },
    events: { subscribes: [{ type: WON, reason: 'Start onboarding' }] },
  }))).application;

  // A has all three (ops still being set up); B has only the CRM
  for (const id of [crm.id, chat.id, ops.id]) assert.equal((await api('POST', '/tenant-applications', { cookie: admin, body: { applicationId: id, state: 'ENABLED' } })).status, 201);
  const adminB = (await loginSession(B.slug, B.adminEmail)).cookie;
  assert.equal((await api('POST', '/tenant-applications', { cookie: adminB, body: { applicationId: crm.id, state: 'ENABLED' } })).status, 201);
  const { controlDb } = await db();
  await controlDb.tenantApplication.update({ where: { tenantId_applicationId: { tenantId: A.tenantId, applicationId: chat.id } }, data: { provisioningStatus: 'READY' } });
  token = await serviceToken(crm.id, ['events.publish']);
  narrow = await serviceToken(crm.id, ['organizations.read']);
});
after(async () => {
  receiver.close();
  const { controlDb } = await db();
  const apps = await controlDb.applicationRegistry.findMany({ where: { key: { in: keys } }, select: { id: true } });
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: { in: apps.map((a) => a.id) } } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: { in: apps.map((a) => a.id) } } });
  await stopServerAndCleanUp();
});

test('manifest events: published types named for the product, subscriptions to others’; exported as imported', async () => {
  const key = `bad-${sfx}`;
  const problems = async (body: Record<string, unknown>) => {
    const res = await api('POST', '/applications/manifest?dryRun=true', { cookie: platform, body });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    return String(res.json.message);
  };
  assert.match(await problems(manifest(key, { events: { emits: [{ type: 'other.thing', label: 'X' }] } })), /must start with "bad-/);
  assert.match(await problems(manifest(key, { events: { subscribes: [{ type: `${key}.mine`, reason: 'x' }] } })), /this application's own event/);
  assert.match(await problems(manifest(key, { events: { subscribes: [{ type: WON, reason: 'a' }, { type: WON, reason: 'b' }] } })), /listed twice/);
  assert.match(await problems(manifest(key, { events: { subscribes: [{ type: 'nodot', reason: 'a' }] } })), /not an event type/);
  assert.match(await problems({ ...manifest(key), manifestVersion: 1, events: { emits: [] } }), /events: needs "manifestVersion": 2/);
  // An audit type and an event type can't share a name
  assert.match(await problems(manifest(key, { platformServices: { notifications: [], auditEvents: [{ type: `${key}.x`, label: 'X' }] }, events: { emits: [{ type: `${key}.x`, label: 'X' }] } })), /declared twice/);

  const dry = await api('POST', '/applications/manifest?dryRun=true', { cookie: platform, body: manifest(key, { events: { subscribes: [{ type: WON, reason: 'a' }, { type: `nobody-${sfx}.thing`, reason: 'b' }] } }) });
  assert.deepEqual(dry.json.events, { emits: 0, subscribes: 2, notDeclaredYet: [`nobody-${sfx}.thing`] });

  const exported = (await api('GET', `/applications/${crm.id}/manifest`, { cookie: platform })).json;
  assert.deepEqual(exported.events, { emits: [{ type: WON, label: 'Deal won', description: 'A deal was closed as won', schemaUrl: `https://${crmKey}.example.com/schemas/deal.won.json` }], subscribes: [] });
  assert.equal(exported.platformServices.auditEvents.length, 0, 'events aren’t audit types');
});

test('published: to the subscribing application that is on and set up (signed, with the source), and to webhooks that want it; once per key', async () => {
  const hook = await api('POST', '/webhooks', { cookie: admin, body: { url: `${callbackUrl}/hook`, events: [WON] } });
  assert.equal(hook.status, 201, JSON.stringify(hook.json));
  const subject = `${A.tenantId}.${(await A.db.user.findFirstOrThrow({ where: { tenantId: A.tenantId, email: A.userEmail } })).id}`;

  const from = received.length;
  const res = await publish({ type: WON, data: { dealId: 'D-42', amount: 1200 }, subject, idempotencyKey: 'won-D-42' });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.deepEqual([res.json.applications, res.json.webhooks, res.json.duplicate], [1, 1, false], 'chat, not ops (still being set up)');
  assert.match(res.json.id, /^evt_/);

  const toChat = await waitFor('the chat app’s copy', () => received.slice(from).find((r) => r.path === '/chat' && r.json?.type === WON));
  const d = toChat.json.data;
  assert.deepEqual([d.application.key, d.organization.id, d.eventId, d.source, d.subject, d.event], [chatKey, A.tenantId, res.json.id, { productId: crmKey, name: `App ${crmKey}` }, subject, { dealId: 'D-42', amount: 1200 }]);
  assert.equal(d.schemaUrl, `https://${crmKey}.example.com/schemas/deal.won.json`);
  const id = String(toChat.headers['webhook-id']);
  const ts = String(toChat.headers['webhook-timestamp']);
  const expected = createHmac('sha256', Buffer.from(chat.signingSecret.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${toChat.body}`).digest('base64');
  assert.ok(String(toChat.headers['webhook-signature']).split(' ').includes(`v1,${expected}`), 'signed with the chat app’s own secret');

  const toHook = await waitFor('the webhook', () => received.slice(from).find((r) => r.path === '/hook' && r.json?.type === WON));
  assert.deepEqual([toHook.json.id, toHook.json.tenantId, toHook.json.data.application.key, toHook.json.data.event.dealId], [res.json.id, A.tenantId, crmKey, 'D-42']);
  assert.ok(!received.slice(from).some((r) => r.path === '/ops' && r.json?.type === WON), 'not to ops');

  // The same key again: nothing new
  const again = await publish({ type: WON, data: { dealId: 'D-42', amount: 1200 }, idempotencyKey: 'won-D-42' });
  assert.equal(again.status, 200);
  assert.deepEqual([again.json.id, again.json.duplicate], [res.json.id, true]);
  await sleep(500);
  assert.equal(received.slice(from).filter((r) => r.json?.type === WON).length, 2, 'still one copy each');

  // In the chat app's catch-up feed too
  const chatToken = await serviceToken(chat.id, ['organizations.read']);
  const feed = await api('GET', `/v1/product-integrations/events?type=${WON}`, bearer(chatToken));
  assert.equal(feed.json.data.length, 1);
});

test('refused: types it doesn’t declare, organizations without it, the wrong scope, oversized data, strangers as subject', async () => {
  const code = async (r: Promise<{ status: number; json: any }>, status: number, c?: string) => {
    const x = await r;
    assert.equal(x.status, status, JSON.stringify(x.json));
    if (c) assert.equal(x.json.code, c);
  };
  await code(publish({ type: `${crmKey}.deal.lost`, data: {} }), 400, 'UNKNOWN_TYPE');
  await code(publish({ type: `${chatKey}.message`, data: {} }), 400, 'UNKNOWN_TYPE');
  await code(publish({ type: WON, data: { x: 'y'.repeat(70_000) } }), 400);
  await code(publish({ type: WON, data: {}, subject: `${B.tenantId}.someone` }), 400, 'UNKNOWN_RECIPIENTS');
  await code(publish({ type: WON, data: {} }, narrow), 403, 'INSUFFICIENT_SCOPE');
  const other = await seedTenant('evt-c');
  await code(publish({ type: WON, data: {} }, token, other.tenantId), 404);
  // B has the CRM but no subscriber: published to nobody, still fine
  const toNobody = await publish({ type: WON, data: { dealId: 'B-1' } }, token, B.tenantId);
  assert.deepEqual([toNobody.status, toNobody.json.applications, toNobody.json.webhooks], [202, 0, 0]);
});

test('administrators see who publishes what and who receives it; webhooks can subscribe to it', async () => {
  const flows = (await api('GET', '/tenant-applications/events', { cookie: admin })).json.flows;
  const f = flows.find((x: any) => x.type === WON);
  assert.ok(f, JSON.stringify(flows));
  assert.deepEqual([f.label, f.publisher.key, f.webhooks, f.publishedLast30Days], ['Deal won', crmKey, 1, 1]);
  assert.deepEqual(f.receivers.map((r: any) => [r.key, r.reason, r.waiting]), [[chatKey, 'Celebrate in #sales', null], [opsKey, 'Start onboarding', 'still being set up']]);

  const catalog = (await api('GET', '/webhooks/events', { cookie: admin })).json.events;
  assert.ok(catalog.some((e: any) => e.type === WON && e.category === 'application' && e.label === `App ${crmKey}: Deal won`));
});
