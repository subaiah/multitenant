/**
 * Scoped permissions and units reach applications (docs/hub/HUB_GAPS.md G7):
 * the members API and the sign-in claims carry the application's permissions
 * held in part of the organization; GET .../org-units gives the tree they
 * refer to; user events tell when someone's units or scoped permissions
 * change, and when the tree itself does. The TypeScript client's allows()
 * applies them as the platform does.
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

let A: TenantSeed;
let platform: string;
let admin: string;
let receiver: Server;
let callbackUrl: string;
const received: any[] = [];
let P: { id: string; key: string };
let token: string; // members.read
let narrowToken: string; // organizations.read only
const ids: Record<string, string> = {};
const org: Record<string, string> = {};
const unit: Record<string, string> = {};
let role: string;
let client: any;

const asAdmin = (body?: unknown) => ({ cookie: admin, ...(body === undefined ? {} : { body }) });
const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

before(async () => {
  process.env.BFF_URL = baseUrl();
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  callbackUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/events`;
  A = await seedTenant('scp');
  const PS = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', PS.adminEmail)).cookie;
  admin = (await loginSession(A.slug, A.adminEmail)).cookie;
  client = await import('../../clients/typescript/src/index.ts' as string);
  for (const u of (await api('GET', '/users?limit=50', asAdmin())).json.data) ids[u.email] = u.id;

  // The organization's own organizations and units, before the product is on
  for (const name of ['North', 'South']) org[name] = (await api('POST', '/organizations', asAdmin({ name }))).json.id;
  const mk = async (name: string, organization: string, parentUnitId?: string) => {
    const res = await api('POST', `/org-units/organization/${organization}`, asAdmin({ name, unitType: 'DEPARTMENT', ...(parentUnitId && { parentUnitId }) }));
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json.id as string;
  };
  unit.Sales = await mk('Sales', org.North);
  unit.SalesEast = await mk('Sales East', org.North, unit.Sales);
  unit.Ops = await mk('Ops', org.South);

  const key = `scp-${randomBytes(3).toString('hex')}`;
  const res = await api('POST', '/applications/manifest', {
    cookie: platform,
    body: {
      manifestVersion: 1, productId: key, name: `Deals ${key}`, version: '1.0.0', baseUrl: 'https://deals.example.com',
      signIn: { clientType: 'CONFIDENTIAL', redirectUris: ['https://deals.example.com/cb'] },
      permissions: [{ name: `${key}.deals:edit`, description: 'Edit deals' }, { name: `${key}.deals:read`, description: 'See deals' }],
      provisioning: { callbackUrl, userEvents: true },
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  P = { id: res.json.application.id, key };
  assert.equal((await api('POST', '/tenant-applications', asAdmin({ applicationId: P.id, state: 'ENABLED' }))).status, 201);
  const { controlDb } = await db();
  for (let i = 0; i < 100 && (await controlDb.productMemberState.count({ where: { applicationId: P.id, tenantId: A.tenantId } })) < 3; i++) await sleep(100);

  const cred = async (scopes: string[]) => {
    const c = await api('POST', `/applications/${P.id}/service-credentials`, { cookie: platform, body: { name: scopes.join(' '), scopes } });
    assert.equal(c.status, 201, JSON.stringify(c.json));
    const t = await fetch(`${baseUrl()}/oidc/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${c.json.clientId}:${c.json.clientSecret}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: scopes.join(' ') }),
    });
    return ((await t.json()) as { access_token: string }).access_token;
  };
  token = await cred(['members.read']);
  narrowToken = await cred(['organizations.read']);

  // A role with one of the product's permissions and one of the kit's
  const r = await api('POST', '/roles', asAdmin({ name: `Deal editors ${key}`, permissions: [`${key}.deals:edit`, 'organizations:update'] }));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  role = r.json.id;
});
after(async () => {
  receiver.close();
  const { controlDb } = await db();
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: P?.id } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: P?.id } });
  await stopServerAndCleanUp();
});

const assign = async (userId: string, scopeType: string, scopeId: string) => {
  const res = await api('POST', '/roles/assign', asAdmin({ roleId: role, principalType: 'USER', userId, scopeType, scopeId }));
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id as string;
};

/** Events P got since `from` (user.* and units.*), waiting until `until` holds */
async function eventsSince(from: number, until: (events: any[]) => boolean) {
  let got: any[] = [];
  for (let i = 0; i < 100; i++) {
    got = received.slice(from).filter((e) => /^(user|units)\./.test(e.type) && e.data.application.key === P.key);
    if (until(got)) break;
    await sleep(100);
  }
  return got;
}

