/**
 * Applications inside each other's pages (docs/hub/HUB_GAPS.md G5;
 * lib/product-embeds.ts): manifest v2 embeds, the components another
 * application may use for an organization (and why not), the organization's
 * branding with theme tokens, the launcher's list per person, and the
 * launcher script itself.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
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
let B: TenantSeed;
let platform: string;
let admin: string;
const keys: string[] = [];
let chat: { id: string; key: string };
let crm: { id: string; key: string };
let token: string; // crm: organizations.read launcher.read
let narrow: string; // crm: organizations.read

const sfx = randomBytes(3).toString('hex');
const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

function manifest(key: string, extra: Record<string, unknown> = {}) {
  return {
    manifestVersion: 2, productId: key, name: `${key}`, version: '1.0.0', baseUrl: `https://${key}.example.com`,
    signIn: { clientType: 'CONFIDENTIAL', redirectUris: [`https://${key}.example.com/cb`] },
    ...extra,
  };
}
async function importManifest(body: Record<string, unknown>) {
  const res = await api('POST', '/applications/manifest', { cookie: platform, body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  keys.push(body.productId as string);
  return res.json;
}
async function serviceToken(applicationId: string, scopes: string[]) {
  const c = await api('POST', `/applications/${applicationId}/service-credentials`, { cookie: platform, body: { name: scopes.join(' '), scopes } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const t = await fetch(`${baseUrl()}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${c.json.clientId}:${c.json.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: scopes.join(' ') }),
  });
  const json = (await t.json()) as Record<string, string>;
  assert.equal(t.status, 200, JSON.stringify(json));
  return json.access_token;
}

before(async () => {
  process.env.BFF_URL = baseUrl();
  A = await seedTenant('emb-a');
  B = await seedTenant('emb-b');
  const PS = await seedPlatformUsers();
  await startServer();
  platform = (await loginSession('platform', PS.adminEmail)).cookie;
  admin = (await loginSession(A.slug, A.adminEmail)).cookie;

  const chatKey = `chat-${sfx}`;
  const crmKey = `crm-${sfx}`;
  const c = await importManifest(manifest(chatKey, {
    kind: 'generic',
    api: { scopes: [{ name: `${chatKey}.threads:read`, description: 'Read threads', allowsOnBehalfOf: true }] },
    embeds: [{ tag: `${chatKey}-record-thread`, scriptUrl: `https://${chatKey}.example.com/embed/v1/chat.js`, attributes: ['resource'], description: 'A conversation on a record' }],
    menu: [{ label: 'Chat', path: '/' }],
  }));
  chat = { id: c.application.id, key: chatKey };
  assert.deepEqual(c.embeds, { tags: [`${chatKey}-record-thread`] });
  const r = await importManifest(manifest(crmKey, {
    permissions: [{ name: `${crmKey}.deals:read`, description: 'See deals' }, { name: `${crmKey}:admin`, description: 'Run it' }],
    consumes: [{ scope: `${chatKey}.threads:read`, reason: 'Conversations on deals' }],
    menu: [{ label: 'Deals', path: '/deals', permission: `${crmKey}.deals:read` }, { label: 'Settings', path: '/settings', permission: `${crmKey}:admin` }],
  }));
  crm = { id: r.application.id, key: crmKey };
  for (const app of [chat, crm]) assert.equal((await api('POST', '/tenant-applications', { cookie: admin, body: { applicationId: app.id, state: 'ENABLED' } })).status, 201);
  token = await serviceToken(crm.id, ['organizations.read', 'launcher.read']);
  narrow = await serviceToken(crm.id, ['organizations.read']);
});
after(async () => {
  const { controlDb } = await db();
  const apps = await controlDb.applicationRegistry.findMany({ where: { key: { in: keys } }, select: { id: true } });
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: { in: apps.map((a) => a.id) } } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: { in: apps.map((a) => a.id) } } });
  await stopServerAndCleanUp();
});

test('manifest embeds: named for the product, loaded from its own host; refused otherwise; exported as imported', async () => {
  const key = `bad-${sfx}`;
  const problems = async (body: Record<string, unknown>) => {
    const res = await api('POST', '/applications/manifest', { cookie: platform, body });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    return JSON.stringify(res.json);
  };
  const embed = (e: Record<string, unknown>) => ({ tag: `${key}-panel`, scriptUrl: `https://${key}.example.com/p.js`, description: 'A panel', ...e });
  assert.match(await problems(manifest(key, { embeds: [embed({ tag: 'other-panel' })] })), /starting with \\"bad-/);
  assert.match(await problems(manifest(key, { embeds: [embed({ scriptUrl: 'https://cdn.example.net/p.js' })] })), /own host/);
  assert.match(await problems(manifest(key, { embeds: [embed({}), embed({})] })), /listed twice/);
  assert.match(await problems(manifest(key, { embeds: [embed({ attributes: ['Resource'] })] })), /lowercase attribute/);
  assert.match(await problems({ ...manifest(key), manifestVersion: 1, embeds: [embed({})] }), /embeds: needs \\"manifestVersion\\": 2/);

  const exported = await api('GET', `/applications/${chat.id}/manifest`, { cookie: platform });
  assert.equal(exported.status, 200, JSON.stringify(exported.json));
  assert.deepEqual(exported.json.embeds, [{ tag: `${chat.key}-record-thread`, scriptUrl: `https://${chat.key}.example.com/embed/v1/chat.js`, attributes: ['resource'], description: 'A conversation on a record' }]);
});

test('the components other applications offer: usable through a token on a person’s behalf, and why not when blocked', async () => {
  const path = `/v1/product-integrations/organizations/${A.tenantId}/embeds`;
  let res = await api('GET', path, bearer(token));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  matchesContract('listProductEmbeds', res.json);
  assert.deepEqual(res.json.embeds.map((e: any) => [e.tag, e.productId, e.audience, e.usable, e.reason]), [
    [`${chat.key}-record-thread`, chat.key, `urn:mt:app:${chat.key}`, true, null],
  ]);

  // Blocked by the organization: listed, not usable, with the reason
  const blocked = await api('PUT', '/tenant-applications/connections', { cookie: admin, body: { callerApplicationId: crm.id, targetApplicationId: chat.id, blocked: true } });
  assert.equal(blocked.status, 200, JSON.stringify(blocked.json));
  res = await api('GET', path, bearer(token));
  assert.equal(res.json.embeds[0].usable, false);
  assert.match(res.json.embeds[0].reason, /blocked/);
  await api('PUT', '/tenant-applications/connections', { cookie: admin, body: { callerApplicationId: crm.id, targetApplicationId: chat.id, blocked: false } });

  // Another organization that doesn't have the CRM: not found
  assert.equal((await api('GET', `/v1/product-integrations/organizations/${B.tenantId}/embeds`, bearer(token))).status, 404);
});

test('branding: the organization’s name, logo and colour, with theme tokens', async () => {
  const { controlDb } = await db();
  await controlDb.tenant.update({ where: { id: A.tenantId }, data: { primaryColor: '#7C3AED', logoUrl: 'https://cdn.example.com/acme.png' } });
  const res = await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/branding`, bearer(narrow));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  matchesContract('getProductBranding', res.json);
  assert.equal(res.json.organization.slug, A.slug);
  assert.deepEqual([res.json.primaryColor, res.json.logoUrl], ['#7c3aed', 'https://cdn.example.com/acme.png']);
  assert.equal(res.json.theme['--mt-color-primary'], '#7c3aed');
  assert.equal(res.json.theme['--mt-color-on-primary'], '#ffffff', 'white reads better on violet');
  assert.match(res.json.portalUrl, new RegExp(`/${A.slug}/login$`));

  const { contrastOn } = await import('../src/lib/product-embeds.js');
  assert.equal(contrastOn('#000000'), '#ffffff');
  assert.equal(contrastOn('#ffffff'), '#000000');
  assert.equal(contrastOn('#facc15'), '#000000', 'black on yellow');

  // The client turns them into CSS, and won't let a value close the rule
  const client = await import('../../clients/typescript/src/index.ts' as string);
  assert.equal(client.themeCss({ '--mt-color-primary': '#7c3aed', '--mt-radius': '8px' }), ':root{--mt-color-primary:#7c3aed;--mt-radius:8px}');
  assert.equal(client.themeCss({ '--mt-color-primary': 'red}body{display:none', color: 'red' }, '.x'), '.x{}');
  assert.equal(client.launcherScriptUrl('https://app.example.com/api/v1/'), 'https://app.example.com/api/embed/v1/launcher.js');
});

test('the launcher: the applications each person can open, as the portal’s menu shows them', async () => {
  const subjectOf = async (email: string) => `${A.tenantId}.${(await A.db.user.findFirstOrThrow({ where: { tenantId: A.tenantId, email } })).id}`;
  const path = async (email: string) => `/v1/product-integrations/organizations/${A.tenantId}/members/${await subjectOf(email)}/applications`;

  const forAdmin = await api('GET', await path(A.adminEmail), bearer(token));
  assert.equal(forAdmin.status, 200, JSON.stringify(forAdmin.json));
  matchesContract('getProductLauncher', forAdmin.json);
  const mine = forAdmin.json.applications.filter((a: any) => [chat.key, crm.key].includes(a.productId));
  assert.deepEqual(mine.map((a: any) => [a.productId, a.current, a.url, a.entries.length]), [
    [chat.key, false, `https://${chat.key}.example.com/`, 1],
    [crm.key, true, `https://${crm.key}.example.com/deals`, 2],
  ]);
  assert.equal(forAdmin.json.organization.name, (await (await db()).controlDb.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).name);

  // Someone without the CRM's permissions doesn't see it (they can't open a page in it)
  const forUser = await api('GET', await path(A.userEmail), bearer(token));
  const theirs = forUser.json.applications.map((a: any) => a.productId);
  assert.ok(theirs.includes(chat.key) && !theirs.includes(crm.key), JSON.stringify(theirs));

  assert.equal((await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/members/${A.tenantId}.00000000-0000-0000-0000-000000000000/applications`, bearer(token))).status, 404);
  const other = `${B.tenantId}.${(await B.db.user.findFirstOrThrow({ where: { tenantId: B.tenantId, email: B.adminEmail } })).id}`;
  assert.equal((await api('GET', `/v1/product-integrations/organizations/${A.tenantId}/members/${other}/applications`, bearer(token))).status, 404, 'a person of another organization');
  assert.equal((await api('GET', await path(A.adminEmail), bearer(narrow))).status, 403, 'needs launcher.read');
});

test('the launcher script: public, usable from other sites, cached', async () => {
  const res = await fetch(`${baseUrl()}/embed/v1/launcher.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.match(res.headers.get('cache-control') ?? '', /public/);
  const body = await res.text();
  assert.match(body, /customElements\.define\('mt-app-launcher'/);
  const assigned = [...body.matchAll(/innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(assigned, ['GRID'], 'only the fixed icon goes through innerHTML, nothing from the data');
  const again = await fetch(`${baseUrl()}/embed/v1/launcher.js`, { headers: { 'if-none-match': res.headers.get('etag')! } });
  assert.equal(again.status, 304);
});
