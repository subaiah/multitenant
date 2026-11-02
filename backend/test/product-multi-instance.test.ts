/**
 * External products against two servers on the same databases (behind a
 * load balancer): what one server changes, the other enforces at once, and
 * what's sent out (lifecycle and user events, logout tokens) is sent once.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { api, baseUrl, db, loginSession, seedPlatformUsers, seedTenant, startExtraServer, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let platform: string;
let admin: string;
let second: Awaited<ReturnType<typeof startExtraServer>>;
let receiver: Server;
let port: number;
const received: { path: string; body: string }[] = [];
let appId: string;
let key: string;

before(async () => {
  process.env.BFF_URL = baseUrl();
  receiver = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received.push({ path: req.url!, body: b });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  port = (receiver.address() as AddressInfo).port;
  A = await seedTenant('mi-a');
  const P = await seedPlatformUsers();
  await startServer();
  // The same settings (and issuer): another instance of the same deployment
  second = await startExtraServer({});
  platform = (await loginSession('platform', P.adminEmail)).cookie;
  admin = (await loginSession(A.slug, A.adminEmail)).cookie;
  key = `mi-${randomBytes(3).toString('hex')}`;
  const imported = await api('POST', '/applications/manifest', {
    cookie: platform,
    body: {
      manifestVersion: 1, productId: key, name: `Multi ${key}`, version: '1.0.0', baseUrl: 'https://mi.example.com',
      signIn: { clientType: 'CONFIDENTIAL', redirectUris: ['https://mi.example.com/cb'], backchannelLogoutUri: `http://127.0.0.1:${port}/logout` },
      provisioning: { callbackUrl: `http://127.0.0.1:${port}/events`, userEvents: true },
    },
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.json));
  appId = imported.json.application.id;
  // Turned on through the second server
  assert.equal((await second.api('POST', '/tenant-applications', { cookie: admin, body: { applicationId: appId, state: 'ENABLED' } })).status, 201);
  for (let i = 0; i < 100 && !received.some((r) => r.path === '/events' && r.body.includes('organization.entitled')); i++) await sleep(100);
});
after(async () => {
  receiver.close();
  await second?.stop();
  const { controlDb } = await db();
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: appId } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: appId } });
  await stopServerAndCleanUp();
});

test("a service token from one server works on the other; revoking on one stops it on the other at once", async () => {
  const cred = await api('POST', `/applications/${appId}/service-credentials`, { cookie: platform, body: { name: 'Both', scopes: ['organizations.read'] } });
  assert.equal(cred.status, 201);
  const res = await fetch(`${baseUrl()}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${cred.json.clientId}:${cred.json.clientSecret}`).toString('base64')}` },
    body: 'grant_type=client_credentials&scope=organizations.read',
  });
  const { access_token } = (await res.json()) as { access_token: string };
  const as = { headers: { authorization: `Bearer ${access_token}` } };
  assert.equal((await second.api('GET', '/v1/products/me', as)).status, 200, 'issued by one, accepted by the other');
  assert.equal((await second.api('GET', '/v1/product-integrations/organizations', as)).json.organizations[0].id, A.tenantId);
  assert.equal((await api('DELETE', `/applications/${appId}/service-credentials/${cred.json.id}`, { cookie: platform })).status, 204);
  const after = await second.api('GET', '/v1/products/me', as);
  assert.deepEqual([after.status, after.json.code], [401, 'CREDENTIAL_REVOKED']);
});

test('the lifecycle event and a user event are sent once, whichever server made the change', async () => {
  const entitled = received.filter((r) => r.path === '/events' && JSON.parse(r.body).type === 'organization.entitled');
  assert.equal(entitled.length, 1);
  await sleep(1000); // the silent first pass
  const users = (await api('GET', '/users?limit=50', { cookie: admin })).json.data as { id: string; email: string }[];
  const user = users.find((u) => u.email === A.userEmail)!;
  const from = received.length;
  // Changed on the second server
  assert.equal((await second.api('PATCH', `/users/${user.id}`, { cookie: admin, body: { name: 'Renamed' } })).status, 200);
  for (let i = 0; i < 100 && !received.slice(from).some((r) => r.body.includes('user.updated')); i++) await sleep(100);
  await sleep(1500); // both servers' delivery loops have had their turn
  const updates = received.slice(from).filter((r) => r.path === '/events' && JSON.parse(r.body).type === 'user.updated');
  assert.equal(updates.length, 1, 'once');
  assert.equal(JSON.parse(updates[0].body).data.user.id, user.id);
});

test('a logout queued through one server is sent once', async () => {
  const { controlDb } = await db();
  const { endApplicationSessions } = await import('../src/lib/oidc/logout.js');
  const signIn = await controlDb.applicationSignIn.findUniqueOrThrow({ where: { applicationId: appId } });
  // As if the person had signed in: the provider's grant
  const users = (await api('GET', '/users?limit=50', { cookie: admin })).json.data as { id: string; email: string }[];
  const accountId = `${A.tenantId}.${users.find((u) => u.email === A.managerEmail)!.id}`;
  await controlDb.oidcPayload.create({ data: { model: 'Grant', id: `g-${randomBytes(6).toString('hex')}`, payload: { accountId, clientId: signIn.clientId }, expiresAt: new Date(Date.now() + 3600_000) } });
  const from = received.length;
  assert.equal(await endApplicationSessions({ accountIds: [accountId] }, 'signed_out_everywhere'), 1);
  // Both servers poll the outbox; only one may send it
  for (let i = 0; i < 100 && !received.slice(from).some((r) => r.path === '/logout'); i++) await sleep(100);
  await sleep(2000);
  assert.equal(received.slice(from).filter((r) => r.path === '/logout').length, 1);
  assert.equal(await controlDb.oidcPayload.count({ where: { model: 'Grant', payload: { path: ['accountId'], equals: accountId } } }), 0, 'the grant is gone');

  // Several senders at the same moment (servers' loops): the claim lets one through
  const { sendDueLogouts } = await import('../src/lib/oidc/logout.js');
  const row = await controlDb.oidcLogoutDelivery.create({ data: { applicationId: appId, clientId: signIn.clientId, accountId, reason: 'removed' } });
  const before = received.filter((r) => r.path === '/logout').length;
  await Promise.all([sendDueLogouts(), sendDueLogouts(), sendDueLogouts(), sendDueLogouts()]);
  assert.equal(received.filter((r) => r.path === '/logout').length - before, 1);
  assert.equal((await controlDb.oidcLogoutDelivery.findUniqueOrThrow({ where: { id: row.id } })).attempts, 1);
});