test('the tree, who is in which unit, and permissions held in part of the organization: members API, matching the contract', async () => {
  const from = received.length;
  await assign(ids[A.userEmail], 'ORG_UNIT', unit.Sales);
  assert.equal((await api('POST', `/org-units/${unit.SalesEast}/members`, asAdmin({ userId: ids[A.userEmail] }))).status, 201);
  assert.equal((await api('POST', `/organizations/${org.North}/members`, asAdmin({ userId: ids[A.managerEmail] }))).status, 201);

  const tree = await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/org-units`, bearer(token));
  assert.equal(tree.status, 200, JSON.stringify(tree.json));
  matchesContract('listProductOrgUnits', tree.json);
  assert.deepEqual(tree.json.organizations.map((o: any) => [o.name, o.memberCount]), [['North', 1], ['South', 0]], 'direct members only');
  const byName = Object.fromEntries(tree.json.units.map((u: any) => [u.name, u]));
  assert.deepEqual([byName['Sales'].parentUnitId, byName['Sales East'].parentUnitId, byName['Sales East'].organizationId, byName['Sales East'].memberCount], [null, unit.Sales, org.North, 1]);

  const members = await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/members?limit=50`, bearer(token));
  assert.equal(members.status, 200, JSON.stringify(members.json));
  matchesContract('listProductMembers', members.json);
  const of = (email: string) => members.json.members.find((m: any) => m.email === email);
  assert.deepEqual(of(A.userEmail).permissions, []);
  assert.deepEqual(of(A.userEmail).scopedPermissions, [{ permission: `${P.key}.deals:edit`, scopeType: 'ORG_UNIT', scopeId: unit.Sales }], 'only the product’s own, not organizations:update');
  assert.deepEqual(of(A.userEmail).memberOf, { organizations: [], units: [unit.SalesEast] });
  assert.deepEqual(of(A.managerEmail).memberOf, { organizations: [org.North], units: [] });
  assert.deepEqual(of(A.adminEmail).scopedPermissions, [], 'held everywhere: not repeated');

  const inUnit = await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/members?orgUnitId=${unit.SalesEast}`, bearer(token));
  assert.deepEqual(inUnit.json.members.map((m: any) => m.email), [A.userEmail]);

  assert.equal((await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/org-units`, bearer(narrowToken))).status, 403, 'needs members.read');

  // Told: the unit grant as a permission change, the memberships as unit changes
  const got = await eventsSince(from, (e) => e.length >= 3);
  const user = got.filter((e) => e.data.user?.email === A.userEmail);
  const perm = user.find((e) => e.type === 'user.permissions_changed');
  assert.deepEqual([perm.data.added, perm.data.scopedAdded, perm.data.scopedRemoved], [[], [{ permission: `${P.key}.deals:edit`, scopeType: 'ORG_UNIT', scopeId: unit.Sales }], []]);
  const units = user.find((e) => e.type === 'user.units_changed');
  assert.deepEqual([units.data.memberOf, units.data.added, units.data.removed], [{ organizations: [], units: [unit.SalesEast] }, { organizations: [], units: [unit.SalesEast] }, { organizations: [], units: [] }]);
  const manager = got.find((e) => e.type === 'user.units_changed' && e.data.user.email === A.managerEmail);
  assert.deepEqual(manager.data.added, { organizations: [org.North], units: [] });
  assert.ok(!got.some((e) => e.type === 'units.changed'), 'the tree didn’t change');

  // The client applies them as the platform does
  const access = of(A.userEmail);
  const tree2 = client.unitTree(tree.json.units);
  assert.equal(client.allows(access, `${P.key}.deals:edit`, { orgUnitId: unit.SalesEast }, tree2), true, 'a unit below');
  assert.equal(client.allows(access, `${P.key}.deals:edit`, { orgUnitId: unit.Sales }, tree2), true);
  assert.equal(client.allows(access, `${P.key}.deals:edit`, { orgUnitId: unit.Ops }, tree2), false, 'another unit');
  assert.equal(client.allows(access, `${P.key}.deals:edit`, { organizationId: org.North }), false, 'a unit grant isn’t the whole organization');
  assert.equal(client.allows(access, `${P.key}.deals:edit`), false, 'nowhere in particular: not held everywhere');
  assert.equal(client.allows(access, `${P.key}.deals:read`, { orgUnitId: unit.SalesEast }, tree2), false, 'another permission');
  assert.equal(client.allows({ permissions: [`${P.key}.deals:*`] }, `${P.key}.deals:edit`), true, 'wildcards as the platform');
});

