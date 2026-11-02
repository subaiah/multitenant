/**
 * What an external product reads through API v1 as itself
 * (lib/product-data.ts): the organizations with an entitlement to it, their
 * people and groups while it's turned on, and its own lifecycle events.
 * Responses are checked against the API v1 contract (api/v1.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { api, baseUrl, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';
import { PRODUCT_ENDPOINTS, SCHEMAS } from '../src/api/v1.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'https://contract/', components: { schemas: SCHEMAS } });
const absolute = (s: unknown): unknown => JSON.parse(JSON.stringify(s).replace(/"#\/components/g, '"https://contract/#/components'));
function matchesContract(operationId: string, body: unknown) {
  const e = PRODUCT_ENDPOINTS.find((x) => x.operationId === operationId)!;
  const validate = ajv.compile(absolute(e.responses[200])) as ((d: unknown) => boolean) & { errors?: unknown };
  assert.ok(validate(body), `${operationId} doesn't match the contract: ${JSON.stringify(validate.errors)}\n${JSON.stringify(body).slice(0, 800)}`);
}

let A: TenantSeed; // has the product
let B: TenantSeed; // never had it
let C: TenantSeed; // had it, turned off
let platform: string;
const admin: Record<string, string> = {};
let receiver: Server;
let callbackUrl: string;
const received: any[] = [];
const productIds: string[] = [];
let P: { id: string; key: string };
let token: string; // all three scopes
let orgsOnly: string; // organizations.read only

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
  [A, B, C] = [await seedTenant('pd-a'), await seedTenant('pd-b'), await seedTenant('pd-c')];
  const PS = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', PS.adminEmail)).cookie;
  for (const t of [A, B, C]) admin[t.slug] = (await loginSession(t.slug, t.adminEmail)).cookie;

  P = await product();
  const cred = await credential(P.id, ['organizations.read', 'members.read', 'lifecycle.report']);
  token = await tokenFor(cred.clientId, cred.clientSecret, 'organizations.read members.read lifecycle.report');
  const reader = await credential(P.id, ['organizations.read'], 'Reader');
  orgsOnly = await tokenFor(reader.clientId, reader.clientSecret, 'organizations.read');

  // A and C turn it on; C turns it off again
  for (const t of [A, C]) assert.equal((await api('POST', '/tenant-applications', { cookie: admin[t.slug], body: { applicationId: P.id, state: 'ENABLED' } })).status, 201);
  const { controlDb } = await db();
  const cRow = await controlDb.tenantApplication.findUniqueOrThrow({ where: { tenantId_applicationId: { tenantId: C.tenantId, applicationId: P.id } } });
  assert.equal((await api('PATCH', `/tenant-applications/${cRow.id}`, { cookie: admin[C.slug], body: { state: 'DISABLED' } })).status, 200);
  for (let i = 0; i < 100 && received.filter((e) => e.data.application.key === P.key).length < 3; i++) await sleep(100);
});
after(async () => {
  receiver.close();
  const { controlDb } = await db();
  const apps = await controlDb.applicationRegistry.findMany({ where: { key: { in: productIds } }, select: { id: true } });
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: { in: apps.map((a) => a.id) } } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: { in: apps.map((a) => a.id) } } });
  await stopServerAndCleanUp();
});

async function product() {
  const key = `pd-${randomBytes(3).toString('hex')}`;
  productIds.push(key);
  const res = await api('POST', '/applications/manifest', {
    cookie: platform,
    body: {
      manifestVersion: 1, productId: key, name: `Data ${key}`, version: '1.0.0', baseUrl: 'https://pd.example.com',
      signIn: { clientType: 'CONFIDENTIAL', redirectUris: ['https://pd.example.com/cb'] },
      permissions: [{ name: `${key}:admin`, description: 'Manage it' }, { name: `${key}.apps:build`, description: 'Build apps' }],
      provisioning: { callbackUrl },
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { id: res.json.application.id as string, key };
}
async function credential(applicationId: string, scopes: string[], name = 'Server') {
  const res = await api('POST', `/applications/${applicationId}/service-credentials`, { cookie: platform, body: { name, scopes } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json as { clientId: string; clientSecret: string };
}
async function tokenFor(clientId: string, secret: string, scope: string) {
  const res = await fetch(`${baseUrl()}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }),
  });
  const json = (await res.json()) as Record<string, any>;
  assert.equal(res.status, 200, JSON.stringify(json));
  return json.access_token as string;
}
const as = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

test('the organizations with an entitlement to the product, with their setup; others are not found', async () => {
  const res = await api('GET', '/v1/product-integrations/organizations', as(token));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  matchesContract('listProductOrganizations', res.json);
  const ids = res.json.organizations.map((o: any) => o.id);
  assert.ok(ids.includes(A.tenantId) && ids.includes(C.tenantId), 'A and C');
  assert.ok(!ids.includes(B.tenantId), 'not B, which never had it');
  const a = res.json.organizations.find((o: any) => o.id === A.tenantId);
  assert.equal(a.slug, A.slug);
  assert.deepEqual([a.entitlement.state, a.entitlement.active, a.setup.status, a.available, a.suspended], ['ENABLED', true, 'PENDING', false, false]);
  const event = received.find((e) => e.type === 'organization.entitled' && e.data.organization.id === A.tenantId);
  assert.deepEqual(a.setup.operation, event.data.operation, 'the operation it was told about');
  const c = res.json.organizations.find((o: any) => o.id === C.tenantId);
  assert.deepEqual([c.entitlement.state, c.entitlement.active, c.available], ['DISABLED', false, false]);

  // Filters and paging
  const active = await api('GET', '/v1/product-integrations/organizations?active=true', as(token));
  assert.deepEqual(active.json.organizations.map((o: any) => o.id), [A.tenantId]);
  const inactive = await api('GET', '/v1/product-integrations/organizations?active=false', as(token));
  assert.deepEqual(inactive.json.organizations.map((o: any) => o.id), [C.tenantId]);
  assert.equal((await api('GET', `/v1/product-integrations/organizations?search=${A.slug}`, as(token))).json.organizations.length, 1);
  const paged = await api('GET', '/v1/product-integrations/organizations?limit=1', as(token));
  assert.deepEqual([paged.json.organizations.length, paged.json.pagination.total, paged.json.pagination.pages], [1, 2, 2]);

  // One; READY once the product reports it
  const reported = await api('POST', `/v1/product-integrations/operations/${event.data.operation.id}/result`, { ...as(token), body: { generation: event.data.operation.generation, status: 'READY' } });
  assert.equal(reported.status, 204);
  const one = await api('GET', `/v1/product-integrations/organizations/${A.tenantId}`, as(token));
  assert.equal(one.status, 200);
  matchesContract('getProductOrganization', one.json);
  assert.deepEqual([one.json.setup.status, one.json.available], ['READY', true]);
  assert.ok(one.json.setup.completedAt);
  assert.equal((await api('GET', '/v1/product-integrations/organizations?setupStatus=READY', as(token))).json.organizations[0].id, A.tenantId);

  for (const id of [B.tenantId, 'not-a-uuid']) {
    const missing = await api('GET', `/v1/product-integrations/organizations/${id}`, as(token));
    assert.equal(missing.status, 404, id);
  }

  // Another product sees none of them
  const other = await product();
  const oc = await credential(other.id, ['organizations.read', 'members.read']);
  const ot = await tokenFor(oc.clientId, oc.clientSecret, 'organizations.read members.read');
  assert.deepEqual((await api('GET', '/v1/product-integrations/organizations', as(ot))).json.organizations, []);
  assert.equal((await api('GET', `/v1/product-integrations/organizations/${A.tenantId}`, as(ot))).status, 404);
  assert.equal((await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/members`, as(ot))).status, 404);
});

test("an organization's people, with their sign-in subject, groups, roles and the product's permissions they hold", async () => {
  const cookie = admin[A.slug];
  // The person in a group whose role holds one of the product's permissions
  const role = await api('POST', '/roles', { cookie, body: { name: `Builders ${P.key}`, permissions: [`${P.key}.apps:build`] } });
  assert.equal(role.status, 201, JSON.stringify(role.json));
  const group = await api('POST', '/groups', { cookie, body: { name: `Makers ${P.key}` } });
  assert.equal(group.status, 201);
  const users = (await api('GET', '/users?limit=50', { cookie })).json.data as { id: string; email: string }[];
  const id = (email: string) => users.find((u) => u.email === email)!.id;
  assert.equal((await api('POST', `/groups/${group.json.id}/members`, { cookie, body: { userId: id(A.userEmail) } })).status, 201);
  assert.equal((await api('POST', '/roles/assign', { cookie, body: { roleId: role.json.id, principalType: 'GROUP', groupId: group.json.id } })).status, 201);

  const res = await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/members`, as(token));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  matchesContract('listProductMembers', res.json);
  const by = (email: string) => res.json.members.find((m: any) => m.email === email);
  const [adminM, managerM, userM] = [by(A.adminEmail), by(A.managerEmail), by(A.userEmail)];
  assert.equal(adminM.subject, `${A.tenantId}.${adminM.id}`, 'the sub it signs in with');
  assert.deepEqual(adminM.permissions, [`${P.key}.apps:build`, `${P.key}:admin`].sort(), 'administrators hold all of them');
  assert.deepEqual(userM.permissions, [`${P.key}.apps:build`], 'through the group');
  assert.deepEqual(userM.groups, [{ id: group.json.id, name: `Makers ${P.key}` }]);
  assert.ok(userM.roles.includes(`Builders ${P.key}`));
  assert.deepEqual(managerM.permissions, []);
  assert.equal(JSON.stringify(res.json).includes('passwordHash') || JSON.stringify(res.json).includes('totp'), false, 'nothing secret');

  // Filters and paging
  const inGroup = await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/members?groupId=${group.json.id}`, as(token));
  assert.deepEqual(inGroup.json.members.map((m: any) => m.email), [A.userEmail]);
  const future = new Date(Date.now() + 3600_000).toISOString();
  assert.equal((await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/members?updatedSince=${encodeURIComponent(future)}`, as(token))).json.members.length, 0);
  const paged = await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/members?limit=1&page=2`, as(token));
  assert.deepEqual([paged.json.members.length, paged.json.pagination.page, paged.json.pagination.total], [1, 2, 3]);
  // A deactivated person holds nothing
  assert.equal((await api('PATCH', `/users/${id(A.managerEmail)}`, { cookie, body: { status: 'INACTIVE' } })).status, 200);
  const inactive = await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/members?status=INACTIVE`, as(token));
  assert.deepEqual(inactive.json.members.map((m: any) => [m.email, m.permissions.length]), [[A.managerEmail, 0]]);

  // Groups
  const groups = await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/groups`, as(token));
  assert.equal(groups.status, 200);
  matchesContract('listProductGroups', groups.json);
  assert.equal(groups.json.groups.find((g: any) => g.id === group.json.id).memberCount, 1);

  // Not while it's off, never for organizations without it, and only with members.read
  const off = await api('GET', `/v1/product-integrations/organizations/${C.tenantId}/members`, as(token));
  assert.deepEqual([off.status, off.json.code], [403, 'NOT_ENTITLED']);
  assert.equal((await api('GET', `/v1/product-integrations/organizations/${C.tenantId}/groups`, as(token))).status, 403);
  assert.equal((await api('GET', `/v1/product-integrations/organizations/${B.tenantId}/members`, as(token))).status, 404);
  const noScope = await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/members`, as(orgsOnly));
  assert.deepEqual([noScope.status, noScope.json.code], [403, 'INSUFFICIENT_SCOPE']);
  assert.equal((await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/members?status=NOPE`, as(token))).status, 400);
});

test("the product's own lifecycle events, oldest first, exactly as sent, with a cursor to poll from", async () => {
  const all = await api('GET', '/v1/product-integrations/events', as(orgsOnly));
  assert.equal(all.status, 200, JSON.stringify(all.json));
  matchesContract('listProductEvents', all.json);
  const types = all.json.data.map((e: any) => `${e.type} ${e.organizationId === A.tenantId ? 'A' : e.organizationId === C.tenantId ? 'C' : '?'}`);
  assert.deepEqual(types, ['organization.entitled A', 'organization.entitled C', 'organization.entitlement_changed C'], 'in the order they happened');
  const first = all.json.data[0];
  const sent = received.find((e) => e.id === first.id);
  assert.deepEqual(first.payload, sent, 'the body that was sent');
  assert.equal(first.delivery.status, 'DELIVERED');
  assert.equal(all.json.hasMore, false);

  // A page at a time, then nothing new from the end
  const p1 = await api('GET', '/v1/product-integrations/events?limit=1', as(token));
  assert.deepEqual([p1.json.data.length, p1.json.hasMore], [1, true]);
  const p2 = await api('GET', `/v1/product-integrations/events?limit=100&after=${p1.json.nextAfter}`, as(token));
  assert.equal(p2.json.data[0].id, all.json.data[1].id);
  const end = await api('GET', `/v1/product-integrations/events?after=${p2.json.nextAfter}`, as(token));
  assert.deepEqual([end.json.data, end.json.hasMore, end.json.nextAfter], [[], false, p2.json.nextAfter]);

  // Filters
  const onlyA = await api('GET', `/v1/product-integrations/events?organizationId=${A.tenantId}`, as(token));
  assert.ok(onlyA.json.data.length > 0 && onlyA.json.data.every((e: any) => e.organizationId === A.tenantId));
  const entitled = await api('GET', '/v1/product-integrations/events?type=organization.entitled', as(token));
  assert.ok(entitled.json.data.every((e: any) => e.type === 'organization.entitled'));

  // Another product's are not listed
  assert.ok(all.json.data.every((e: any) => e.payload.data.application.key === P.key));
});
