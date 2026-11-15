/**
 * Connecting an application in one step (lib/application-connect.ts,
 * docs/hub/CONNECT.md): the platform reads the manifest from the
 * application's own address, an administrator approves, and the
 * application's server collects its credentials once with a code and its
 * PKCE verifier.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { api, baseUrl, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let site: Server;
let siteUrl: string;
let platform: string;
let tenantAdmin: string;
let A: TenantSeed;
const key = `connect-${randomBytes(3).toString('hex')}`;
/** What the stand-in application publishes at /.well-known/hub-manifest.json */
let published: Record<string, unknown>;

const manifest = (extra: Record<string, unknown> = {}) => ({
  manifestVersion: 2,
  productId: key,
  name: `Connect ${key}`,
  version: '1.0.0',
  baseUrl: siteUrl,
  kind: 'generic',
  signIn: { clientType: 'CONFIDENTIAL', redirectUris: [`${siteUrl}/auth/callback`] },
  provisioning: { callbackUrl: `${siteUrl}/platform/events`, userEvents: true },
  permissions: [{ name: `${key}:admin`, description: 'Manage it' }],
  ...extra,
});

/** A PKCE pair: the verifier stays with the application's server */
function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
const request = (challenge: string, extra: Record<string, unknown> = {}) => ({
  appUrl: siteUrl,
  redirectUri: `${siteUrl}/hub/connected`,
  state: 'state-123',
  codeChallenge: challenge,
  scopes: ['organizations.read', 'members.read'],
  ...extra,
});
const check = (body: unknown, cookie = platform) => api('POST', '/applications/connect/check', { cookie, body });
const approve = (body: unknown) => api('POST', '/applications/connect/approve', { cookie: platform, body });
const exchange = (code: string, codeVerifier: string) => api('POST', '/application-connect/exchange', { body: { code, codeVerifier } });

/** Check, approve what was shown, and return the code the browser came back with */
async function connect(p = pkce(), extra: Record<string, unknown> = {}) {
  const checked = await check(request(p.challenge, extra));
  assert.equal(checked.status, 200, JSON.stringify(checked.json));
  const approved = await approve({ ...request(p.challenge, extra), manifestHash: checked.json.manifestHash });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  const back = new URL(approved.json.redirectTo);
  return { p, back, code: back.searchParams.get('code')!, applicationId: approved.json.application.id as string };
}

before(async () => {
  site = createServer((req, res) => {
    if (req.url === '/.well-known/hub-manifest.json') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(published));
    else if (req.url === '/moved/.well-known/hub-manifest.json') res.writeHead(302, { location: '/.well-known/hub-manifest.json' }).end();
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => site.listen(0, r));
  siteUrl = `http://localhost:${(site.address() as AddressInfo).port}`;
  published = manifest();
  A = await seedTenant('connect-a');
  const PS = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', PS.adminEmail)).cookie;
  tenantAdmin = (await loginSession(A.slug, A.adminEmail)).cookie;
});

after(async () => {
  site.close();
  const { controlDb } = await db();
  await controlDb.applicationRegistry.deleteMany({ where: { key } });
  await stopServerAndCleanUp();
});

test('the check reads the manifest from the application and saves nothing', async () => {
  const { challenge } = pkce();
  const res = await check(request(challenge));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.application.productId, key);
  assert.equal(res.json.application.kind, 'generic');
  assert.equal(res.json.reconnect, false);
  assert.deepEqual(res.json.scopes.map((s: { name: string }) => s.name), ['organizations.read', 'members.read']);
  assert.match(res.json.manifestHash, /^[0-9a-f]{64}$/);
  const { controlDb } = await db();
  assert.equal(await controlDb.applicationRegistry.count({ where: { key } }), 0, 'not registered yet');
});

