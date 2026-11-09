/**
 * Applications that need, or work with, other applications, and bundles
 * (docs/hub/HUB_GAPS.md G2; lib/app-dependencies.ts): turning one on needs
 * what it requires on first (never turned on for the organization
 * automatically); what's required can't be turned off under it; bundles turn
 * a set on together; the catalogue and the Integrations page say so.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { api, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let B: TenantSeed;
let platform: string;
let adminA: string;
let adminB: string;
const productIds: string[] = [];
const sfx = randomBytes(3).toString('hex');
const keys = { chat: `chat-${sfx}`, crm: `crm-${sfx}`, docs: `docs-${sfx}`, later: `later-${sfx}` };
const ids: Record<string, string> = {};

const manifest = (key: string, name: string, extra: Record<string, unknown> = {}) => ({
  manifestVersion: 2, productId: key, name, version: '1.0.0', baseUrl: `https://${key}.example.com`,
  signIn: { clientType: 'CONFIDENTIAL', redirectUris: [`https://${key}.example.com/cb`] }, ...extra,
});
async function importIt(body: Record<string, unknown>, status = 201) {
  const r = await api('POST', '/applications/manifest', { cookie: platform, body });
  assert.equal(r.status, status, JSON.stringify(r.json));
  return r.json;
}
const entitlementOf = async (t: TenantSeed, appId: string) => {
  const { controlDb } = await db();
  return controlDb.tenantApplication.findUniqueOrThrow({ where: { tenantId_applicationId: { tenantId: t.tenantId, applicationId: appId } } });
};
const turnOn = (cookie: string, applicationId: string) => api('POST', '/tenant-applications', { cookie, body: { applicationId, state: 'ENABLED' } });

before(async () => {
  A = await seedTenant('dep-a');
  B = await seedTenant('dep-b');
  const P = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', P.adminEmail)).cookie;
  adminA = (await loginSession(A.slug, A.adminEmail)).cookie;
  adminB = (await loginSession(B.slug, B.adminEmail)).cookie;
  productIds.push(...Object.values(keys));
  ids.chat = (await importIt(manifest(keys.chat, 'Chat', { kind: 'generic' }))).application.id;
  ids.docs = (await importIt(manifest(keys.docs, 'Docs', { kind: 'generic' }))).application.id;
});
after(async () => {
  const { controlDb } = await db();
  const apps = await controlDb.applicationRegistry.findMany({ where: { key: { in: productIds } }, select: { id: true } });
  await controlDb.bundle.deleteMany({ where: { key: { startsWith: `b-${sfx}` } } });
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: { in: apps.map((a) => a.id) } } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: { in: apps.map((a) => a.id) } } });
  await stopServerAndCleanUp();
});

test('manifest version 2: requires and integratesWith, a warning for ones not registered yet, exported as they were; mistakes refused', async () => {
  const requires = [{ productId: keys.chat, reason: 'Conversations on deals' }];
  const integratesWith = [{ productId: keys.docs, reason: 'Attach documents' }, { productId: 'nobody-yet', reason: 'Some day' }];
  const crm = manifest(keys.crm, 'CRM', { requires, integratesWith });
  const r = await importIt(crm);
  ids.crm = r.application.id;
  assert.deepEqual(r.dependencies, { requires: 1, integratesWith: 2, notRegisteredYet: ['nobody-yet'] });
  const exported = (await api('GET', `/applications/${ids.crm}/manifest`, { cookie: platform })).json;
  assert.deepEqual([exported.requires, exported.integratesWith], [requires, integratesWith]);

  const problems = async (body: Record<string, unknown>) => String((await importIt(body, 400)).message);
  assert.match(await problems(manifest(keys.crm, 'CRM', { requires: [{ productId: keys.crm, reason: 'x' }] })), /can’t depend on itself/);
  assert.match(await problems(manifest(keys.crm, 'CRM', { requires: [{ productId: keys.chat, reason: 'x' }], integratesWith: [{ productId: keys.chat, reason: 'y' }] })), /listed twice/);
  assert.match(await problems(manifest(keys.crm, 'CRM', { requires: [{ productId: 'Not Valid', reason: 'x' }] })), /not a product id/);
  assert.match(await problems({ ...manifest(keys.crm, 'CRM'), manifestVersion: 1, requires: [] }), /requires: needs "manifestVersion": 2/);
  // Every version 2 field, supported ones included, is refused in a version 1 manifest rather than dropped
  assert.match(await problems({ ...manifest(keys.crm, 'CRM'), manifestVersion: 1, consumes: [], api: { scopes: [] } }), /consumes: needs "manifestVersion": 2.*api: needs|api: needs "manifestVersion": 2.*consumes: needs/s);
});

test('the catalogue says what each needs and works with, and which kind it is', async () => {
  const apps = (await api('GET', '/applications?limit=100', { cookie: adminA })).json.applications;
  const crm = apps.find((a: any) => a.id === ids.crm);
  assert.deepEqual(crm.requires, [{ productId: keys.chat, name: 'Chat', reason: 'Conversations on deals' }]);
  assert.deepEqual(crm.integratesWith.map((d: any) => [d.productId, d.name]), [[keys.docs, 'Docs'], ['nobody-yet', null]]);
  assert.equal(apps.find((a: any) => a.id === ids.chat).kind, 'generic');
  assert.equal(crm.kind, 'specific');
});

test('turning on needs what it requires on first (never turned on automatically); what is required can’t be turned off under it', async () => {
  const refused = await turnOn(adminA, ids.crm);
  assert.deepEqual([refused.status, refused.json.code], [409, 'MISSING_DEPENDENCY'], JSON.stringify(refused.json));
  assert.match(refused.json.message, /CRM needs Chat turned on first: Conversations on deals/);
  assert.deepEqual(refused.json.details.missing.map((m: any) => [m.productId, m.name]), [[keys.chat, 'Chat']]);
  const { controlDb } = await db();
  assert.equal(await controlDb.tenantApplication.count({ where: { tenantId: A.tenantId, applicationId: { in: [ids.crm, ids.chat] } } }), 0, 'nothing turned on');

  assert.equal((await turnOn(adminA, ids.chat)).status, 201);
  assert.equal((await turnOn(adminA, ids.crm)).status, 201);

  const chat = await entitlementOf(A, ids.chat);
  const off = await api('PATCH', `/tenant-applications/${chat.id}`, { cookie: adminA, body: { state: 'DISABLED' } });
  assert.deepEqual([off.status, off.json.code], [409, 'REQUIRED_BY'], JSON.stringify(off.json));
  assert.match(off.json.message, /CRM needs Chat: turn it off first/);
  assert.deepEqual(off.json.details.requiredBy.map((d: any) => d.productId), [keys.crm]);
  const ended = await api('PATCH', `/tenant-applications/${chat.id}`, { cookie: adminA, body: { validTo: new Date(Date.now() - 60_000).toISOString() } });
  assert.equal(ended.json.code, 'REQUIRED_BY', 'ending it counts as turning it off');
  assert.equal((await api('DELETE', `/tenant-applications/${chat.id}`, { cookie: adminA })).json.code, 'REQUIRED_BY');

  // In order: the dependant first
  const crm = await entitlementOf(A, ids.crm);
  assert.equal((await api('PATCH', `/tenant-applications/${crm.id}`, { cookie: adminA, body: { state: 'DISABLED' } })).status, 200);
  assert.equal((await api('PATCH', `/tenant-applications/${chat.id}`, { cookie: adminA, body: { state: 'DISABLED' } })).status, 200);
  const back = await api('PATCH', `/tenant-applications/${crm.id}`, { cookie: adminA, body: { state: 'ENABLED' } });
  assert.equal(back.json.code, 'MISSING_DEPENDENCY', 'turning it on again needs Chat again');
  // Changing something else on one that's on is fine
  assert.equal((await api('PATCH', `/tenant-applications/${chat.id}`, { cookie: adminA, body: { state: 'TRIAL' } })).status, 200);
  assert.equal((await api('PATCH', `/tenant-applications/${crm.id}`, { cookie: adminA, body: { state: 'ENABLED' } })).status, 200);
  assert.equal((await api('PATCH', `/tenant-applications/${crm.id}`, { cookie: adminA, body: { validTo: new Date(Date.now() + 86_400_000).toISOString() } })).status, 200);
});

test('bundles: platform staff make them; an organization turns one on in one step, checked across the set', async () => {
  const make = (body: Record<string, unknown>) => api('POST', '/applications/bundles', { cookie: platform, body });
  assert.equal((await make({ key: `b-${sfx}-one`, name: 'Too small', applicationIds: [ids.crm] })).status, 400);
  const suite = await make({ key: `b-${sfx}-sales`, name: 'Sales suite', description: 'Deals and the conversation around them', applicationIds: [ids.crm, ids.chat] });
  assert.equal(suite.status, 201, JSON.stringify(suite.json));
  assert.equal((await make({ key: `b-${sfx}-sales`, name: 'Again', applicationIds: [ids.crm, ids.chat] })).status, 409);
  const broken = (await make({ key: `b-${sfx}-broken`, name: 'Missing its need', applicationIds: [ids.crm, ids.docs] })).json;
  assert.equal((await api('GET', '/platform-audit?event=bundle.created', { cookie: platform })).json.data[0].resourceLabel, 'Missing its need');

  // B has nothing on: the bundle turns both on, CRM's need met within the bundle
  const listed = (await api('GET', '/tenant-applications/bundles', { cookie: adminB })).json.bundles.find((b: any) => b.id === suite.json.id);
  assert.deepEqual(listed.applications.map((a: any) => [a.name, a.on]), [['CRM', false], ['Chat', false]]);
  assert.equal((await api('POST', `/tenant-applications/bundles/${suite.json.id}`, { cookie: (await loginSession(B.slug, B.userEmail)).cookie })).status, 403, 'administrators only');
  const on = await api('POST', `/tenant-applications/bundles/${suite.json.id}`, { cookie: adminB });
  assert.equal(on.status, 201, JSON.stringify(on.json));
  assert.deepEqual(on.json.turnedOn.sort(), ['CRM', 'Chat'].sort());
  assert.equal((await entitlementOf(B, ids.crm)).state, 'ENABLED');
  const again = await api('POST', `/tenant-applications/bundles/${suite.json.id}`, { cookie: adminB });
  assert.deepEqual([again.status, again.json.turnedOn, again.json.alreadyOn.length], [200, [], 2]);

  // A bundle that doesn't hold what one of its applications needs, for an organization without it
  const { controlDb } = await db();
  await controlDb.tenantApplication.deleteMany({ where: { tenantId: B.tenantId } });
  const refused = await api('POST', `/tenant-applications/bundles/${broken.id}`, { cookie: adminB });
  assert.equal(refused.json.code, 'MISSING_DEPENDENCY');
  assert.equal(await controlDb.tenantApplication.count({ where: { tenantId: B.tenantId } }), 0, 'all or nothing');

  // Hidden from organizations
  await api('PUT', `/applications/bundles/${broken.id}`, { cookie: platform, body: { key: broken.key, name: broken.name, active: false, applicationIds: [ids.crm, ids.docs] } });
  assert.ok(!(await api('GET', '/tenant-applications/bundles', { cookie: adminB })).json.bundles.some((b: any) => b.id === broken.id));
  assert.equal((await api('POST', `/tenant-applications/bundles/${broken.id}`, { cookie: adminB })).status, 404);
});

test('a new requirement turns nothing off; the Integrations page lists organizations missing it', async () => {
  const later = await importIt(manifest(keys.later, 'Later'));
  productIds.push(keys.later);
  assert.equal((await turnOn(adminB, later.application.id)).status, 201);
  // Later now requires Docs, which B doesn't have
  await importIt(manifest(keys.later, 'Later', { requires: [{ productId: keys.docs, reason: 'Stores files there' }] }), 200);
  assert.equal((await entitlementOf(B, later.application.id)).state, 'ENABLED', 'still on');
  const row = (await api('GET', '/applications/integrations', { cookie: platform })).json.applications.find((a: any) => a.id === later.application.id);
  assert.ok(row.attention.includes('1 organization has it without something it requires'), JSON.stringify(row.attention));
});
