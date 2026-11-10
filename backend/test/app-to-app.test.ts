/**
 * Applications calling each other (docs/adr/0001-app-to-app-calls.md;
 * lib/app-connections.ts, lib/oidc/token-exchange.ts): a "CRM" consumes
 * scopes a "chat" application exposes; machine calls with client
 * credentials, calls on behalf of a person with token exchange; tokens
 * checked with the TypeScript client's verifier, as the target would;
 * organizations see and block connections.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Browser, REDIRECT, signIn, token, useDiscovery } from './oidc-rp.js';
import { api, baseUrl, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed; // has both
let B: TenantSeed; // has only the chat application
let platform: string;
let adminA: string;
const productIds: string[] = [];
let chat: { id: string; key: string; clientId: string; secret: string };
let crm: { id: string; key: string; clientId: string; secret: string };
let service: { clientId: string; clientSecret: string }; // the CRM's service credential
// The TypeScript client (clients/typescript), loosely typed here
let client: {
  createAppTokens: (o: { tokenUrl: string; clientId: string; clientSecret: string }) => {
    forOrganization: (target: string, org: string, scopes: string[]) => Promise<string>;
    onBehalfOf: (subjectToken: string, target: string, scopes?: string[]) => Promise<string>;
  };
  createAppTokenVerifier: (o: { issuer: string; productId: string }) => (auth: string) => Promise<{ tenantId: string; productId: string; scopes: Set<string>; person: { subject: string; permissions: string[] } | null; claims: Record<string, unknown> }>;
};

const issuer = () => `${baseUrl()}/oidc`;
const basic = (id: string, secret: string) => ({ id, secret });

before(async () => {
  process.env.BFF_URL = baseUrl();
  A = await seedTenant('a2a-a');
  B = await seedTenant('a2a-b');
  const P = await seedPlatformUsers();
  await startServer();
  useDiscovery((await api('GET', '/oidc/.well-known/openid-configuration')).json);
  platform = (await loginSession('platform', P.adminEmail)).cookie;
  adminA = (await loginSession(A.slug, A.adminEmail)).cookie;
  const adminB = (await loginSession(B.slug, B.adminEmail)).cookie;
  const source = '../../clients/typescript/src/index.ts';
  client = await import(source);

  const sfx = randomBytes(3).toString('hex');
  const chatKey = `chat-${sfx}`;
  const crmKey = `crm-${sfx}`;
  productIds.push(chatKey, crmKey);
  const imported = async (body: Record<string, unknown>) => {
    const r = await api('POST', '/applications/manifest', { cookie: platform, body });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json;
  };
  const c = await imported({
    manifestVersion: 2, productId: chatKey, name: 'Chat', version: '1.0.0', kind: 'generic', baseUrl: 'https://chat.example.com',
    signIn: { clientType: 'CONFIDENTIAL', redirectUris: [REDIRECT] },
    permissions: [{ name: `${chatKey}:admin`, description: 'Manage chat' }, { name: `${chatKey}.channels:create`, description: 'Create channels' }],
    api: {
      scopes: [
        { name: `${chatKey}.threads:read`, description: 'Read record threads', allowsOnBehalfOf: true },
        { name: `${chatKey}.threads:write`, description: 'Start and post to threads', allowsOnBehalfOf: true },
        { name: `${chatKey}.messages:post`, description: 'Post as a bot' },
      ],
      openApiUrl: 'https://chat.example.com/openapi.json',
    },
  });
  chat = { id: c.application.id, key: chatKey, clientId: c.clientId, secret: c.clientSecret };
  const r = await imported({
    manifestVersion: 2, productId: crmKey, name: 'CRM', version: '1.0.0', baseUrl: 'https://crm.example.com',
    signIn: { clientType: 'CONFIDENTIAL', redirectUris: [REDIRECT] },
    consumes: [
      { scope: `${chatKey}.threads:read`, reason: 'Show the conversation on a deal' },
      { scope: `${chatKey}.threads:write`, reason: 'Start a conversation when a deal is created' },
      { scope: `${chatKey}.messages:post`, reason: 'Post deal updates' },
    ],
  });
  crm = { id: r.application.id, key: crmKey, clientId: r.clientId, secret: r.clientSecret };
  assert.deepEqual(r.api, { added: [], updated: [], retired: [], consumes: 3, notExposedYet: [] });
  for (const id of [chat.id, crm.id]) assert.equal((await api('POST', '/tenant-applications', { cookie: adminA, body: { applicationId: id, state: 'ENABLED' } })).status, 201);
  assert.equal((await api('POST', '/tenant-applications', { cookie: adminB, body: { applicationId: chat.id, state: 'ENABLED' } })).status, 201);
  const cred = await api('POST', `/applications/${crm.id}/service-credentials`, { cookie: platform, body: { name: 'CRM server', scopes: ['organizations.read'] } });
  service = cred.json;
});
after(async () => {
  const { controlDb } = await db();
  const apps = await controlDb.applicationRegistry.findMany({ where: { key: { in: productIds } }, select: { id: true } });
  await controlDb.tenantApplication.deleteMany({ where: { applicationId: { in: apps.map((a) => a.id) } } });
  await controlDb.applicationRegistry.deleteMany({ where: { id: { in: apps.map((a) => a.id) } } });
  await stopServerAndCleanUp();
});

const machine = (params: Record<string, string>) => token({ grant_type: 'client_credentials', ...params }, basic(service.clientId, service.clientSecret));
const exchange = (subject: string, params: Record<string, string> = {}, who = basic(service.clientId, service.clientSecret)) => token({
  grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
  subject_token: subject,
  subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  resource: `urn:mt:app:${chat.key}`,
  ...params,
}, who);

/** A person signs in to an application and gets its access token */
async function personToken(t: TenantSeed, email: string, app: { clientId: string; secret: string }) {
  const browser = new Browser((await loginSession(t.slug, email)).cookie);
  const ok = await signIn(browser, app.clientId);
  const code = ok.location?.searchParams.get('code');
  assert.ok(code, `signed in (${ok.location?.href ?? ok.res.status})`);
  const t2 = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: ok.verifier }, basic(app.clientId, app.secret));
  assert.equal(t2.status, 200, JSON.stringify(t2.json));
  return t2.json.access_token as string;
}

