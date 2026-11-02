/**
 * Catalogue routes return chosen fields only (lib/application-fields.ts):
 * never the lifecycle signing secrets (even encrypted), and to
 * organizations neither the callback address nor which other organizations
 * use an application.
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
let app: { id: string; key: string };

before(async () => {
  A = await seedTenant('af-a');
  B = await seedTenant('af-b');
  const P = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', P.adminEmail)).cookie;
  adminA = (await loginSession(A.slug, A.adminEmail)).cookie;
  adminB = (await loginSession(B.slug, B.adminEmail)).cookie;
  const key = `af-${randomBytes(3).toString('hex')}`;
  const res = await api('POST', '/applications/manifest', {
    cookie: platform,
    body: {
      manifestVersion: 1, productId: key, name: `Fields ${key}`, version: '1.0.0', baseUrl: 'https://af.example.com',
      signIn: { clientType: 'CONFIDENTIAL', redirectUris: ['https://af.example.com/cb'] },
      provisioning: { callbackUrl: 'http://127.0.0.1:9/events' },
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  app = { id: res.json.application.id, key };
  // B has it, so A could otherwise learn that
  assert.equal((await api('POST', '/tenant-applications', { cookie: adminB, body: { applicationId: app.id, state: 'ENABLED' } })).status, 201);
});
after(async () => {
  const { controlDb } = await db();
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: app.id } });
  await controlDb.applicationRegistry.delete({ where: { id: app.id } });
  await stopServerAndCleanUp();
});

const SECRET = /enc:v\d+:|whsec_|callbackSigningSecret|previousCallbackSigningSecret/;

test('the signing secrets are in no catalogue response, for anyone', async () => {
  const { controlDb } = await db();
  assert.ok((await controlDb.applicationRegistry.findUniqueOrThrow({ where: { id: app.id } })).callbackSigningSecret, 'it has one');
  const entitlement = await controlDb.tenantApplication.findFirstOrThrow({ where: { applicationId: app.id, tenantId: B.tenantId } });
  const responses = [
    await api('GET', '/applications?limit=100', { cookie: platform }),
    await api('GET', `/applications/${app.id}`, { cookie: platform }),
    await api('PATCH', `/applications/${app.id}`, { cookie: platform, body: { description: 'Changed' } }),
    await api('GET', '/applications?limit=100', { cookie: adminA }),
    await api('GET', `/applications/${app.id}`, { cookie: adminA }),
    await api('GET', `/tenant-applications/${entitlement.id}`, { cookie: adminB }),
    await api('GET', '/tenant-applications', { cookie: adminB }),
  ];
  for (const [i, r] of responses.entries()) {
    assert.equal(r.status, 200, `response ${i}: ${JSON.stringify(r.json)}`);
    assert.doesNotMatch(JSON.stringify(r.json), SECRET, `response ${i}`);
  }
  const created = await api('POST', '/applications', { cookie: platform, body: { key: `af-new-${randomBytes(2).toString('hex')}`, name: 'Made by hand' } });
  assert.equal(created.status, 201);
  assert.doesNotMatch(JSON.stringify(created.json), SECRET);
  await controlDb.applicationRegistry.delete({ where: { id: created.json.id } });
});

test("organizations see what an application is, not how it's integrated or who else uses it", async () => {
  const list = await api('GET', '/applications?limit=100', { cookie: adminA });
  const mine = list.json.applications.find((a: any) => a.id === app.id);
  assert.equal(mine.name, `Fields ${app.key}`);
  assert.equal(mine.provisioningCallbackUrl, undefined);
  assert.equal(mine._count.tenantApplications, undefined, 'not how many organizations use it');

  const one = await api('GET', `/applications/${app.id}`, { cookie: adminA });
  assert.equal(one.json.tenantApplications, undefined, 'not which organizations use it');
  assert.doesNotMatch(JSON.stringify(one.json), new RegExp(B.slug));
  assert.equal(one.json.provisioningCallbackUrl, undefined);

  // Platform staff still see it all
  const staff = await api('GET', `/applications/${app.id}`, { cookie: platform });
  assert.equal(staff.json.provisioningCallbackUrl, 'http://127.0.0.1:9/events');
  assert.ok(staff.json.tenantApplications.some((t: any) => t.tenant.slug === B.slug));
  assert.equal((await api('GET', '/applications?limit=100', { cookie: platform })).json.applications.find((a: any) => a.id === app.id)._count.tenantApplications, 1);
});
