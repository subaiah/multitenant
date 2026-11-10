/**
 * Manifest version 2's first part and the platform's services for external
 * products (docs/hub/HUB_GAPS.md G3; lib/product-services.ts): declared
 * notification and audit event types, sending notifications to an
 * organization's people and writing to its audit log, with the safeguards;
 * organizations see a product's types only when they have it on.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TenantSeed } from './helpers.js';

// Emails go to a file, read like an inbox
const outbox = join(mkdtempSync(join(tmpdir(), 'mail-')), 'outbox.jsonl');
process.env.EMAIL_TRANSPORT = 'file';
process.env.MAIL_OUTBOX_FILE = outbox;
const { api, baseUrl, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp } = await import('./helpers.js');
const mails = (to: string) => (existsSync(outbox) ? readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { to: string; subject: string; text: string; html: string }).filter((m) => m.to === to) : []);

let A: TenantSeed; // has the product
let B: TenantSeed; // doesn't
let platform: string;
let adminA: string;
let adminB: string;
let key: string;
let appId: string;
let token: string; // notifications.send, audit.write
let readOnly: string; // organizations.read only
const productIds: string[] = [];
const BASE = 'https://forge.example.com';

const manifest = (k: string, extra: Record<string, unknown> = {}) => ({
  manifestVersion: 2,
  productId: k,
  name: `Forge ${k.slice(-4)}`,
  version: '2.0.0',
  kind: 'generic',
  baseUrl: BASE,
  signIn: { clientType: 'CONFIDENTIAL', redirectUris: [`${BASE}/cb`] },
  permissions: [{ name: `${k}:admin`, description: 'Manage it' }],
  menu: [],
  platformServices: {
    notifications: [
      { type: `${k}.mention`, label: 'Someone mentioned you', description: 'In a conversation', defaultChannels: ['in_app'] },
      { type: `${k}.digest`, label: 'Daily digest', defaultChannels: ['in_app', 'email'] },
    ],
    auditEvents: [{ type: `${k}.record.deleted`, label: 'Record deleted' }],
  },
  ...extra,
});

async function eventually<T>(fn: () => Promise<T>, what: string, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v && (!Array.isArray(v) || v.length)) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const inbox = async (cookie: string) => (await api('GET', '/notifications', { cookie })).json.data as { type: string; title: string; body: string | null; link: string | null }[];
const userId = async (t: TenantSeed, email: string) => (await t.db.user.findFirstOrThrow({ where: { tenantId: t.tenantId, email } })).id;
const subject = async (t: TenantSeed, email: string) => `${t.tenantId}.${await userId(t, email)}`;
async function tokenFor(clientId: string, secret: string, scope: string) {
  const res = await fetch(`${baseUrl()}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }),
  });
  const json = (await res.json()) as Record<string, string>;
  assert.equal(res.status, 200, JSON.stringify(json));
  return json.access_token;
}
const as = (t: string, body?: unknown) => ({ headers: { authorization: `Bearer ${t}` }, ...(body !== undefined && { body }) });

before(async () => {
  process.env.BFF_URL = baseUrl();
  A = await seedTenant('ps-a');
  B = await seedTenant('ps-b');
  const P = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', P.adminEmail)).cookie;
  adminA = (await loginSession(A.slug, A.adminEmail)).cookie;
  adminB = (await loginSession(B.slug, B.adminEmail)).cookie;
  key = `ps-${randomBytes(3).toString('hex')}`;
  productIds.push(key);
  const res = await api('POST', '/applications/manifest', { cookie: platform, body: manifest(key) });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  appId = res.json.application.id;
  assert.deepEqual(res.json.platformServices, { added: [`${key}.mention`, `${key}.digest`, `${key}.record.deleted`], updated: [], retired: [] });
  assert.equal((await api('POST', '/tenant-applications', { cookie: adminA, body: { applicationId: appId, state: 'ENABLED' } })).status, 201);
  const cred = await api('POST', `/applications/${appId}/service-credentials`, { cookie: platform, body: { name: 'Server', scopes: ['notifications.send', 'audit.write'] } });
  assert.equal(cred.status, 201, JSON.stringify(cred.json));
  token = await tokenFor(cred.json.clientId, cred.json.clientSecret, 'notifications.send audit.write');
  const reader = await api('POST', `/applications/${appId}/service-credentials`, { cookie: platform, body: { name: 'Reader', scopes: ['organizations.read'] } });
  readOnly = await tokenFor(reader.json.clientId, reader.json.clientSecret, 'organizations.read');
});
after(async () => {
  const { controlDb } = await db();
  const apps = await controlDb.applicationRegistry.findMany({ where: { key: { in: productIds } }, select: { id: true } });
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: { in: apps.map((a) => a.id) } } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: { in: apps.map((a) => a.id) } } });
  await stopServerAndCleanUp();
});

test('manifest version 2: kind and declared types; exported as they were; future fields and version 1 misuse refused, not dropped', async () => {
  const exported = await api('GET', `/applications/${appId}/manifest`, { cookie: platform });
  assert.deepEqual(exported.json, manifest(key), 'the export is the manifest');

  const problems = async (body: unknown) => {
    const r = await api('POST', '/applications/manifest?dryRun=true', { cookie: platform, body });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    return String(r.json.message);
  };
  const v1 = { ...manifest(key), manifestVersion: 1 };
  assert.match(await problems(v1), /platformServices: needs "manifestVersion": 2/);
  assert.match(await problems(manifest(key, { embeds: [] })), /embeds: not supported by this platform yet/);
  const badName = manifest(key);
  (badName.platformServices.auditEvents as { type: string; label: string }[]).push({ type: 'other.thing', label: 'X' }, { type: `${key}.Bad Name`, label: 'Y' });
  const msg = await problems(badName);
  assert.match(msg, new RegExp(`"other.thing" must start with "${key}."`));
  assert.match(msg, /use lowercase letters/);
  // A product whose id is a platform prefix can't take the platform's own types
  assert.match(await problems({ ...manifest('auth'), platformServices: { notifications: [], auditEvents: [{ type: 'auth.signed_in', label: 'Mine' }] } }), /is one of the platform's own types/);

  // Leaving one out retires it (kept, can't be used); putting it back brings it back
  const without = manifest(key);
  without.platformServices.notifications = without.platformServices.notifications.slice(0, 1);
  const r1 = await api('POST', '/applications/manifest', { cookie: platform, body: without });
  assert.deepEqual(r1.json.platformServices, { added: [], updated: [], retired: [`${key}.digest`] });
  const back = await api('POST', '/applications/manifest', { cookie: platform, body: manifest(key) });
  assert.deepEqual(back.json.platformServices, { added: [], updated: [`${key}.digest`], retired: [] });
  // A version 1 manifest leaves them, and the kind, alone
  const { kind: _k, platformServices: _p, ...v1Clean } = v1;
  const r2 = await api('POST', '/applications/manifest', { cookie: platform, body: v1Clean });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  assert.deepEqual(r2.json.platformServices, { leftAlone: true });
  const { controlDb } = await db();
  assert.equal((await controlDb.applicationRegistry.findUniqueOrThrow({ where: { id: appId } })).kind, 'generic');
  assert.equal(await controlDb.productDeclaredType.count({ where: { applicationId: appId, retiredAt: null } }), 3);
  await api('POST', '/applications/manifest', { cookie: platform, body: manifest(key) });
});

test("notifications: the product's declared types, to people in the organization, plain text with links only to its own pages", async () => {
  const user = await loginSession(A.slug, A.userEmail);
  const send = (body: unknown, t = token, org = A.tenantId) => api('POST', `/v1/product-integrations/organizations/${org}/notifications`, as(t, body));
  const to = { subjects: [await subject(A, A.userEmail)] };

  const ok = await send({ type: `${key}.mention`, title: 'Priya mentioned you', body: 'On deal <b>42</b>', link: '/deals/42', to });
  assert.equal(ok.status, 202, JSON.stringify(ok.json));
  const got = await eventually(async () => (await inbox(user.cookie)).filter((n) => n.type === `${key}.mention`), 'the notification');
  assert.equal(got[0].title, `Forge ${key.slice(-4)}: Priya mentioned you`, "always titled with the product's name");
  assert.equal(got[0].body, 'On deal <b>42</b>', 'kept as text (shown as text, never as HTML)');
  assert.equal(got[0].link, `${BASE}/deals/42`);

  // Email: an absolute link stays as it is; the body is escaped, never HTML
  assert.equal((await send({ type: `${key}.digest`, title: 'Your day', body: 'See <a href="https://evil.example.com">this</a>', link: `${BASE}/today`, to })).status, 202);
  const mail = await eventually(async () => mails(A.userEmail).filter((m) => m.subject.includes('Your day')), 'the email');
  assert.ok(mail[0].html.includes(`${BASE}/today`) && mail[0].text.includes(`${BASE}/today`));
  assert.ok(!mail[0].html.includes('<a href="https://evil.example.com">'), 'not rendered as HTML');

  // Everyone holding one of its permissions (administrators hold them all)
  assert.equal((await send({ type: `${key}.mention`, title: 'For admins', to: { permission: `${key}:admin` } })).status, 202);
  await eventually(async () => (await inbox(adminA)).filter((n) => n.title.endsWith('For admins')), 'the admins');

  // Refused
  const refused = async (body: unknown, status: number, code: string, t = token, org = A.tenantId) => {
    const r = await send(body, t, org);
    assert.deepEqual([r.status, r.json.code], [status, code], JSON.stringify(r.json));
  };
  await refused({ type: `${key}.mention`, title: 'x', link: 'https://evil.example.com/login', to }, 400, 'INVALID_LINK');
  await refused({ type: `${key}.mention`, title: 'x', link: '//evil.example.com/login', to }, 400, 'INVALID_LINK');
  await refused({ type: `${key}.mention`, title: 'x', to: { subjects: [await subject(B, B.userEmail)] } }, 400, 'UNKNOWN_RECIPIENTS');
  await refused({ type: `${key}.mention`, title: 'x', to: { subjects: [`${A.tenantId}.00000000-0000-0000-0000-000000000000`] } }, 400, 'UNKNOWN_RECIPIENTS');
  await refused({ type: 'auth.mfa_failed', title: 'x', to }, 400, 'UNKNOWN_TYPE');
  await refused({ type: `${key}.record.deleted`, title: 'x', to }, 400, 'UNKNOWN_TYPE');
  await refused({ type: `${key}.mention`, title: 'x', to: { permission: 'users:read' } }, 400, 'UNKNOWN_PERMISSION');
  await refused({ type: `${key}.mention`, title: 'x', to: { subjects: [await subject(B, B.userEmail)] } }, 404, 'NOT_FOUND', token, B.tenantId);
  await refused({ type: `${key}.mention`, title: 'x', to }, 403, 'INSUFFICIENT_SCOPE', readOnly);

  // The organization's rules apply: turned off, nothing arrives
  assert.equal((await api('PUT', '/notification-settings', { cookie: adminA, body: { settings: { [`${key}.mention`]: { enabled: false, inApp: true, email: true, mandatory: false } } } })).status, 200);
  assert.equal((await send({ type: `${key}.mention`, title: 'Turned off', to })).status, 202);
  await sleep(1500);
  assert.equal((await inbox(user.cookie)).filter((n) => n.title.endsWith('Turned off')).length, 0);
});

test("organizations see a product's types only when they have it on", async () => {
  const user = await loginSession(A.slug, A.userEmail);
  const settingsA = (await api('GET', '/notification-settings', { cookie: adminA })).json.types.map((t: { type: string }) => t.type);
  const settingsB = (await api('GET', '/notification-settings', { cookie: adminB })).json.types.map((t: { type: string }) => t.type);
  assert.ok(settingsA.includes(`${key}.digest`) && !settingsB.includes(`${key}.digest`));
  const prefs = (await api('GET', '/notifications/preferences', { cookie: user.cookie })).json.map((p: { type: string }) => p.type);
  assert.ok(prefs.includes(`${key}.digest`));
  const auditA = (await api('GET', '/audit/events', { cookie: adminA })).json.map((e: { key: string }) => e.key);
  const auditB = (await api('GET', '/audit/events', { cookie: adminB })).json.map((e: { key: string }) => e.key);
  assert.ok(auditA.includes(`${key}.record.deleted`) && !auditB.includes(`${key}.record.deleted`));
  const hooksA = (await api('GET', '/webhooks/events', { cookie: adminA })).json.events.map((e: { type: string }) => e.type);
  assert.ok(hooksA.includes(`${key}.record.deleted`), 'organizations can send them to their own systems');
  assert.equal((await api('PUT', '/notification-settings', { cookie: adminB, body: { settings: { [`${key}.digest`]: { enabled: false, inApp: true, email: true, mandatory: false } } } })).status, 400);
});

test("audit entries: the product's own (actor APPLICATION), the person it acted for recorded as onBehalfOf; the log stays verifiable", async () => {
  const write = (body: unknown, org = A.tenantId) => api('POST', `/v1/product-integrations/organizations/${org}/audit-events`, as(token, body));
  const person = await subject(A, A.managerEmail);
  const res = await write({ type: `${key}.record.deleted`, onBehalfOf: person, resource: { type: 'deal', id: '42', label: 'Big deal' }, details: { reason: 'duplicate' } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const page = (await api('GET', `/audit?event=${encodeURIComponent(`${key}.record.deleted`)}`, { cookie: adminA })).json.data;
  const e = page.find((x: { seq: number }) => x.seq === res.json.seq) ?? page[0];
  assert.equal(e.actorType, 'APPLICATION');
  assert.equal(e.actorId, key);
  assert.equal(e.category, 'application');
  assert.deepEqual(e.details.onBehalfOf, { subject: person, email: A.managerEmail });
  assert.deepEqual(e.details.application, { id: key, name: `Forge ${key.slice(-4)}` });
  assert.equal(e.details.reason, 'duplicate');
  assert.equal(e.resourceLabel, 'Big deal');
  assert.equal((await api('GET', '/audit/verify', { cookie: adminA })).json.ok, true);

  const refused = async (body: unknown, status: number, code: string, org = A.tenantId) => {
    const r = await write(body, org);
    assert.deepEqual([r.status, r.json.code], [status, code], JSON.stringify(r.json));
  };
  await refused({ type: `${key}.record.deleted`, onBehalfOf: await subject(B, B.userEmail) }, 400, 'UNKNOWN_RECIPIENTS');
  await refused({ type: 'user.deleted' }, 400, 'UNKNOWN_TYPE');
  await refused({ type: `${key}.mention` }, 400, 'UNKNOWN_TYPE');
  await refused({ type: `${key}.record.deleted` }, 404, 'NOT_FOUND', B.tenantId);
  assert.equal((await write({ type: `${key}.record.deleted`, details: { big: 'x'.repeat(5000) } })).status, 400);
});

test('a rate limit per credential', async () => {
  const { RateLimited, LIMITS } = await import('../src/lib/product-services.js');
  const services = await import('../src/lib/product-services.js');
  const caller = { applicationId: appId, productKey: key, productName: 'x', credentialId: `rl-${randomBytes(3).toString('hex')}`, credentialName: 'x', scopes: new Set<string>() };
  let limited: unknown = null;
  for (let i = 0; i <= LIMITS.notifications && !limited; i++) {
    // Fails on the body after counting; the limit is checked first
    await services.sendProductNotification(caller, A.tenantId, {}).catch((err) => {
      if (err instanceof RateLimited) limited = err;
    });
  }
  assert.ok(limited instanceof RateLimited, `refused after ${LIMITS.notifications}`);
  assert.ok((limited as InstanceType<typeof RateLimited>).retryAfter > 0);
});