test('user events: leaving a unit, a grant for one organization, a grant taken back, and the tree changing', async () => {
  let from = received.length;
  assert.equal((await api('DELETE', `/org-units/${unit.SalesEast}/members/${ids[A.userEmail]}`, asAdmin())).status, 204);
  let got = await eventsSince(from, (e) => e.length >= 1);
  assert.deepEqual(got.map((e) => [e.type, e.data.user.email, e.data.removed]), [['user.units_changed', A.userEmail, { organizations: [], units: [unit.SalesEast] }]]);

  from = received.length;
  const grant = await assign(ids[A.managerEmail], 'ORGANIZATION', org.South);
  got = await eventsSince(from, (e) => e.length >= 1);
  assert.deepEqual(got.map((e) => [e.type, e.data.user.email, e.data.scopedAdded, e.data.scopedPermissions]), [[
    'user.permissions_changed', A.managerEmail,
    [{ permission: `${P.key}.deals:edit`, scopeType: 'ORGANIZATION', scopeId: org.South }],
    [{ permission: `${P.key}.deals:edit`, scopeType: 'ORGANIZATION', scopeId: org.South }],
  ]]);

  from = received.length;
  assert.equal((await api('DELETE', `/roles/assignments/${grant}`, asAdmin())).status, 204);
  got = await eventsSince(from, (e) => e.length >= 1);
  assert.deepEqual(got.map((e) => [e.type, e.data.scopedRemoved.map((s: any) => s.scopeId), e.data.scopedPermissions]), [['user.permissions_changed', [org.South], []]]);

  // A new unit: the tree changed, re-read it; nobody's access did
  from = received.length;
  assert.equal((await api('POST', `/org-units/organization/${org.South}`, asAdmin({ name: 'Field', unitType: 'TEAM' }))).status, 201);
  got = await eventsSince(from, (e) => e.length >= 1);
  await sleep(300);
  got = await eventsSince(from, () => true);
  assert.deepEqual(got.map((e) => [e.type, e.data.organizations, e.data.units]), [['units.changed', 2, 4]]);
  assert.equal(got[0].data.organization.id, A.tenantId);
});

test('sign-in claims: scoped_permissions next to permissions, in the discovery document; which audit entries count', async () => {
  const { claimsFor } = await import('../src/lib/oidc/accounts.js');
  const user = await A.db.user.findFirstOrThrow({ where: { tenantId: A.tenantId, email: A.userEmail } });
  const claims = await claimsFor(`${A.tenantId}.${user.id}`, { tenant: { id: A.tenantId, slug: A.slug, name: A.slug }, user }, P.id, new Set(['roles']));
  assert.deepEqual(claims.permissions, []);
  assert.deepEqual(claims.scoped_permissions, [{ permission: `${P.key}.deals:edit`, scopeType: 'ORG_UNIT', scopeId: unit.Sales }]);
  const noRoles = await claimsFor(`${A.tenantId}.${user.id}`, { tenant: { id: A.tenantId, slug: A.slug, name: A.slug }, user }, P.id, new Set(['email']));
  assert.equal(noRoles.scoped_permissions, undefined, 'only with the roles scope');

  const discovery = (await api('GET', '/oidc/.well-known/openid-configuration')).json;
  assert.ok(discovery.claims_supported.includes('scoped_permissions'));

  const { affectedBy } = await import('../src/lib/product-user-events.js');
  const entry = (event: string, details: Record<string, unknown> | null = null) => ({ event, outcome: 'SUCCESS', resourceType: null, resourceId: null, details }) as never;
  assert.deepEqual(affectedBy(entry('org_unit.member_added', { userId: 'u1' })), ['u1']);
  assert.deepEqual(affectedBy(entry('organization.member_removed', { userId: 'u2' })), ['u2']);
  assert.equal(affectedBy(entry('org_unit.updated')), null, 'the tree: everyone');
  assert.equal(affectedBy(entry('organization.deleted')), null);
});