test('requests that cannot be trusted are refused', async () => {
  const { challenge } = pkce();
  // Coming back somewhere other than the application itself
  const elsewhere = await check(request(challenge, { redirectUri: 'https://evil.example.com/catch' }));
  assert.equal(elsewhere.status, 400);
  assert.match(elsewhere.json.message, /application's own address/);
  // An address with a path
  assert.equal((await check(request(challenge, { appUrl: `${siteUrl}/moved` }))).status, 400);
  // Not a PKCE challenge
  assert.equal((await check(request('short'))).status, 400);
  // A scope that doesn't exist
  assert.equal((await check(request(challenge, { scopes: ['everything'] }))).status, 400);

  // A manifest that speaks for another address
  published = manifest({ baseUrl: 'https://someone-else.example.com' });
  try {
    const other = await check(request(challenge));
    assert.equal(other.status, 400);
    assert.match(other.json.message, /baseUrl/);
  } finally {
    published = manifest();
  }

  // Only platform staff who manage the catalogue
  assert.equal((await check(request(challenge), tenantAdmin)).status, 403);
  assert.equal((await api('POST', '/applications/connect/check', { body: request(challenge) })).status, 401);
});

test('approving needs what was shown: no hash, or a manifest changed since, is refused', async () => {
  const { challenge } = pkce();
  const checked = await check(request(challenge));
  assert.equal((await approve(request(challenge))).status, 400, 'no hash');

  published = manifest({ permissions: [{ name: `${key}:admin`, description: 'Manage it' }, { name: `${key}:everything`, description: 'Slipped in after the check' }] });
  try {
    const changed = await approve({ ...request(challenge), manifestHash: checked.json.manifestHash });
    assert.equal(changed.status, 409);
    assert.equal(changed.json.code, 'MANIFEST_CHANGED');
  } finally {
    published = manifest();
  }
  const { controlDb } = await db();
  assert.equal(await controlDb.applicationRegistry.count({ where: { key } }), 0, 'still not registered');
});

test('connecting registers the application and hands its credentials over once, to whoever holds the verifier', async () => {
  const { p, back, code, applicationId } = await connect();
  assert.equal(back.origin, siteUrl);
  assert.equal(back.pathname, '/hub/connected');
  assert.equal(back.searchParams.get('state'), 'state-123');
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);

  // The wrong verifier: refused, and the code is used up
  const wrong = await exchange(code, pkce().verifier);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.code, 'INVALID_GRANT');
  assert.equal((await exchange(code, p.verifier)).status, 400, 'a code that was tried is gone');

  // Again, properly
  const second = await connect();
  const got = await exchange(second.code, second.p.verifier);
  assert.equal(got.status, 200, JSON.stringify(got.json));
  assert.equal(got.headers.get('cache-control'), 'no-store');
  const creds = got.json;
  assert.equal(creds.application.id, applicationId);
  assert.equal(creds.application.productId, key);
  assert.match(creds.signIn.clientId, /^mtc_/);
  assert.ok(creds.signIn.clientSecret, 'a sign-in secret');
  assert.ok(creds.events.signingSecret, 'a secret for the events it is sent');
  assert.deepEqual(creds.service.scopes, ['organizations.read', 'members.read']);
  assert.equal((await exchange(second.code, second.p.verifier)).status, 400, 'once only');

  // The service credential works
  const token = await fetch(`${baseUrl()}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${creds.service.clientId}:${creds.service.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'organizations.read' }),
  });
  assert.equal(token.status, 200, await token.clone().text());
  const me = await api('GET', '/v1/products/me', { headers: { authorization: `Bearer ${((await token.json()) as { access_token: string }).access_token}` } });
  assert.equal(me.status, 200, JSON.stringify(me.json));

  // Nothing secret is kept once collected, and the audit log says what happened
  const { controlDb } = await db();
  assert.equal(await controlDb.applicationConnectGrant.count({ where: { applicationId } }), 0);
  const entry = await controlDb.platformAuditEvent.findFirst({ where: { event: 'application.connected', resourceId: applicationId }, orderBy: { seq: 'desc' } });
  assert.ok(entry);
  assert.ok(!JSON.stringify(entry).includes(creds.signIn.clientSecret), 'no secret in the audit log');
});

test('connecting again replaces the secrets: the old copies stop working', async () => {
  const first = await connect();
  const before = (await exchange(first.code, first.p.verifier)).json;

  const again = await connect();
  assert.equal((await check(request(pkce().challenge))).json.reconnect, true);
  const after = (await exchange(again.code, again.p.verifier)).json;

  assert.equal(after.signIn.clientId, before.signIn.clientId, 'the same client');
  assert.notEqual(after.signIn.clientSecret, before.signIn.clientSecret);
  assert.notEqual(after.service.clientId, before.service.clientId);
  const oldToken = await fetch(`${baseUrl()}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${before.service.clientId}:${before.service.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  assert.equal(oldToken.status, 401, 'the earlier connection credential is revoked');
});

test('a code not collected in time is no use', async () => {
  const { code, p, applicationId } = await connect();
  const { controlDb } = await db();
  await controlDb.applicationConnectGrant.updateMany({ where: { applicationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await exchange(code, p.verifier)).status, 400);
});