test('manifest version 2: exposed and consumed scopes, exported as they were; mistakes refused', async () => {
  const exported = (await api('GET', `/applications/${chat.id}/manifest`, { cookie: platform })).json;
  assert.equal(exported.api.scopes.length, 3);
  assert.equal(exported.api.openApiUrl, 'https://chat.example.com/openapi.json');
  assert.equal((await api('GET', `/applications/${crm.id}/manifest`, { cookie: platform })).json.consumes.length, 3);
  const problems = async (body: Record<string, unknown>) => {
    const r = await api('POST', '/applications/manifest?dryRun=true', { cookie: platform, body });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    return String(r.json.message);
  };
  const base = { manifestVersion: 2, productId: crm.key, name: 'CRM', version: '1.0.0', baseUrl: 'https://crm.example.com', signIn: { clientType: 'CONFIDENTIAL', redirectUris: [REDIRECT] } };
  assert.match(await problems({ ...base, consumes: [{ scope: `${crm.key}.deals:read`, reason: 'x' }] }), /is this application's own scope/);
  assert.match(await problems({ ...base, consumes: [{ scope: 'not a scope', reason: 'x' }] }), /not a scope name/);
  assert.match(await problems({ ...base, api: { scopes: [{ name: 'other.thing:read', description: 'x' }] } }), /Start the resource with the application's key/);
  // A scope nobody exposes yet: a warning
  const dry = await api('POST', '/applications/manifest?dryRun=true', { cookie: platform, body: { ...base, consumes: [{ scope: 'docs.files:read', reason: 'Attach files' }] } });
  assert.deepEqual(dry.json.api.notExposedYet, ['docs.files:read']);
});

test('machine calls: a token for the target application, one organization, the consumed scopes; refused where it should be', async () => {
  const res = await machine({ resource: `urn:mt:app:${chat.key}`, organization_id: A.tenantId, scope: `${chat.key}.threads:write ${chat.key}.messages:post` });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.expires_in, 600);
  const verify = client.createAppTokenVerifier({ issuer: issuer(), productId: chat.key });
  const caller = await verify(`Bearer ${res.json.access_token}`);
  assert.equal(caller.tenantId, A.tenantId);
  assert.equal(caller.productId, crm.key);
  assert.deepEqual([...caller.scopes].sort(), [`${chat.key}.messages:post`, `${chat.key}.threads:write`]);
  assert.equal(caller.person, null);
  // Not for another application
  await assert.rejects(client.createAppTokenVerifier({ issuer: issuer(), productId: crm.key })(`Bearer ${res.json.access_token}`), /Not a valid token/);
  // The client gets the same
  const tokens = client.createAppTokens({ tokenUrl: `${issuer()}/token`, clientId: service.clientId, clientSecret: service.clientSecret });
  const viaClient = await verify(await tokens.forOrganization(chat.key, A.tenantId, [`${chat.key}.threads:read`]));
  assert.deepEqual([...viaClient.scopes], [`${chat.key}.threads:read`]);

  const refused = async (params: Record<string, string>, error: string, description?: RegExp) => {
    const r = await machine(params);
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json.error, error, JSON.stringify(r.json));
    if (description) assert.match(r.json.error_description, description);
  };
  const target = `urn:mt:app:${chat.key}`;
  await refused({ resource: target, scope: `${chat.key}.threads:read` }, 'invalid_request', /organization_id/);
  await refused({ resource: target, organization_id: B.tenantId, scope: `${chat.key}.threads:read` }, 'access_denied', /doesn't have CRM turned on/);
  await refused({ resource: 'urn:mt:app:nobody', organization_id: A.tenantId, scope: 'x' }, 'invalid_target');
  // Its own audience: not through the platform
  const own = await token({ grant_type: 'client_credentials', resource: `urn:mt:app:${crm.key}`, organization_id: A.tenantId }, basic(service.clientId, service.clientSecret));
  assert.equal(own.json.error, 'invalid_target');
  // API v1 tokens still work as before
  const v1 = await machine({ scope: 'organizations.read' });
  assert.equal(v1.status, 200);
  assert.equal(JSON.parse(Buffer.from(v1.json.access_token.split('.')[1], 'base64url').toString()).aud, 'urn:multitenant:api:v1');
});

test("on behalf of a person: the person's own access in the target, who's acting, only scopes that allow it", async () => {
  const adminToken = await personToken(A, A.adminEmail, crm);
  const res = await exchange(adminToken, { scope: `${chat.key}.threads:read` });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.issued_token_type, 'urn:ietf:params:oauth:token-type:access_token');
  assert.equal(res.json.expires_in, 300);
  assert.equal(res.json.refresh_token, undefined, 'no refresh: exchange again');
  const verify = client.createAppTokenVerifier({ issuer: issuer(), productId: chat.key });
  const caller = await verify(`Bearer ${res.json.access_token}`);
  const adminId = (await A.db.user.findFirstOrThrow({ where: { tenantId: A.tenantId, email: A.adminEmail } })).id;
  assert.deepEqual(caller.person, { subject: `${A.tenantId}.${adminId}`, permissions: [`${chat.key}.channels:create`, `${chat.key}:admin`].sort(), scopedPermissions: [] }, "the person's permissions in the chat application (held everywhere: none scoped)");
  assert.equal(caller.tenantId, A.tenantId);
  assert.deepEqual(caller.claims.act, { sub: service.clientId, product_id: crm.key });
  // Without scope: every scope that allows on behalf of a person
  const all = await exchange(adminToken);
  assert.equal(all.json.scope, `${chat.key}.threads:read ${chat.key}.threads:write`);
  // A person without the chat application's permissions gets none
  const member = await verify(`Bearer ${(await exchange(await personToken(A, A.userEmail, crm))).json.access_token}`);
  assert.deepEqual(member.person!.permissions, []);
  // The client does the same
  const tokens = client.createAppTokens({ tokenUrl: `${issuer()}/token`, clientId: service.clientId, clientSecret: service.clientSecret });
  assert.ok((await verify(await tokens.onBehalfOf(adminToken, chat.key))).person);

  const refused = async (r: { status: number; json: Record<string, any> }, error: string, description?: RegExp) => {
    assert.equal(r.json.error, error, JSON.stringify(r.json));
    if (description) assert.match(r.json.error_description, description);
  };
  await refused(await exchange(adminToken, { scope: `${chat.key}.messages:post` }), 'invalid_scope', /Not allowed on behalf of a person/);
  await refused(await exchange('not-a-token'), 'invalid_grant');
  // A token the person got from another application isn't the caller's to exchange
  await refused(await exchange(await personToken(A, A.adminEmail, chat)), 'invalid_grant', /not issued to this application/);
  // A sign-in client can't exchange
  await refused(await exchange(adminToken, {}, basic(crm.clientId, crm.secret)), 'invalid_request', /grant type is not allowed for this client/);
  await refused(await exchange(adminToken, { subject_token_type: 'urn:ietf:params:oauth:token-type:id_token' }), 'invalid_request');
  // Deactivated: no more
  const managerToken = await personToken(A, A.managerEmail, crm);
  const managerId = (await A.db.user.findFirstOrThrow({ where: { tenantId: A.tenantId, email: A.managerEmail } })).id;
  assert.equal((await api('PATCH', `/users/${managerId}`, { cookie: adminA, body: { status: 'INACTIVE' } })).status, 200);
  await refused(await exchange(managerToken), 'invalid_grant');
  await api('PATCH', `/users/${managerId}`, { cookie: adminA, body: { status: 'ACTIVE' } });
});

