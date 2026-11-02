/**
 * User events for external products (lib/product-user-events.ts): a product
 * that asks for them is told when people in an organization that has it are
 * added, changed, deactivated, reactivated or removed, or when its
 * permissions they hold change; organizations' administrators see what each
 * product's server can learn about their people.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { api, baseUrl, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let platform: string;
let admin: string;
let receiver: Server;
let callbackUrl: string;
const received: any[] = [];
const productIds: string[] = [];
let P: { id: string; key: string }; // asks for user events
let Q: { id: string; key: string }; // doesn't
const ids: Record<string, string> = {};

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
  A = await seedTenant('ue-a');
  const PS = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', PS.adminEmail)).cookie;
  admin = (await loginSession(A.slug, A.adminEmail)).cookie;
  P = await product(true);
  Q = await product(false);
  for (const p of [P, Q]) assert.equal((await api('POST', '/tenant-applications', { cookie: admin, body: { applicationId: p.id, state: 'ENABLED' } })).status, 201);
  // Everyone recorded for P (silently) once it's on
  const { controlDb } = await db();
  for (let i = 0; i < 100 && (await controlDb.productMemberState.count({ where: { applicationId: P.id, tenantId: A.tenantId } })) < 3; i++) await sleep(100);
  for (const u of (await api('GET', '/users?limit=50', { cookie: admin })).json.data) ids[u.email] = u.id;
});
after(async () => {
  receiver.close();
  const { controlDb } = await db();
  const apps = await controlDb.applicationRegistry.findMany({ where: { key: { in: productIds } }, select: { id: true } });
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: { in: apps.map((a) => a.id) } } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: { in: apps.map((a) => a.id) } } });
  await stopServerAndCleanUp();
});

async function product(userEvents: boolean) {
  const key = `ue-${randomBytes(3).toString('hex')}`;
  productIds.push(key);
  const res = await api('POST', '/applications/manifest', {
    cookie: platform,
    body: {
      manifestVersion: 1, productId: key, name: `Users ${key}`, version: '1.0.0', baseUrl: 'https://ue.example.com',
      signIn: { clientType: 'CONFIDENTIAL', redirectUris: ['https://ue.example.com/cb'] },
      permissions: [{ name: `${key}:admin`, description: 'Manage it' }, { name: `${key}.apps:build`, description: 'Build apps' }],
      provisioning: { callbackUrl, userEvents },
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { id: res.json.application.id as string, key };
}

/** The user events P got since `from`, waiting until `until` holds */
async function userEvents(from: number, until: (events: any[]) => boolean) {
  let got: any[] = [];
  for (let i = 0; i < 100; i++) {
    got = received.slice(from).filter((e) => e.type.startsWith('user.') && e.data.application.key === P.key);
    if (until(got)) break;
    await sleep(100);
  }
  return got;
}
const onlyFor = (events: any[], email: string) => events.filter((e) => e.data.user.id === ids[email]);

test('nothing on the first pass; a deactivation, reactivation and rename are told, each once and only to products that asked', async () => {
  const quiet = received.filter((e) => e.type.startsWith('user.'));
  assert.deepEqual(quiet, [], 'turning it on records everyone without telling');

  let from = received.length;
  assert.equal((await api('PATCH', `/users/${ids[A.userEmail]}`, { cookie: admin, body: { status: 'INACTIVE' } })).status, 200);
  let got = await userEvents(from, (e) => e.length >= 1);
  await sleep(500);
  got = received.slice(from).filter((e) => e.type.startsWith('user.'));
  assert.deepEqual(got.map((e) => [e.type, e.data.application.key]), [['user.deactivated', P.key]], 'once, and not to Q');
  const e = got[0];
  assert.deepEqual(e.data.user, { id: ids[A.userEmail], subject: `${A.tenantId}.${ids[A.userEmail]}`, email: A.userEmail, name: 'User', userType: 'TENANT_USER', status: 'INACTIVE' });
  assert.equal(e.data.organization.id, A.tenantId);
  assert.match(e.id, /^evt_/);

  from = received.length;
  assert.equal((await api('PATCH', `/users/${ids[A.userEmail]}`, { cookie: admin, body: { status: 'ACTIVE' } })).status, 200);
  got = await userEvents(from, (x) => x.length >= 1);
  assert.deepEqual(got.map((x) => x.type), ['user.reactivated']);
  assert.deepEqual(got[0].data.permissions, []);

  from = received.length;
  assert.equal((await api('PATCH', `/users/${ids[A.managerEmail]}`, { cookie: admin, body: { name: 'Manny' } })).status, 200);
  got = await userEvents(from, (x) => x.length >= 1);
  assert.deepEqual(got.map((x) => [x.type, x.data.changes]), [['user.updated', ['name']]]);
  assert.equal(got[0].data.user.name, 'Manny');
});

