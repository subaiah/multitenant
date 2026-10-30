/**
 * Other systems and the organization: API keys (lib/api-keys.ts) and
 * outgoing webhooks (lib/webhooks.ts), against a local receiver.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { api, loginSession, seedTenant, startExtraServer, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let B: TenantSeed;
let admin: string;
let receiver: Server;
let receiverUrl: string;
let answer = 200;
const received: { headers: Record<string, string | string[] | undefined>; body: string; json: any }[] = [];

before(async () => {
  // Webhooks go to this machine in the tests: allowed for them only
  process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body, json: JSON.parse(body || 'null') });
      res.writeHead(answer).end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;
  A = await seedTenant('keys-a');
  B = await seedTenant('keys-b');
  await startServer();
  admin = (await loginSession(A.slug, A.adminEmail)).cookie;
});
after(async () => {
  receiver.close();
  await stopServerAndCleanUp();
});

const as = (cookie: string, body?: unknown) => ({ cookie, ...(body === undefined ? {} : { body }) });
const withKey = (key: string, body?: unknown, extra: Record<string, string> = {}) => ({ headers: { authorization: `Bearer ${key}`, ...extra }, ...(body === undefined ? {} : { body }) });
const eventually = async <T>(what: string, check: () => T | undefined | Promise<T | undefined>, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await check();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const makeKey = async (permissions: string[], name = 'Integration') => {
  const res = await api('POST', '/api-keys', as(admin, { name, permissions }));
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json as { id: string; key: string; hint: string };
};

test('an API key works with its own permissions, and only those', async () => {
  const k = await makeKey(['users:read', 'groups:read', 'groups:create']);
  assert.match(k.key, /^mtk_[\w-]{22}_[\w-]{22}_[\w-]{32}$/);
  assert.equal(k.hint, k.key.slice(-4));

  assert.equal((await api('GET', '/users', withKey(k.key))).status, 200);
  const made = await api('POST', '/groups', withKey(k.key, { name: `Made by key ${Date.now()}` }));
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal((await api('POST', '/users', withKey(k.key, { email: `k-${Date.now()}@test.local`, name: 'Nope' }))).status, 403);
  assert.equal((await api('GET', '/users', { headers: { 'x-api-key': k.key } })).status, 200, 'X-API-Key works too');

  // Not a person: no own-account routes, no platform routes
  const mine = await api('GET', '/bff/my-account', withKey(k.key));
  assert.equal(mine.status, 403);
  assert.equal(mine.json.code, 'NOT_FOR_API_KEYS');
  assert.equal((await api('GET', '/platform/billing/plans', withKey(k.key))).status, 403);
  // Its own organization only
  assert.equal((await api('GET', '/users', withKey(k.key, undefined, { 'x-tenant-id': B.tenantId }))).status, 403);

  // The audit log says it was the key
  const entry = await A.db.auditEvent.findFirst({ where: { tenantId: A.tenantId, event: 'group.created', actorType: 'API_KEY' }, orderBy: { seq: 'desc' } });
  assert.ok(entry, 'recorded as the key');
  assert.equal(entry!.actorId, k.id);
  assert.match(entry!.actorEmail ?? '', /API key "Integration"/);

  // Listed without its secret, with when it was used
  const listed = (await api('GET', '/api-keys', as(admin))).json.keys.find((x: any) => x.id === k.id);
  assert.equal(listed.key, undefined);
  assert.equal(listed.status, 'ACTIVE');
  assert.ok(listed.lastUsedAt);
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(k.key.split('_').pop()!));
});

test("a key can't have more than its maker, or make keys, or pay", async () => {
  for (const p of ['api:manage', 'billing:manage', 'tenants:manage', 'no-such:thing']) {
    const res = await api('POST', '/api-keys', as(admin, { name: 'Too much', permissions: [p] }));
    assert.equal(res.status, 403, p);
    assert.equal(res.json.code, 'NOT_GRANTABLE');
  }
  const offered = (await api('GET', '/api-keys/permissions', as(admin))).json.groups.flatMap((g: any) => g.permissions.map((p: any) => p.name));
  assert.ok(offered.includes('users:read'));
  assert.ok(!offered.includes('api:manage') && !offered.includes('billing:manage') && !offered.some((p: string) => p.startsWith('tenants:')));
  // People without api:manage can't make keys
  const user = (await loginSession(A.slug, A.userEmail)).cookie;
  assert.equal((await api('POST', '/api-keys', as(user, { name: 'x', permissions: ['users:read'] }))).status, 403);
});

test('wrong, revoked and expired keys are refused', async () => {
  const k = await makeKey(['users:read']);
  const wrong = `${k.key.slice(0, -3)}AAA`;
  const bad = await api('GET', '/users', withKey(wrong));
  assert.equal(bad.status, 401);
  assert.equal(bad.json.code, 'INVALID_API_KEY');
  assert.equal((await api('GET', '/users', withKey('mtk_nonsense'))).status, 401);

  await A.db.apiKey.update({ where: { id: k.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await api('GET', '/users', withKey(k.key))).json.code, 'API_KEY_EXPIRED');
  await A.db.apiKey.update({ where: { id: k.id }, data: { expiresAt: null } });
  assert.equal((await api('GET', '/users', withKey(k.key))).status, 200);

  assert.equal((await api('DELETE', `/api-keys/${k.id}`, as(admin))).status, 204);
  assert.equal((await api('GET', '/users', withKey(k.key))).json.code, 'API_KEY_REVOKED');
  assert.equal((await api('GET', '/api-keys', as(admin))).json.keys.find((x: any) => x.id === k.id).status, 'REVOKED');
});

function verify(secret: string, r: (typeof received)[number]) {
  const id = String(r.headers['webhook-id']);
  const ts = String(r.headers['webhook-timestamp']);
  const expected = `v1,${createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${r.body}`).digest('base64')}`;
  return r.headers['webhook-signature'] === expected;
}

test('webhooks: subscribed events arrive signed; others do not', async () => {
  const created = await api('POST', '/webhooks', as(admin, { url: receiverUrl, events: ['group.created'], description: 'CRM sync' }));
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const { id, secret } = created.json;
  assert.match(secret, /^whsec_/);
  // Encrypted at rest
  const row = await A.db.webhookEndpoint.findFirstOrThrow({ where: { id } });
  assert.notEqual(row.signingSecret, secret);
  assert.equal((await api('GET', '/webhooks', as(admin))).json.endpoints[0].secret, undefined);

  const name = `Hooked ${Date.now()}`;
  const before = received.length;
  assert.equal((await api('POST', '/groups', as(admin, { name }))).status, 201);
  await api('POST', '/users', as(admin, { email: `hook-${Date.now()}@test.local`, name: 'Not sent' }));
  const got = await eventually('the delivery', () => received.slice(before).find((r) => r.json?.type === 'group.created' && r.json.data.resource.label === name));
  assert.ok(verify(secret, got), 'signature checks out');
  assert.match(String(got.headers['webhook-id']), /^evt_[0-9a-f]{32}$/);
  assert.equal(got.json.id, got.headers['webhook-id']);
  assert.equal(got.json.tenantId, A.tenantId);
  assert.equal(got.json.data.actor.email, A.adminEmail);
  await sleep(300);
  assert.equal(received.slice(before).filter((r) => r.json?.type === 'user.invited').length, 0, 'not subscribed');

  const deliveries = (await api('GET', `/webhooks/${id}/deliveries`, as(admin))).json.deliveries;
  assert.equal(deliveries[0].status, 'DELIVERED');
  assert.equal(deliveries[0].responseStatus, 200);

  // A test event, answered at once
  const t = (await api('POST', `/webhooks/${id}/test`, as(admin))).json;
  assert.equal(t.ok, true);
  assert.equal(t.status, 200);
  assert.ok(received.some((r) => r.json?.type === 'webhook.test'));

  // A new secret: the old one no longer verifies
  const rotated = (await api('POST', `/webhooks/${id}/rotate-secret`, as(admin))).json.secret;
  const n = received.length;
  await api('POST', `/webhooks/${id}/test`, as(admin));
  assert.ok(verify(rotated, received[n]) && !verify(secret, received[n]));
  await api('DELETE', `/webhooks/${id}`, as(admin));
});

test('webhooks: failures are retried with backoff, and an endpoint that keeps failing is turned off', async () => {
  const { id } = (await api('POST', '/webhooks', as(admin, { url: receiverUrl, events: ['*'] }))).json;
  answer = 500;
  try {
    const name = `Failing ${Date.now()}`;
    await api('POST', '/groups', as(admin, { name }));
    const failed = await eventually('a failed attempt', async () => {
      const d = (await api('GET', `/webhooks/${id}/deliveries`, as(admin))).json.deliveries.find((x: any) => x.type === 'group.created' && x.payload.data.resource.label === name);
      return d?.attempts === 1 && d.status === 'PENDING' ? d : undefined;
    });
    assert.equal(failed.responseStatus, 500);
    assert.equal(failed.lastError, 'Answered 500');
    assert.ok(new Date(failed.nextAttemptAt).getTime() > Date.now() + 30_000, 'the next try is a minute away');

    // Working again: send it now rather than wait
    answer = 204;
    assert.equal((await api('POST', `/webhooks/deliveries/${failed.id}/retry`, as(admin))).status, 202);
    await eventually('the retry', async () => (await api('GET', `/webhooks/${id}/deliveries`, as(admin))).json.deliveries.find((x: any) => x.id === failed.id && x.status === 'DELIVERED'));

    // The last attempt of a delivery fails, after earlier deliveries gave up too
    answer = 500;
    const { DISABLE_AFTER, MAX_ATTEMPTS, processWebhooks } = await import('../src/lib/webhooks.js');
    await A.db.webhookEndpoint.update({ where: { id }, data: { consecutiveFailures: DISABLE_AFTER - 1 } });
    await api('POST', '/groups', as(admin, { name: `Last straw ${Date.now()}` }));
    const last = await eventually('the next delivery', async () => (await A.db.webhookDelivery.findFirst({ where: { endpointId: id, type: 'group.created', status: 'PENDING', attempts: { gte: 1 } }, orderBy: { createdAt: 'desc' } })) ?? undefined);
    await A.db.webhookDelivery.update({ where: { id: last.id }, data: { attempts: MAX_ATTEMPTS - 1, nextAttemptAt: new Date() } });
    await processWebhooks(A.tenantId);
    const endpoint = (await api('GET', '/webhooks', as(admin))).json.endpoints.find((e: any) => e.id === id);
    assert.equal(endpoint.enabled, false);
    assert.match(endpoint.disabledReason, /deliveries in a row failed/);
    assert.ok(await A.db.auditEvent.findFirst({ where: { tenantId: A.tenantId, event: 'webhook.disabled' } }));

    // Turned back on: a fresh start
    const on = (await api('PATCH', `/webhooks/${id}`, as(admin, { enabled: true }))).json;
    assert.equal(on.enabled, true);
    assert.equal(on.consecutiveFailures, 0);
    assert.equal(on.disabledReason, null);
  } finally {
    answer = 200;
    await api('DELETE', `/webhooks/${id}`, as(admin));
  }
});

test('webhooks only go to public addresses, over https', async () => {
  const strict = await startExtraServer({ WEBHOOK_ALLOW_PRIVATE: 'false' });
  try {
    for (const url of [receiverUrl, 'https://localhost/hook', 'https://10.0.0.5/hook', 'https://[::1]/hook', 'https://169.254.169.254/latest', 'https://user:pass@example.com/hook', 'ftp://example.com/x', 'not a url']) {
      const res = await strict.api('POST', '/webhooks', as(admin, { url, events: ['*'] }));
      assert.equal(res.status, 400, url);
      assert.equal(res.json.code, 'BAD_WEBHOOK_URL', url);
    }
    assert.equal((await strict.api('POST', '/webhooks', as(admin, { url: 'https://example.com/hook', events: ['no.such_event'] }))).status, 400);
  } finally {
    await strict.stop();
  }
  const { isPrivateAddress } = await import('../src/lib/webhooks.js');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '0.0.0.0']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '172.32.0.1']) assert.ok(!isPrivateAddress(ip), ip);
});