test('organizations see their connections, block one (stopping new tokens at once) and allow it again; platform staff see the use', async () => {
  const list = await api('GET', '/tenant-applications/connections', { cookie: adminA });
  assert.equal(list.status, 200);
  const c = list.json.connections.find((x: any) => x.caller.id === crm.id && x.target.id === chat.id);
  assert.deepEqual(c.scopes.map((s: any) => [s.name, s.allowsOnBehalfOf]), [[`${chat.key}.threads:read`, true], [`${chat.key}.threads:write`, true], [`${chat.key}.messages:post`, false]]);
  assert.equal(c.scopes[0].reason, 'Show the conversation on a deal');
  assert.ok(c.tokensIssued >= 4, String(c.tokensIssued));
  assert.equal(c.blocked, false);
  assert.deepEqual((await api('GET', '/tenant-applications/connections', { cookie: (await loginSession(B.slug, B.adminEmail)).cookie })).json.connections, [], 'B has one of them only');

  const block = (blocked: boolean, cookie = adminA) => api('PUT', '/tenant-applications/connections', { cookie, body: { callerApplicationId: crm.id, targetApplicationId: chat.id, blocked } });
  assert.equal((await block(true, (await loginSession(A.slug, A.userEmail)).cookie)).status, 403, 'administrators only');
  assert.deepEqual((await block(true)).json, { blocked: true, changed: true });
  const machineRefused = await machine({ resource: `urn:mt:app:${chat.key}`, organization_id: A.tenantId, scope: `${chat.key}.threads:read` });
  assert.equal(machineRefused.json.error, 'access_denied');
  assert.match(machineRefused.json.error_description, /has blocked CRM from calling Chat/);
  assert.equal((await exchange(await personToken(A, A.adminEmail, crm))).json.error, 'access_denied');
  const blocked = (await api('GET', '/tenant-applications/connections', { cookie: adminA })).json.connections[0];
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.blockedByEmail, A.adminEmail);
  const entries = (await api('GET', '/audit?event=app_connection.blocked', { cookie: adminA })).json.data;
  assert.equal(entries[0].resourceLabel, 'CRM → Chat');

  assert.deepEqual((await block(false)).json, { blocked: false, changed: true });
  assert.equal((await machine({ resource: `urn:mt:app:${chat.key}`, organization_id: A.tenantId, scope: `${chat.key}.threads:read` })).status, 200);
  assert.equal((await api('PUT', '/tenant-applications/connections', { cookie: adminA, body: { callerApplicationId: chat.id, targetApplicationId: crm.id, blocked: true } })).status, 404, 'no such connection');

  const overview = (await api('GET', '/applications/integrations', { cookie: platform })).json.applications;
  const crmRow = overview.find((a: any) => a.id === crm.id);
  const chatRow = overview.find((a: any) => a.id === chat.id);
  assert.equal(crmRow.appToApp.consumes, 3);
  assert.ok(crmRow.appToApp.tokensIssued >= 5);
  assert.equal(chatRow.appToApp.exposes, 3);
});
