/**
 * Per-application limits by plan and usage reporting (docs/hub/HUB_GAPS.md
 * G6; lib/product-limits.ts, lib/product-usage.ts): declared in manifest v2,
 * values set per plan by platform staff, sent with lifecycle events and
 * readable on the organization, told again when they change (a plan change,
 * a new value); usage reported (idempotent, checked) and totalled per month
 * for the application, platform staff and the organization's administrators.
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
const sfx = randomBytes(3).toString('hex');
const key = `forge-${sfx}`;
let app: { id: string };
let token: string; // organizations.read usage.report

const bearer = (t: string, body?: unknown) => ({ headers: { authorization: `Bearer ${t}` }, ...(body === undefined ? {} : { body }) });
const manifest = (extra: Record<string, unknown> = {}) => ({
  manifestVersion: 2, productId: key, name: `Forge ${sfx}`, version: '1.0.0', baseUrl: `https://${key}.example.com`,
  signIn: { clientType: 'CONFIDENTIAL', redirectUris: [`https://${key}.example.com/cb`] },
  provisioning: { callbackUrl },
  limits: [
    { key: `${key}.workflow_runs`, label: 'Workflow runs a month', type: 'integer', unlimited: true, default: 100, unit: 'runs' },
    { key: `${key}.ai`, label: 'AI assistant', type: 'boolean', default: false },
  ],
  usage: [{ key: `${key}.ai_tokens`, label: 'AI tokens', unit: 'tokens' }],
  ...extra,
});
const eventsOf = (type: string) => received.filter((e) => e.type === type && e.data.application.key === key && e.data.organization.id === A.tenantId);
async function waitFor<T>(what: string, find: () => T | undefined): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const v = find();
    if (v !== undefined) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

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
  A = await seedTenant('lim-a');
  const PS = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', PS.adminEmail)).cookie;
  admin = (await loginSession(A.slug, A.adminEmail)).cookie;
  const res = await api('POST', '/applications/manifest', { cookie: platform, body: manifest() });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.deepEqual(res.json.limits, { added: [`${key}.workflow_runs`, `${key}.ai`], updated: [], retired: [], meters: 1 });
  app = { id: res.json.application.id };
  const c = await api('POST', `/applications/${app.id}/service-credentials`, { cookie: platform, body: { name: 'Server', scopes: ['organizations.read', 'usage.report'] } });
  const t = await fetch(`${baseUrl()}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${c.json.clientId}:${c.json.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'organizations.read usage.report' }),
  });
  token = ((await t.json()) as { access_token: string }).access_token;
});
after(async () => {
  receiver.close();
  const { controlDb } = await db();
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: app?.id } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: app?.id } });
  await stopServerAndCleanUp();
});

test('manifest limits and meters: checked, exported as imported', async () => {
  const problems = async (body: Record<string, unknown>) => {
    const res = await api('POST', '/applications/manifest?dryRun=true', { cookie: platform, body });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    return String(res.json.message);
  };
  assert.match(await problems(manifest({ limits: [{ key: 'other.x', label: 'X', type: 'boolean', default: true }] })), /must start with/);
  assert.match(await problems(manifest({ limits: [{ key: `${key}.x`, label: 'X', type: 'integer', default: null }] })), /needs "unlimited": true/);
  assert.match(await problems(manifest({ usage: [{ key: `${key}.workflow_runs`, label: 'Runs', unit: 'runs' }] })), /listed twice/);
  assert.match(await problems({ ...manifest(), manifestVersion: 1, provisioning: undefined }), /limits: needs "manifestVersion": 2/);
  const exported = (await api('GET', `/applications/${app.id}/manifest`, { cookie: platform })).json;
  assert.deepEqual(exported.limits, manifest().limits);
  assert.deepEqual(exported.usage, manifest().usage);
});

test('limits follow the plan: sent with organization.entitled, on the organization, and told again when a value or the plan changes', async () => {
  // Staff give PROFESSIONAL more before anyone has it
  const set = await api('PUT', `/applications/${app.id}/limits/${key}.workflow_runs`, { cookie: platform, body: { values: { PROFESSIONAL: 5000, ENTERPRISE: null } } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal((await api('PUT', `/applications/${app.id}/limits/${key}.ai`, { cookie: platform, body: { values: { STARTER: 12 } } })).status, 400, 'a boolean needs true or false');
  assert.equal((await api('PUT', `/applications/${app.id}/limits/${key}.ai`, { cookie: platform, body: { values: { FREE: null } } })).status, 400);
  const listed = (await api('GET', `/applications/${app.id}/limits`, { cookie: platform })).json;
  assert.deepEqual(listed.limits.find((l: any) => l.key === `${key}.workflow_runs`).values, { PROFESSIONAL: 5000, ENTERPRISE: null });

  const { controlDb } = await db();
  // On FREE, which has no values of its own
  await controlDb.tenant.update({ where: { id: A.tenantId }, data: { plan: 'FREE' } });
  assert.equal((await api('POST', '/tenant-applications', { cookie: admin, body: { applicationId: app.id, state: 'ENABLED' } })).status, 201);
  const entitled = await waitFor('organization.entitled', () => eventsOf('organization.entitled')[0]);
  assert.deepEqual(entitled.data.limits, { [`${key}.workflow_runs`]: 100, [`${key}.ai`]: false }, 'its plan has no values: the defaults');
  const org = (await api('GET', `/v1/product-integrations/organizations/${A.tenantId}`, bearer(token))).json;
  assert.deepEqual(org.limits, entitled.data.limits);

  // The organization moves to PROFESSIONAL: told the new limits, once
  const platformPatch = await api('PATCH', `/tenants/${A.tenantId}`, { cookie: platform, body: { plan: 'PROFESSIONAL' } });
  assert.equal(platformPatch.status, 200, JSON.stringify(platformPatch.json));
  const changed = await waitFor('organization.entitlement_changed', () => eventsOf('organization.entitlement_changed')[0]);
  assert.deepEqual([changed.data.limits[`${key}.workflow_runs`], changed.data.changed], [5000, ['limits']]);
  const { reconcileLimits } = await import('../src/lib/product-limits.js');
  assert.equal(await reconcileLimits({ applicationId: app.id }), 0, 'nothing new to tell');

  // Staff turn the AI assistant on for PROFESSIONAL: told again
  assert.equal((await api('PUT', `/applications/${app.id}/limits/${key}.ai`, { cookie: platform, body: { values: { PROFESSIONAL: true } } })).status, 200);
  const again = await waitFor('the second change', () => eventsOf('organization.entitlement_changed')[1]);
  assert.equal(again.data.limits[`${key}.ai`], true);
  // Recorded in the platform audit log
  const audit = (await api('GET', '/platform-audit?limit=20', { cookie: platform })).json;
  assert.ok(JSON.stringify(audit).includes('application.plan_limits_changed'));
});

test('usage: reported for declared meters (idempotent, checked), totalled for the month', async () => {
  const path = `/v1/product-integrations/organizations/${A.tenantId}/usage`;
  let res = await api('POST', path, bearer(token, { records: [
    { key: `${key}.ai_tokens`, quantity: 1200, idempotencyKey: 'r1' },
    { key: `${key}.ai_tokens`, quantity: 300.5, idempotencyKey: 'r2' },
  ] }));
  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.deepEqual(res.json, { accepted: 2, duplicates: 0 });
  res = await api('POST', path, bearer(token, { key: `${key}.ai_tokens`, quantity: 1200, idempotencyKey: 'r1' }));
  assert.deepEqual(res.json, { accepted: 0, duplicates: 1 }, 'sent again: skipped');

  const refused = async (body: unknown, re: RegExp) => {
    const r = await api('POST', path, bearer(token, body));
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(JSON.stringify(r.json), re);
  };
  await refused({ key: `${key}.storage`, quantity: 1 }, /isn't one of this application's meters/);
  await refused({ key: `${key}.ai_tokens`, quantity: -1 }, /quantity/);
  await refused({ key: `${key}.ai_tokens`, quantity: 1, occurredAt: new Date(Date.now() + 86_400_000).toISOString() }, /in the future/);
  await refused({ key: `${key}.ai_tokens`, quantity: 1, occurredAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }, /more than 35 days ago/);
  await refused({ records: [{ key: `${key}.ai_tokens`, quantity: 1, idempotencyKey: 'x' }, { key: `${key}.ai_tokens`, quantity: 1, idempotencyKey: 'x' }] }, /used twice/);

  const forApp = (await api('GET', path, bearer(token))).json;
  assert.deepEqual(forApp.meters.map((m: any) => [m.key, m.total, m.records]), [[`${key}.ai_tokens`, 1500.5, 2]]);

  const forStaff = (await api('GET', `/applications/${app.id}/usage`, { cookie: platform })).json;
  assert.equal(forStaff.meters[0].total, 1500.5);
  assert.deepEqual(forStaff.organizations.map((o: any) => [o.id, o.used[`${key}.ai_tokens`]]), [[A.tenantId, 1500.5]]);

  // The organization's administrators: limits on their plan and usage this month
  const mine = (await api('GET', '/tenant-applications', { cookie: admin })).json.tenantApplications.find((t: any) => t.applicationId === app.id).application;
  assert.deepEqual(mine.limits.map((l: any) => [l.key, l.value]), [[`${key}.workflow_runs`, 5000], [`${key}.ai`, true]]);
  assert.deepEqual(mine.usage.meters.map((m: any) => [m.label, m.total]), [['AI tokens', 1500.5]]);
});