test("the product's permissions a person holds: through a group's role, and when the role is edited", async () => {
  const role = await api('POST', '/roles', { cookie: admin, body: { name: `Builders ${P.key}`, permissions: [`${P.key}.apps:build`] } });
  assert.equal(role.status, 201, JSON.stringify(role.json));
  const group = await api('POST', '/groups', { cookie: admin, body: { name: `Makers ${P.key}` } });
  assert.equal((await api('POST', '/roles/assign', { cookie: admin, body: { roleId: role.json.id, principalType: 'GROUP', groupId: group.json.id } })).status, 201);

  let from = received.length;
  assert.equal((await api('POST', `/groups/${group.json.id}/members`, { cookie: admin, body: { userId: ids[A.userEmail] } })).status, 201);
  let got = await userEvents(from, (x) => x.length >= 1);
  assert.deepEqual(got.map((x) => [x.type, x.data.user.email, x.data.added, x.data.removed, x.data.permissions]), [
    ['user.permissions_changed', A.userEmail, [`${P.key}.apps:build`], [], [`${P.key}.apps:build`]],
  ]);

  // Editing the role reaches everyone holding it, and only them
  from = received.length;
  assert.equal((await api('PATCH', `/roles/${role.json.id}`, { cookie: admin, body: { name: `Builders ${P.key}`, permissions: [`${P.key}.apps:build`, `${P.key}:admin`] } })).status, 200);
  got = await userEvents(from, (x) => x.length >= 1);
  await sleep(300);
  got = await userEvents(from, () => true);
  assert.deepEqual(got.map((x) => [x.type, x.data.user.email, x.data.added]), [['user.permissions_changed', A.userEmail, [`${P.key}:admin`]]], 'not the admin, who holds them all anyway');

  // Leaving the group takes them away
  from = received.length;
  assert.equal((await api('DELETE', `/groups/${group.json.id}/members/${ids[A.userEmail]}`, { cookie: admin })).status, 204);
  got = await userEvents(from, (x) => x.length >= 1);
  assert.deepEqual(got.map((x) => [x.type, x.data.removed.sort(), x.data.permissions]), [['user.permissions_changed', [`${P.key}.apps:build`, `${P.key}:admin`].sort(), []]]);
});

