/**
 * Request-level safeguards (lib/request-guard.ts and friends): the origin check
 * on cookie sessions, request IDs, the health endpoints, page-size caps, the
 * pinned token algorithm, and what a duplicate reveals.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, baseUrl, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let cookie: string;
let platformCookie: string;

before(async () => {
  A = await seedTenant('harden');
  const platform = await seedPlatformUsers();
  await startServer();
  cookie = (await loginSession(A.slug, A.adminEmail)).cookie;
  platformCookie = (await loginSession('platform', platform.adminEmail)).cookie;
});
after(stopServerAndCleanUp);

const newGroup = () => ({ name: `G ${Math.random().toString(36).slice(2, 8)}` });

test('a state-changing request with cookies from another site is refused', async () => {
  const evil = await api('POST', '/groups', { cookie, body: newGroup(), headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.json.code, 'BAD_ORIGIN');
  // ...also when only the Referer says where it came from
  assert.equal((await api('POST', '/groups', { cookie, body: newGroup(), headers: { referer: 'https://evil.example/page' } })).status, 403);
  assert.equal((await api('POST', '/groups', { cookie, body: newGroup(), headers: { origin: 'null' } })).status, 403);
});

test('requests from the app itself, or without cookies, go through', async () => {
  const allowed = (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',')[0];
  assert.equal((await api('POST', '/groups', { cookie, body: newGroup(), headers: { origin: allowed } })).status, 201);
  // The address the request was sent to (a custom domain reaches the API through its own address)
  assert.equal((await api('POST', '/groups', { cookie, body: newGroup(), headers: { origin: baseUrl() } })).status, 201);
  // No Origin or Referer: not a page in a browser
  assert.equal((await api('POST', '/groups', { cookie, body: newGroup() })).status, 201);
  // Reading is never blocked
  assert.equal((await api('GET', '/groups', { cookie, headers: { origin: 'https://evil.example' } })).status, 200);
  // A bearer token, no cookies: an API client, not a browser session
  const token = (await loginSession(A.slug, A.adminEmail)).token;
  assert.equal((await api('POST', '/groups', { token, body: newGroup(), headers: { origin: 'https://evil.example' } })).status, 201);
});

test('text/plain bodies are not accepted', async () => {
  const res = await fetch(`${baseUrl()}/groups`, { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: JSON.stringify(newGroup()) });
  assert.equal(res.status, 415);
});

test('every response carries a request ID; a well-formed one from the proxy is kept', async () => {
  const fresh = await api('GET', '/health');
  assert.match(fresh.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  const given = '0f8c2b6e-1d2a-4c4e-9a51-2f7d3b1c9e00';
  assert.equal((await api('GET', '/health', { headers: { 'x-request-id': given } })).headers.get('x-request-id'), given);
  // Anything else is replaced, not written into the logs
  const odd = (await api('GET', '/health', { headers: { 'x-request-id': '"><script> injected' } })).headers.get('x-request-id');
  assert.notEqual(odd, '"><script> injected');
  assert.match(odd ?? '', /^[0-9a-f-]{36}$/);
});

test('health: liveness and readiness are public and say little; details need platform staff', async () => {
  const live = await api('GET', '/health');
  assert.equal(live.status, 200);
  assert.deepEqual(Object.keys(live.json).sort(), ['status', 'timestamp']);
  const ready = await api('GET', '/health/ready');
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.json, { status: 'ok' });

  assert.equal((await api('GET', '/health/detailed')).status, 401);
  assert.equal((await api('GET', '/health/detailed', { cookie })).status, 403, 'tenant admins are not platform staff');
  const detailed = await api('GET', '/health/detailed', { cookie: platformCookie });
  assert.equal(detailed.status, 200);
  assert.equal(detailed.json.database.status, 'healthy');
  assert.ok(detailed.json.memory.used > 0);
});

test('a page holds at most 100 rows, and odd paging values are brought into range', async () => {
  const big = await api('GET', '/users?limit=1000000', { cookie });
  assert.equal(big.status, 200);
  assert.equal(big.json.pagination.limit, 100);
  const groups = await api('GET', '/groups?limit=5000&page=-3', { cookie });
  assert.equal(groups.status, 200);
  assert.equal(groups.json.pagination.limit, 100);
  assert.equal(groups.json.pagination.page, 1);
  const junk = await api('GET', '/groups?limit=abc&page=xyz', { cookie });
  assert.equal(junk.status, 200);
  assert.equal(junk.json.pagination.limit, 20);
});

test('a duplicate is refused without naming tables or columns', async () => {
  const body = newGroup();
  assert.equal((await api('POST', '/groups', { cookie, body })).status, 201);
  const again = await api('POST', '/groups', { cookie, body });
  assert.equal(again.status, 409);
  assert.equal(again.json.details, undefined);
  assert.doesNotMatch(JSON.stringify(again.json), /tenant_id|groups_|target|constraint/i);
});

test('a session token claiming another algorithm is refused', async () => {
  const token = (await loginSession(A.slug, A.adminEmail)).token;
  const [, payload] = token.split('.');
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal((await api('GET', '/groups', { token: `${header}.${payload}.` })).status, 401);
});
