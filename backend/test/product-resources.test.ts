/**
 * Records in other applications (docs/hub/HUB_GAPS.md G8;
 * lib/product-resources.ts): record types declared in manifest v2, the
 * catalogue, identifiers resolved to links for organizations that have the
 * owner on, and the access check between applications end to end with the
 * TypeScript client (the owner's handler, the consumer's checkAccess).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { api, baseUrl, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let B: TenantSeed;
let platform: string;
let client: any;
let owner: Server;
let ownerUrl: string;
const sfx = randomBytes(3).toString('hex');
const crm = `crm-${sfx}`;
const chat = `chat-${sfx}`;
const ids: Record<string, string> = {};
let chatCred: { clientId: string; clientSecret: string };
let chatToken: string;

const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const manifest = (key: string, base: string, extra: Record<string, unknown> = {}) => ({
  manifestVersion: 2, productId: key, name: `App ${key}`, version: '1.0.0', baseUrl: base,
  signIn: { clientType: 'CONFIDENTIAL', redirectUris: [`${base}/cb`] }, ...extra,
});
const issuer = () => `${baseUrl()}/oidc`;

before(async () => {
  process.env.BFF_URL = baseUrl();
  client = await import('../../clients/typescript/src/index.ts' as string);
  // The CRM's server: answers access checks for its deals (Alice's deals: D-1 only)
  owner = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const handle = client.createAccessCheckHandler({
        productId: crm,
        verify: client.createAppTokenVerifier({ issuer: issuer(), productId: crm }),
        canSee: async ({ records, subject }: any) => records.filter((r: any) => r.type === 'deal' && r.id === 'D-1' && subject.endsWith(ids.user)).map((r: any) => r.resource),
      });
      const out = await handle(req.headers.authorization, JSON.parse(body || '{}'));
      res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
    });
  });
  // Every interface: localhost may be ::1 or 127.0.0.1
  await new Promise<void>((r) => owner.listen(0, r));
  ownerUrl = `http://localhost:${(owner.address() as AddressInfo).port}`;

  A = await seedTenant('rec-a');
  B = await seedTenant('rec-b');
  const PS = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', PS.adminEmail)).cookie;
  const c = await api('POST', '/applications/manifest', { cookie: platform, body: manifest(crm, ownerUrl, {
    api: { scopes: [{ name: `${crm}.records:check`, description: 'Check whether a person can see a record' }], accessCheckPath: '/platform/access-check' },
    resources: [{ type: 'deal', label: 'Deal', urlTemplate: '/deals/{id}' }, { type: 'account', label: 'Account', urlTemplate: '/accounts/{id}' }],
  }) });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.deepEqual(c.json.resources, { types: ['deal', 'account'] });
  const h = await api('POST', '/applications/manifest', { cookie: platform, body: manifest(chat, `https://${chat}.example.com`, {
    consumes: [{ scope: `${crm}.records:check`, reason: 'Show threads only on records people can see' }],
  }) });
  assert.equal(h.status, 201, JSON.stringify(h.json));
  const adminA = (await loginSession(A.slug, A.adminEmail)).cookie;
  for (const id of [c.json.application.id, h.json.application.id]) assert.equal((await api('POST', '/tenant-applications', { cookie: adminA, body: { applicationId: id, state: 'ENABLED' } })).status, 201);
  // B has only the chat app
  const adminB = (await loginSession(B.slug, B.adminEmail)).cookie;
  assert.equal((await api('POST', '/tenant-applications', { cookie: adminB, body: { applicationId: h.json.application.id, state: 'ENABLED' } })).status, 201);
  const cred = await api('POST', `/applications/${h.json.application.id}/service-credentials`, { cookie: platform, body: { name: 'Server', scopes: ['organizations.read'] } });
  chatCred = cred.json;
  const t = await fetch(`${issuer()}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${chatCred.clientId}:${chatCred.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'organizations.read' }),
  });
  chatToken = ((await t.json()) as { access_token: string }).access_token;
  ids.user = (await A.db.user.findFirstOrThrow({ where: { tenantId: A.tenantId, email: A.userEmail } })).id;
});
after(async () => {
  owner.close();
  const { controlDb } = await db();
  const apps = await controlDb.applicationRegistry.findMany({ where: { key: { in: [crm, chat] } }, select: { id: true } });
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: { in: apps.map((a) => a.id) } } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: { in: apps.map((a) => a.id) } } });
  await stopServerAndCleanUp();
});

test('manifest resources: each type once, a path with {id}, and the records:check scope exposed; exported', async () => {
  const problems = async (body: Record<string, unknown>) => {
    const res = await api('POST', '/applications/manifest?dryRun=true', { cookie: platform, body });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    return String(res.json.message);
  };
  const k = `bad-${sfx}`;
  const scope = { api: { scopes: [{ name: `${k}.records:check`, description: 'Check' }] } };
  assert.match(await problems(manifest(k, 'https://bad.example.com', { resources: [{ type: 'deal', label: 'Deal', urlTemplate: '/deals/{id}' }] })), /Expose the scope "bad-.*\.records:check"/);
  assert.match(await problems(manifest(k, 'https://bad.example.com', { ...scope, resources: [{ type: 'deal', label: 'Deal', urlTemplate: '/deals' }] })), /Must contain \{id\}/);
  assert.match(await problems(manifest(k, 'https://bad.example.com', { ...scope, resources: [{ type: 'deal', label: 'D', urlTemplate: '/d/{id}' }, { type: 'deal', label: 'D', urlTemplate: '/e/{id}' }] })), /listed twice/);
  const app = (await api('GET', '/applications?limit=200', { cookie: platform })).json.applications.find((a: any) => a.key === crm);
  const exported = (await api('GET', `/applications/${app.id}/manifest`, { cookie: platform })).json;
  assert.deepEqual(exported.resources, [{ type: 'deal', label: 'Deal', urlTemplate: '/deals/{id}' }, { type: 'account', label: 'Account', urlTemplate: '/accounts/{id}' }]);
  assert.equal(exported.api.accessCheckPath, '/platform/access-check');
});

test('the catalogue of record types, and identifiers resolved to links only where the owner is on', async () => {
  const types = (await api('GET', '/v1/product-integrations/resource-types', bearer(chatToken))).json.types.filter((t: any) => t.productId === crm);
  assert.deepEqual(types.map((t: any) => [t.type, t.urlTemplate, t.accessCheckUrl, t.checkScope]), [
    ['deal', `${ownerUrl}/deals/{id}`, `${ownerUrl}/platform/access-check`, `${crm}.records:check`],
    ['account', `${ownerUrl}/accounts/{id}`, `${ownerUrl}/platform/access-check`, `${crm}.records:check`],
  ]);
  const uri = client.formatResourceUri(crm, 'deal', 'D 7/x');
  assert.equal(uri, `mt://${crm}/deal/D%207%2Fx`);
  assert.deepEqual(client.parseResourceUri(uri), { productId: crm, type: 'deal', id: 'D 7/x' });
  assert.equal(client.parseResourceUri('https://example.com/deal/1'), null);

  const resolve = (org: string, u: string) => api('GET', `/v1/product-integrations/organizations/${org}/resources/resolve?uri=${encodeURIComponent(u)}`, bearer(chatToken));
  const r = await resolve(A.tenantId, uri);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.label, r.json.id, r.json.url], ['Deal', 'D 7/x', `${ownerUrl}/deals/D%207%2Fx`]);
  assert.equal((await resolve(B.tenantId, uri)).status, 404, 'B doesn’t have the CRM');
  assert.equal((await resolve(A.tenantId, `mt://${crm}/invoice/1`)).status, 404);
  assert.equal((await resolve(A.tenantId, 'not-an-id')).status, 400);
});

test('the access check: the chat app asks the CRM (its own token, the records:check scope); the CRM decides per person', async () => {
  const tokens = client.createAppTokens({ tokenUrl: `${issuer()}/token`, clientId: chatCred.clientId, clientSecret: chatCred.clientSecret });
  const token = await tokens.forOrganization(crm, A.tenantId, [`${crm}.records:check`]);
  const url = `${ownerUrl}/platform/access-check`;
  const d1 = client.formatResourceUri(crm, 'deal', 'D-1');
  const d2 = client.formatResourceUri(crm, 'deal', 'D-2');
  const other = client.formatResourceUri('elsewhere', 'deal', 'D-1');
  const seen = await client.checkAccess(url, token, { subject: `${A.tenantId}.${ids.user}`, resources: [d1, d2, other] });
  assert.deepEqual([...seen.entries()], [[d1, true], [d2, false], [other, false]], 'only its own records, only what the person may see');

  // Someone of another organization: nothing
  const stranger = await client.checkAccess(url, token, { subject: `${B.tenantId}.${ids.user}`, resources: [d1] });
  assert.equal(stranger.get(d1), false);
  // Without a valid token, the owner refuses; checkAccess treats that as no
  const refused = await client.checkAccess(url, 'not-a-token', { subject: `${A.tenantId}.${ids.user}`, resources: [d1] });
  assert.equal(refused.get(d1), false);
  // B doesn't have the CRM: no token to ask with
  await assert.rejects(tokens.forOrganization(crm, B.tenantId, [`${crm}.records:check`]), /access_denied|turned on/);
});
