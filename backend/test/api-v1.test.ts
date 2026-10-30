/**
 * API v1 (src/api/v1.ts): every route in the contract, called with an API key
 * under /v1, answers what the contract says; each needs the permission it
 * says; the committed document (docs/api/openapi-v1.json) is the contract;
 * and the breaking-change check catches what it should.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { api, loginSession, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';
import { ENDPOINTS, SCHEMAS, openApiDocument, type Endpoint } from '../src/api/v1.js';
import { breakingChanges } from '../src/api/compat.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

let A: TenantSeed;
let admin: string;
let key: string;
let weakKey: string;

before(async () => {
  A = await seedTenant('apiv1');
  await startServer();
  admin = (await loginSession(A.slug, A.adminEmail)).cookie;
  const permissions = [...new Set(ENDPOINTS.map((e) => e.permission))];
  const made = await api('POST', '/api-keys', { cookie: admin, body: { name: 'Contract', permissions } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  key = made.json.key;
  weakKey = (await api('POST', '/api-keys', { cookie: admin, body: { name: 'Weak', permissions: ['tenant:read'] } })).json.key;
});
after(stopServerAndCleanUp);

// Responses checked against the contract's schemas
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'https://contract/', components: { schemas: SCHEMAS } });
const absolute = (s: unknown): unknown =>
  JSON.parse(JSON.stringify(s).replaceAll('"#/components/schemas/', '"https://contract/#/components/schemas/'));
const validators = new Map<string, (data: unknown) => boolean>();
function check(e: Endpoint, status: number, body: unknown) {
  assert.ok(status in e.responses, `${e.operationId}: answered ${status}, the contract says ${Object.keys(e.responses).join('/')}: ${JSON.stringify(body)}`);
  const schema = e.responses[status];
  if (schema === null) return;
  const k = `${e.operationId}:${status}`;
  if (!validators.has(k)) validators.set(k, ajv.compile(absolute(schema)));
  const validate = validators.get(k)! as ((d: unknown) => boolean) & { errors?: unknown };
  assert.ok(validate(body), `${e.operationId} ${status} doesn't match the contract: ${JSON.stringify(validate.errors)}\n${JSON.stringify(body).slice(0, 800)}`);
}

const byId = new Map(ENDPOINTS.map((e) => [e.operationId, e]));
const called = new Set<string>();
async function call(operationId: string, params: Record<string, string> = {}, body?: unknown, query = '') {
  const e = byId.get(operationId)!;
  const path = `/v1${e.path.replace(/:(\w+)/g, (_, p) => params[p])}${query}`;
  const res = await api(e.method, path, { headers: { authorization: `Bearer ${key}` }, ...(body !== undefined && { body }) });
  check(e, res.status, res.json);
  assert.equal(res.headers.get('api-version'), '1', 'answers say the version');
  called.add(operationId);
  // Without the permission: refused
  const weak = await api(e.method, path, { headers: { authorization: `Bearer ${weakKey}` }, ...(body !== undefined && { body }) });
  assert.equal(weak.status, 403, `${operationId} without ${e.permission}: ${weak.status}`);
  return res.json;
}

test('every route in the contract answers as documented, and needs its permission', async () => {
  const email = `v1-${Date.now()}@test.local`;
  // The weak key's refusals come before any change, so order the calls as a story
  const users = await call('listUsers', {}, undefined, '?limit=2');
  assert.ok(users.data.length > 0);
  const invited = await call('inviteUser', {}, { email, name: 'Contract Person' });
  await call('getUser', { id: invited.id });
  await call('updateUser', { id: invited.id }, { name: 'Contract Person 2' });

  const group = await call('createGroup', {}, { name: `Contract ${Date.now()}`, description: 'v1' });
  await call('listGroups', {}, undefined, '?limit=5');
  await call('updateGroup', { id: group.id }, { description: 'still v1' });
  await call('addGroupMember', { id: group.id }, { userId: invited.id });
  const detail = await call('getGroup', { id: group.id });
  assert.equal(detail.members[0].user.id, invited.id);
  await call('removeGroupMember', { id: group.id, userId: invited.id });

  const org = await call('createOrganization', {}, { name: `Contract org ${Date.now()}` });
  await call('listOrganizations', {}, undefined, '?limit=5');
  await call('getOrganization', { id: org.id });
  await call('updateOrganization', { id: org.id }, { description: 'v1' });
  await call('addOrganizationMember', { id: org.id }, { userId: invited.id });
  await call('removeOrganizationMember', { id: org.id, userId: invited.id });

  // A key can only give roles within its own permissions, as people can
  const small = await api('POST', '/roles', { cookie: admin, body: { name: `Readers ${Date.now()}`, permissions: ['users:read', 'groups:read'] } });
  assert.equal(small.status, 201, JSON.stringify(small.json));
  const roles = await call('listRoles');
  const role = roles.roles.find((r: { id: string }) => r.id === small.json.id);
  const assignment = await call('assignRole', {}, { roleId: role.id, principalType: 'USER', userId: invited.id });
  await call('listRoleAssignments');
  await call('removeRoleAssignment', { id: assignment.id });

  const log = await call('listAuditEntries', {}, undefined, '?limit=5');
  assert.ok(log.data.some((e: { actorType: string }) => e.actorType === 'API_KEY'), 'the key’s own changes are in the log');

  await call('deleteOrganization', { id: org.id });
  await call('deleteGroup', { id: group.id });
  await call('deleteUser', { id: invited.id });

  assert.deepEqual(ENDPOINTS.map((e) => e.operationId).filter((id) => !called.has(id)), [], 'every route in the contract was called');
});

test('/v1 is the API; the document is published', async () => {
  // The same routes without /v1 (the app's own), and the version only with it
  const plain = await api('GET', '/users?limit=1', { headers: { authorization: `Bearer ${key}` } });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('api-version'), null);
  const doc = await api('GET', '/v1/openapi.json');
  assert.equal(doc.status, 200);
  assert.equal(doc.json.openapi, '3.1.0');
  assert.deepEqual(Object.keys(doc.json.paths).sort(), Object.keys(openApiDocument().paths).sort());
  assert.match(doc.json.servers[0].url, /\/v1$/);
});

test('the committed document is the contract (run npm run openapi after changing src/api/v1.ts)', () => {
  const committed = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'api', 'openapi-v1.json'), 'utf8'));
  const current = openApiDocument();
  const broken = breakingChanges(committed, current);
  assert.deepEqual(broken, [], 'v1 must stay compatible (docs/API_V1.md)');
  assert.deepEqual(current, committed, 'docs/api/openapi-v1.json is out of date: run npm run openapi (in backend/) and commit it');
});

test('the breaking-change check catches what would break users', () => {
  const base = openApiDocument();
  const changed = (fn: (d: any) => void) => {
    const d = structuredClone(base);
    fn(d);
    return breakingChanges(base, d);
  };
  assert.deepEqual(breakingChanges(base, structuredClone(base)), []);
  // Additions are fine
  assert.deepEqual(changed((d) => {
    d.components.schemas.User.properties.nickname = { type: 'string' };
    d.paths['/users'].get.parameters.push({ name: 'sort', in: 'query', required: false, schema: { type: 'string' } });
    d.paths['/things'] = { get: { responses: { 200: { description: 'OK' } } } };
  }), []);
  assert.match(changed((d) => delete d.paths['/users/{id}'].get).join(), /GET \/users\/\{id\}: route gone/);
  assert.match(changed((d) => delete d.components.schemas.User.properties.email).join(), /\.email: gone/);
  assert.match(changed((d) => (d.components.schemas.User.properties.createdAt = { type: 'integer' })).join(), /createdAt: type string became integer/);
  assert.match(changed((d) => d.components.schemas.Group.properties.status.enum.pop()).join(), /enum value\(s\) gone: INACTIVE/);
  assert.match(changed((d) => d.paths['/groups'].post.requestBody.content['application/json'].schema.required.push('description')).join(), /description: newly required/);
  assert.match(changed((d) => (d.paths['/users'].get.parameters.find((p: any) => p.name === 'search').required = true)).join(), /query:search newly required/);
  assert.match(changed((d) => delete d.paths['/groups'].post.responses[201]).join(), /response 201 gone/);
});
