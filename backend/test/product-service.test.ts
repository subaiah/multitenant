/**
 * External products calling API v1 themselves (lib/product-service.ts): a
 * service credential gets a short-lived JWT from the token endpoint (client
 * credentials), and API v1's product routes check it, its scopes and its
 * credential on every call.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { SignJWT, decodeJwt, decodeProtectedHeader, importJWK } from 'jose';
import { api, baseUrl, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type PlatformSeed, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let P: PlatformSeed;
let platform: string;
let adminA: string;
let receiver: Server;
let callbackUrl: string;
const received: any[] = [];
const productIds: string[] = [];

before(async () => {
  process.env.BFF_URL = baseUrl();
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  callbackUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/events`;
  A = await seedTenant('svc-a');
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

async function product(provisioning = true) {
  const productId = `svc-${randomBytes(3).toString('hex')}`;
  productIds.push(productId);
  const res = await api('POST', '/applications/manifest', {
    cookie: platform,
    body: {
      manifestVersion: 1, productId, name: `Svc ${productId}`, version: '1.0.0', baseUrl: 'https://svc.example.com',
      signIn: { clientType: 'CONFIDENTIAL', redirectUris: ['https://svc.example.com/cb'] },
      ...(provisioning && { provisioning: { callbackUrl } }),
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { productId, id: res.json.application.id as string, signInClientId: res.json.clientId as string, signInSecret: res.json.clientSecret as string };
}
async function credential(applicationId: string, scopes: string[], name = 'Server') {
  const res = await api('POST', `/applications/${applicationId}/service-credentials`, { cookie: platform, body: { name, scopes } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json as { id: string; clientId: string; clientSecret: string; scopes: string[] };
}
async function tokenFor(clientId: string, secret: string, scope?: string) {
  const res = await fetch(`${baseUrl()}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', ...(scope && { scope }) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
const asService = (token: string, body?: unknown) => ({ headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body }) });

test('a service credential gets a short-lived JWT for API v1, with the scopes it asked for and is allowed', async () => {
  const p = await product(false);
  const c = await credential(p.id, ['organizations.read', 'lifecycle.report']);
  assert.match(c.clientId, /^mts_/);
  assert.ok(c.clientSecret.length > 30, 'the secret, once');
  const { controlDb } = await db();
  assert.match((await controlDb.productServiceCredential.findUniqueOrThrow({ where: { id: c.id } })).serviceClientSecret, /^enc:v\d+:/, 'stored encrypted');

  const t = await tokenFor(c.clientId, c.clientSecret, 'lifecycle.report members.read');
  assert.equal(t.status, 200, JSON.stringify(t.json));
  assert.equal(t.json.token_type, 'Bearer');
  assert.equal(t.json.expires_in, 600);
  assert.equal(t.json.scope, 'lifecycle.report', 'members.read is not on the credential');
  assert.equal(decodeProtectedHeader(t.json.access_token).typ, 'at+jwt');
  const claims = decodeJwt(t.json.access_token);
  assert.equal(claims.iss, `${baseUrl()}/oidc`);
  assert.equal(claims.aud, 'urn:multitenant:api:v1');
  assert.equal(claims.client_id, c.clientId);
  assert.equal(claims.product_id, p.productId);
  assert.equal(claims.scope, 'lifecycle.report');

  const me = await api('GET', '/v1/products/me', asService(t.json.access_token));
  assert.equal(me.status, 200, JSON.stringify(me.json));
  assert.equal(me.json.product.key, p.productId);
  assert.deepEqual(me.json.scopes, ['lifecycle.report']);
  assert.equal(me.json.credential.name, 'Server');

  // Recorded in the platform's audit log; last used is tracked
  assert.ok(JSON.stringify((await api('GET', '/platform-audit?event=application.service_credential_created', { cookie: platform })).json).includes(c.clientId));
  await sleep(200);
  assert.ok((await controlDb.productServiceCredential.findUniqueOrThrow({ where: { id: c.id } })).lastUsedAt);
});

test('reporting a setup result with a service token; scopes and other products are enforced', async () => {
  const p = await product();
  const reporter = await credential(p.id, ['lifecycle.report']);
  const reader = await credential(p.id, ['organizations.read'], 'Reader');
  const on = await api('POST', '/tenant-applications', { cookie: adminA, body: { applicationId: p.id, state: 'ENABLED' } });
  assert.equal(on.status, 201);
  let event: any;
  for (let i = 0; i < 100 && !event; i++, await sleep(100)) event = received.find((e) => e.data.application.key === p.productId);
  const { id: operationId, generation } = event.data.operation;
  const path = `/v1/product-integrations/operations/${operationId}/result`;

  // Without the scope: refused
  const readerToken = (await tokenFor(reader.clientId, reader.clientSecret, 'organizations.read')).json.access_token;
  const noScope = await api('POST', path, asService(readerToken, { generation, status: 'READY' }));
  assert.equal(noScope.status, 403);
  assert.equal(noScope.json.code, 'INSUFFICIENT_SCOPE');

  // Another product's credential: not found
  const other = await product(false);
  const otherCred = await credential(other.id, ['lifecycle.report']);
  const otherToken = (await tokenFor(otherCred.clientId, otherCred.clientSecret, 'lifecycle.report')).json.access_token;
  assert.equal((await api('POST', path, asService(otherToken, { generation, status: 'READY' }))).status, 404);

  // The product's own: recorded
  const token = (await tokenFor(reporter.clientId, reporter.clientSecret, 'lifecycle.report')).json.access_token;
  assert.equal((await api('POST', path, asService(token, { generation, status: 'READY' }))).status, 204);
  const { controlDb } = await db();
  assert.equal((await controlDb.tenantApplication.findFirstOrThrow({ where: { tenantId: A.tenantId, applicationId: p.id } })).provisioningStatus, 'READY');
  // The old endpoint with the sign-in client's secret is gone
  assert.equal((await api('POST', `/product-api/operations/${operationId}/result`, { headers: { authorization: `Basic ${Buffer.from(`${p.signInClientId}:${p.signInSecret}`).toString('base64')}` }, body: { generation, status: 'READY' } })).status, 404);
});

test('revoking a credential stops it at once, tokens included; wrong secrets and other tokens are refused', async () => {
  const p = await product(false);
  const c = await credential(p.id, ['organizations.read']);
  const token = (await tokenFor(c.clientId, c.clientSecret, 'organizations.read')).json.access_token;
  assert.equal((await api('GET', '/v1/products/me', asService(token))).status, 200);

  assert.equal((await tokenFor(c.clientId, 'wrong', 'organizations.read')).status, 401);
  // The sign-in client can't get service tokens
  const signIn = await tokenFor(p.signInClientId, p.signInSecret, 'organizations.read');
  assert.equal(signIn.status, 400);
  assert.match(signIn.json.error_description, /grant type is not allowed for this client/);

  assert.equal((await api('DELETE', `/applications/${p.id}/service-credentials/${c.id}`, { cookie: platform })).status, 204);
  const after = await api('GET', '/v1/products/me', asService(token));
  assert.equal(after.status, 401);
  assert.equal(after.json.code, 'CREDENTIAL_REVOKED');
  assert.equal((await tokenFor(c.clientId, c.clientSecret, 'organizations.read')).status, 401, 'no new tokens either');
  assert.equal((await api('DELETE', `/applications/${p.id}/service-credentials/${c.id}`, { cookie: platform })).status, 404, 'already revoked');

  // No token, a made-up one, one for another audience, an expired one
  assert.equal((await api('GET', '/v1/products/me')).status, 401);
  assert.equal((await api('GET', '/v1/products/me', asService('not-a-token'))).status, 401);
  const live = await credential(p.id, ['organizations.read'], 'Live');
  const { signingKeys } = await import('../src/lib/oidc/keys.js');
  const [jwk] = await signingKeys();
  const key = await importJWK(jwk as never, 'RS256');
  const forge = (claims: Record<string, unknown>, exp: number) =>
    new SignJWT({ client_id: live.clientId, scope: 'organizations.read', ...claims })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: jwk.kid })
      .setIssuer(`${baseUrl()}/oidc`).setIssuedAt().setExpirationTime(exp).sign(key);
  const wrongAudience = await forge({ aud: 'https://somewhere-else' }, Math.floor(Date.now() / 1000) + 300);
  assert.equal((await api('GET', '/v1/products/me', asService(wrongAudience))).status, 401);
  const expired = await forge({ aud: 'urn:multitenant:api:v1' }, Math.floor(Date.now() / 1000) - 60);
  const exp = await api('GET', '/v1/products/me', asService(expired));
  assert.equal(exp.status, 401);
  assert.equal(exp.json.code, 'TOKEN_EXPIRED');

  // A product taken offline: its credentials stop working
  const { controlDb } = await db();
  const liveToken = (await tokenFor(live.clientId, live.clientSecret, 'organizations.read')).json.access_token;
  await controlDb.applicationRegistry.update({ where: { id: p.id }, data: { status: 'INACTIVE' } });
  assert.equal((await api('GET', '/v1/products/me', asService(liveToken))).status, 403);
  await controlDb.applicationRegistry.update({ where: { id: p.id }, data: { status: 'ACTIVE' } });
});

test('service credentials: platform staff only, known scopes only, listed without secrets', async () => {
  const p = await product(false);
  assert.equal((await api('POST', `/applications/${p.id}/service-credentials`, { cookie: adminA, body: { name: 'x', scopes: ['organizations.read'] } })).status, 403);
  assert.equal((await api('POST', `/applications/${p.id}/service-credentials`, { cookie: platform, body: { name: 'x', scopes: ['users:delete'] } })).status, 400);
  assert.equal((await api('POST', `/applications/${p.id}/service-credentials`, { cookie: platform, body: { name: 'x', scopes: [] } })).status, 400);
  const c = await credential(p.id, ['members.read']);
  const list = await api('GET', `/applications/${p.id}/service-credentials`, { cookie: platform });
  assert.equal(list.status, 200);
  assert.equal(list.json.tokenUrl, `${baseUrl()}/oidc/token`);
  assert.equal(list.json.audience, 'urn:multitenant:api:v1');
  assert.deepEqual(list.json.scopes.map((s: { name: string }) => s.name), ['organizations.read', 'members.read', 'lifecycle.report', 'notifications.send', 'audit.write', 'launcher.read']);
  assert.equal(list.json.credentials[0].clientId, c.clientId);
  assert.ok(!JSON.stringify(list.json).includes(c.clientSecret), 'never shown again');
});

test("the TypeScript client's createProductClient gets and reuses tokens", async () => {
  const p = await product(false);
  const c = await credential(p.id, ['organizations.read']);
  const source = '../../clients/typescript/src/index.ts';
  // The client lives outside the backend: loaded at run time, typed loosely here
  type Answer = { response: Response; data?: { product: { key: string }; scopes: string[] }; error?: unknown };
  const { createProductClient } = (await import(source)) as { createProductClient: (o: Record<string, unknown>) => { GET: (path: string) => Promise<Answer> } };
  const client = createProductClient({ baseUrl: `${baseUrl()}/v1`, tokenUrl: `${baseUrl()}/oidc/token`, clientId: c.clientId, clientSecret: c.clientSecret, scopes: ['organizations.read'] });
  const first = await client.GET('/products/me');
  assert.equal(first.response.status, 200, JSON.stringify(first.error));
  assert.equal(first.data!.product.key, p.productId);
  assert.deepEqual(first.data!.scopes, ['organizations.read']);
  const second = await client.GET('/products/me');
  assert.equal(second.response.status, 200);
  // A wrong secret: the call fails with the token endpoint's reason
  const bad = createProductClient({ baseUrl: `${baseUrl()}/v1`, tokenUrl: `${baseUrl()}/oidc/token`, clientId: c.clientId, clientSecret: 'wrong', scopes: ['organizations.read'] });
  await assert.rejects(bad.GET('/products/me'), /Getting a service token failed/);
});

