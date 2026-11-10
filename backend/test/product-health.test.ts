/**
 * Application health (docs/hub/HUB_GAPS.md G9; lib/product-health.ts): the
 * manifest's health address, checks that say up, degraded or (after three
 * failures in a row) down, changes audited, staff's view on the Integrations
 * page, and organizations' "having problems" without the details.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { api, baseUrl, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let platform: string;
let admin: string;
let site: Server;
let siteUrl: string;
let answer: { status: number; body: unknown } = { status: 200, body: { status: 'ok', version: '2.4.1' } };
const key = `app-${randomBytes(3).toString('hex')}`;
let appId: string;

const manifest = (extra: Record<string, unknown> = {}) => ({
  manifestVersion: 2, productId: key, name: `App ${key}`, version: '1.0.0', baseUrl: siteUrl,
  signIn: { clientType: 'CONFIDENTIAL', redirectUris: [`${siteUrl}/cb`] }, ...extra,
});

before(async () => {
  site = createServer((req, res) => {
    if (req.url !== '/health') return res.writeHead(404).end();
    res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
  });
  await new Promise<void>((r) => site.listen(0, r));
  siteUrl = `http://localhost:${(site.address() as AddressInfo).port}`;
  A = await seedTenant('health-a');
  const PS = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', PS.adminEmail)).cookie;
  admin = (await loginSession(A.slug, A.adminEmail)).cookie;
  const res = await api('POST', '/applications/manifest', { cookie: platform, body: manifest({ health: { url: `${siteUrl}/health` } }) });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  appId = res.json.application.id;
  assert.equal((await api('POST', '/tenant-applications', { cookie: admin, body: { applicationId: appId, state: 'ENABLED' } })).status, 201);
});
after(async () => {
  site.close();
  const { controlDb } = await db();
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: appId } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: appId } });
  await stopServerAndCleanUp();
});

const check = async () => {
  const { checkHealth } = await import('../src/lib/product-health.js');
  const { controlDb } = await db();
  const app = await controlDb.applicationRegistry.findUniqueOrThrow({ where: { id: appId }, select: { id: true, key: true, name: true, healthUrl: true, healthStatus: true, healthFailures: true } });
  return checkHealth({ ...app, healthUrl: app.healthUrl! });
};
const integration = async () => (await api('GET', '/applications/integrations', { cookie: platform })).json.applications.find((a: any) => a.id === appId);
const entitlement = async () => (await api('GET', '/tenant-applications', { cookie: admin })).json.tenantApplications.find((t: any) => t.applicationId === appId).application;

test('manifest health: on its own host; exported', async () => {
  const bad = await api('POST', '/applications/manifest?dryRun=true', { cookie: platform, body: manifest({ health: { url: 'https://status.example.com/health' } }) });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /own host/);
  assert.deepEqual((await api('GET', `/applications/${appId}/manifest`, { cookie: platform })).json.health, { url: `${siteUrl}/health` });
  assert.deepEqual((await integration()).health.checkedAt, null, 'not checked yet');
});

test('up, degraded, down after three failures in a row, and back up; staff see it all, organizations only that there is a problem', async () => {
  let r = await check();
  assert.deepEqual([r.status, r.version], ['UP', '2.4.1']);
  let i = await integration();
  assert.deepEqual([i.health.status, i.health.version, typeof i.health.responseMs], ['UP', '2.4.1', 'number']);
  assert.equal((await entitlement()).health, null);

  answer = { status: 200, body: { status: 'degraded', version: '2.4.1' } };
  assert.equal((await check()).status, 'DEGRADED');
  assert.deepEqual((await entitlement()).health?.problem, 'degraded');
  assert.ok((await integration()).attention.some((x: string) => /degraded/.test(x)));

  // Failing: twice is a blip (still degraded, the error shown to staff), the third time it's down
  answer = { status: 503, body: { error: 'maintenance' } };
  assert.equal((await check()).status, 'DEGRADED');
  assert.equal((await check()).status, 'DEGRADED');
  i = await integration();
  assert.equal(i.health.error, 'Answered 503');
  r = await check();
  assert.equal(r.status, 'DOWN');
  i = await integration();
  assert.ok(i.attention.includes('Not answering its health checks'));
  const e = await entitlement();
  assert.equal(e.health.problem, 'down');
  assert.equal(JSON.stringify(e).includes('503'), false, 'no details for organizations');

  answer = { status: 200, body: { status: 'nope' } };
  assert.equal((await check()).status, 'DOWN', 'an answer without a known status is a failure');
  answer = { status: 200, body: { status: 'ok', version: '2.5.0' } };
  r = await check();
  assert.deepEqual([r.status, r.version], ['UP', '2.5.0']);
  assert.equal((await entitlement()).health, null);

  // Each change in the platform audit log
  const audit = JSON.stringify((await api('GET', '/platform-audit?limit=50', { cookie: platform })).json);
  assert.ok(audit.includes('application.health_changed'));
});