test('someone invited is added; someone removed is removed; a change made behind the audit log is caught by the next pass', async () => {
  let from = received.length;
  const email = `new-${randomBytes(3).toString('hex')}@test.local`;
  const invited = await api('POST', '/users', { cookie: admin, body: { email, name: 'Newcomer' } });
  assert.equal(invited.status, 201, JSON.stringify(invited.json));
  let got = await userEvents(from, (x) => x.length >= 1);
  assert.deepEqual(got.map((x) => [x.type, x.data.user.email, x.data.user.status]), [['user.added', email, 'PENDING']]);

  from = received.length;
  assert.equal((await api('DELETE', `/users/${invited.json.id}`, { cookie: admin })).status, 204);
  got = await userEvents(from, (x) => x.length >= 1);
  assert.deepEqual(got.map((x) => [x.type, x.data.user]), [['user.removed', { id: invited.json.id, subject: `${A.tenantId}.${invited.json.id}` }]]);

  // Which audit entries reach whom
  const { affectedBy } = await import('../src/lib/product-user-events.js');
  const entry = (event: string, extra: Record<string, unknown> = {}) => ({ event, outcome: 'SUCCESS', resourceType: null, resourceId: null, details: null, ...extra }) as never;
  assert.deepEqual(affectedBy(entry('auth.invitation_accepted', { resourceType: 'user', resourceId: 'u1' })), ['u1']);
  assert.deepEqual(affectedBy(entry('role.assigned', { details: { principalType: 'USER', principalId: 'u2' } })), ['u2']);
  assert.equal(affectedBy(entry('role.assigned', { details: { principalType: 'GROUP', principalId: 'g1' } })), null, 'a group: everyone');
  assert.equal(affectedBy(entry('role.deleted')), null);
  assert.equal(affectedBy(entry('auth.login_succeeded', { resourceType: 'user', resourceId: 'u1' })), undefined, 'signing in changes nothing');
  assert.equal(affectedBy(entry('user.updated', { outcome: 'FAILURE', resourceType: 'user', resourceId: 'u1' })), undefined);

  // Straight in the database (as an expiring assignment would): the hourly pass finds it
  from = received.length;
  await A.db.user.update({ where: { id: ids[A.managerEmail] }, data: { name: 'Manfred' } });
  const { sweepMembers } = await import('../src/lib/product-user-events.js');
  assert.ok((await sweepMembers()) >= 1);
  got = await userEvents(from, (x) => x.length >= 1);
  assert.deepEqual(got.map((x) => [x.type, x.data.changes, x.data.user.name]), [['user.updated', ['name'], 'Manfred']]);
  assert.equal(await sweepMembers(), 0, 'nothing new the second time');

  // No plain email or name kept on the platform's side
  const { controlDb } = await db();
  const states = JSON.stringify(await controlDb.productMemberState.findMany({ where: { tenantId: A.tenantId } }));
  assert.ok(!states.includes(A.userEmail) && !states.includes('Manfred'));
});

test("administrators see what each product's server can learn about their people; turning user events off forgets", async () => {
  const list = async () => (await api('GET', '/tenant-applications', { cookie: admin })).json.tenantApplications as any[];
  const accessOf = async (id: string) => (await list()).find((t) => t.applicationId === id).application.dataAccess;
  assert.deepEqual(await accessOf(P.id), { peopleAndGroups: false, toldWhenPeopleChange: true });
  assert.deepEqual(await accessOf(Q.id), { peopleAndGroups: false, toldWhenPeopleChange: false });

  const cred = await api('POST', `/applications/${Q.id}/service-credentials`, { cookie: platform, body: { name: 'Sync', scopes: ['members.read'] } });
  assert.equal(cred.status, 201);
  assert.deepEqual(await accessOf(Q.id), { peopleAndGroups: true, toldWhenPeopleChange: false });
  // In the catalogue too, before turning one on
  const catalogue = (await api('GET', '/applications?limit=100', { cookie: admin })).json.applications;
  assert.equal(catalogue.find((a: any) => a.id === Q.id).dataAccess.peopleAndGroups, true);
  assert.equal(catalogue.find((a: any) => a.id === Q.id).userEvents, undefined, 'the raw setting is for platform staff');
  assert.equal((await api('DELETE', `/applications/${Q.id}/service-credentials/${cred.json.id}`, { cookie: platform })).status, 204);
  assert.equal((await accessOf(Q.id)).peopleAndGroups, false, 'revoked: no longer');

  // Off on the Lifecycle events panel: no more user events, records gone
  const off = await api('PUT', `/applications/${P.id}/lifecycle`, { cookie: platform, body: { callbackUrl, deletesDataOnDeprovision: false, userEvents: false } });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  const { controlDb } = await db();
  assert.equal(await controlDb.productMemberState.count({ where: { applicationId: P.id } }), 0);
  const from = received.length;
  assert.equal((await api('PATCH', `/users/${ids[A.managerEmail]}`, { cookie: admin, body: { name: 'Max' } })).status, 200);
  await sleep(1000);
  assert.deepEqual(received.slice(from).filter((e) => e.type.startsWith('user.')), []);
  assert.equal((await accessOf(P.id)).toldWhenPeopleChange, false);
  // The manifest export says so
  assert.equal((await api('GET', `/applications/${P.id}/manifest`, { cookie: platform })).json.provisioning.userEvents, false);
});
