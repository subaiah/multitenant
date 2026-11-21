/**
 * An organization's API settings, enforced (lib/api-gateway.ts): its rate
 * limit on API-key traffic, and which other sites' pages may call with its keys.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, baseUrl, loginSession, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let B: TenantSeed;
let keyA: string;
let keyB: string;
let adminB: string;

const makeKey = async (cookie: string) => {
  const res = await api('POST', '/api-keys', { cookie, body: { name: 'Gateway test', permissions: ['users:read'] } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.key as string;
};
const withKey = (key: string, headers: Record<string, string> = {}) => ({ headers: { authorization: `Bearer ${key}`, ...headers } });

before(async () => {
  A = await seedTenant('gateway-a');
  B = await seedTenant('gateway-b');
  // Set before the server first reads them (it keeps them for half a minute)
  await A.db.apiConfig.update({ where: { tenantId: A.tenantId }, data: { rateLimit: 3 } });
  await B.db.apiConfig.update({ where: { tenantId: B.tenantId }, data: { corsEnabled: true, allowedOrigins: ['https://partner.example'] } });
  await startServer();
  keyA = await makeKey((await loginSession(A.slug, A.adminEmail)).cookie);
  adminB = (await loginSession(B.slug, B.adminEmail)).cookie;
  keyB = await makeKey(adminB);
});
after(stopServerAndCleanUp);

test("API keys share the organization's per-minute limit: then 429 with when to try again", async () => {
  for (let i = 1; i <= 3; i++) {
    const res = await api('GET', '/users', withKey(keyA));
    assert.equal(res.status, 200, `call ${i}`);
    assert.equal(res.headers.get('ratelimit-limit'), '3');
    assert.equal(res.headers.get('ratelimit-remaining'), String(3 - i));
  }
  const over = await api('GET', '/users', withKey(keyA));
  assert.equal(over.status, 429);
  assert.equal(over.json.code, 'ORGANIZATION_RATE_LIMITED');
  assert.ok(Number(over.headers.get('retry-after')) > 0);
  // Its people's own sessions aren't API traffic
  assert.equal((await api('GET', '/users', { cookie: (await loginSession(A.slug, A.adminEmail)).cookie })).status, 200);
});

test("other sites' pages may call with the organization's keys only from its allowed origins", async () => {
  // A preflight only says what may be sent, without cookies
  const preflight = await fetch(`${baseUrl()}/users`, {
    method: 'OPTIONS',
    headers: { origin: 'https://partner.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://partner.example');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);

  const allowed = await api('GET', '/users', withKey(keyB, { origin: 'https://partner.example' }));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://partner.example');

  const refused = await api('GET', '/users', withKey(keyB, { origin: 'https://elsewhere.example' }));
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, 'CORS_ORIGIN_NOT_ALLOWED');
  assert.equal(refused.headers.get('access-control-allow-origin'), null);

  // Another organization's origins don't count for this one
  assert.equal((await api('GET', '/users', withKey(keyA, { origin: 'https://partner.example' }))).status, 403);
  // Servers and scripts send no Origin: untouched
  assert.notEqual((await api('GET', '/users', withKey(keyB))).status, 403);
});

test('saving the settings keeps origins as scheme and host, and applies at once', async () => {
  const saved = await api('PATCH', '/api-config', { cookie: adminB, body: { corsEnabled: true, allowedOrigins: ['https://other.example/app/', 'https://other.example'] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.allowedOrigins, ['https://other.example']);
  assert.equal((await api('GET', '/users', withKey(keyB, { origin: 'https://other.example' }))).status, 200);
  assert.equal((await api('GET', '/users', withKey(keyB, { origin: 'https://partner.example' }))).status, 403, 'the old list no longer applies');

  await api('PATCH', '/api-config', { cookie: adminB, body: { corsEnabled: false } });
  const off = await api('GET', '/users', withKey(keyB, { origin: 'https://other.example' }));
  assert.equal(off.status, 403);
  assert.match(off.json.message, /doesn't allow calls from web pages/);
});
