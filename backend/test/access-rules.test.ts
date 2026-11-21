/**
 * Access rules (lib/access-rules.ts): conditions on top of roles, the
 * platform's first, then the organization's. Platform rules apply
 * everywhere and test files share one database, so the platform rule here
 * is aimed at one person in this file's organization.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';
import { decide, holds, type Rule, type Subject } from '../src/lib/access-rules.js';

let A: TenantSeed;
let admin: string;
let staff: string;
let managerId: string;

before(async () => {
  await startServer();
  A = await seedTenant('rules');
  admin = (await loginSession(A.slug, A.adminEmail)).cookie;
  staff = (await loginSession('platform', (await seedPlatformUsers()).adminEmail)).cookie;
  managerId = (await A.db.user.findFirst({ where: { tenantId: A.tenantId, email: A.managerEmail } }))!.id;
});
after(stopServerAndCleanUp);

const subject = (over: Partial<Subject> = {}): Subject => ({
  permissions: ['users:delete'], user: { id: 'u1', type: 'TENANT_MANAGER' }, email: async () => 'ada@example.com', apiKey: false,
  ip: '10.1.2.3', method: 'DELETE', path: '/users/x', resourceId: 'x', now: new Date('2026-11-23T20:30:00Z'),
  groups: async () => ['g1'], roles: async () => ['Managers'], units: async () => [], ...over,
});
const rule = (r: Partial<Rule> & Pick<Rule, 'effect' | 'body'>): Rule => ({ id: r.name ?? 'r', name: 'r', priority: 0, level: 'organization', ...r });

test('conditions: lists, ranges across midnight, addresses, case-insensitive text', () => {
  assert.ok(holds('between', 23, [22, 6]) && holds('between', 3, [22, 6]) && !holds('between', 12, [22, 6]));
  assert.ok(holds('inCidr', '::ffff:10.1.2.3', ['10.0.0.0/8']) && holds('notInCidr', '192.0.2.1', '10.0.0.0/8'));
  assert.ok(holds('contains', ['Managers'], 'managers') && holds('in', 'MON', ['mon', 'tue']));
  assert.ok(holds('exists', 'x', undefined) && holds('notExists', [], undefined));
});

test('the first matching rule decides; ALLOW is an exception to DENY rules below it; the platform comes first', async () => {
  const denyOffHours = rule({ name: 'off-hours', effect: 'DENY', priority: 10, body: { actions: ['users:*'], when: [{ attribute: 'context.hour', op: 'between', value: [19, 7] }], timezone: 'Asia/Kolkata' } });
  const allowOffice = rule({ name: 'office', effect: 'ALLOW', priority: 20, body: { actions: ['*'], when: [{ attribute: 'context.ip', op: 'inCidr', value: ['10.0.0.0/8'] }] } });
  // 20:30 UTC is 02:00 in Kolkata: off hours
  assert.equal((await decide([], [denyOffHours], subject())).allowed, false);
  // ...but from the office network, the higher-priority exception lets it through
  assert.equal((await decide([], [allowOffice, denyOffHours], subject())).allowed, true);
  // An organization can't make an exception to the platform's refusal
  const platformDeny = { ...denyOffHours, level: 'platform' as const };
  const d = await decide([platformDeny], [allowOffice], subject());
  assert.equal(d.allowed, false);
  assert.equal(d.deniedBy?.level, 'platform');
  // Subjects: only the roles named
  const forAuditors = rule({ effect: 'DENY', body: { actions: ['users:delete'], subjects: { roles: ['Auditors'] } } });
  assert.equal((await decide([], [forAuditors], subject())).allowed, true);
  // A rule saved in the old form never applies
  assert.equal((await decide([], [rule({ effect: 'DENY', body: null })], subject())).allowed, true);
});

test("an organization's rule refuses what roles allow, with an exception, and the refusal is recorded", async () => {
  const manager = (await loginSession(A.slug, A.managerEmail)).cookie;
  assert.equal((await api('GET', '/users', { cookie: manager })).status, 200, 'roles allow it');

  const deny = await api('POST', '/policies', { cookie: admin, body: {
    name: 'No people list for managers', effect: 'DENY', priority: 10,
    conditions: { actions: ['users:read'], subjects: { userTypes: ['TENANT_MANAGER'] } },
  } });
  assert.equal(deny.status, 201, JSON.stringify(deny.json));
  const refused = await api('GET', '/users', { cookie: manager });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, 'ACCESS_RULE_DENIED');
  assert.equal(refused.json.rule.name, 'No people list for managers');
  assert.equal((await api('GET', '/users', { cookie: admin })).status, 200, 'not about admins');

  const entry = await A.db.auditEvent.findFirst({ where: { tenantId: A.tenantId, event: 'access.denied_by_rule' } });
  assert.ok(entry, 'recorded in the organization\'s audit log');

  // An exception above it: from loopback, allowed
  const allow = await api('POST', '/policies', { cookie: admin, body: {
    name: 'Except from here', effect: 'ALLOW', priority: 20,
    conditions: { actions: ['users:read'], when: [{ attribute: 'context.ip', op: 'inCidr', value: ['127.0.0.0/8', '::1'] }] },
  } });
  assert.equal(allow.status, 201);
  assert.equal((await api('GET', '/users', { cookie: manager })).status, 200);

  // Trying it shows each rule's part
  const tried = await api('POST', '/policies/evaluate', { cookie: admin, body: { userId: managerId, action: 'users:read', context: { ip: '192.0.2.1' } } });
  assert.equal(tried.status, 200);
  assert.equal(tried.json.decision, 'DENY');
  assert.deepEqual(tried.json.evaluations.map((e: { name: string; matched: boolean }) => [e.name, e.matched]), [['Except from here', false], ['No people list for managers', true]]);

  // Rules that aren't rules are refused
  const bad = await api('POST', '/policies', { cookie: admin, body: { name: 'Bad', effect: 'DENY', conditions: { actions: [], when: [{ attribute: 'context.hour', op: 'between', value: 'nine' }] } } });
  assert.equal(bad.status, 400);

  for (const p of [deny.json, allow.json]) assert.equal((await api('DELETE', `/policies/${p.id}`, { cookie: admin })).status, 204);
  assert.equal((await api('GET', '/users', { cookie: manager })).status, 200, 'gone: allowed again');
});

test("the platform's rules apply in every organization, before its own", async () => {
  const manager = (await loginSession(A.slug, A.managerEmail)).cookie;
  const created = await api('POST', '/platform/access-rules', { cookie: staff, body: {
    name: 'Test: this manager may not list people', effect: 'DENY', priority: 5,
    conditions: { actions: ['users:read'], subjects: { users: [managerId] } },
  } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  try {
    // The organization's exception doesn't override the platform
    const allow = await api('POST', '/policies', { cookie: admin, body: { name: 'Allow all', effect: 'ALLOW', priority: 100, conditions: { actions: ['*'] } } });
    const refused = await api('GET', '/users', { cookie: manager });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.rule.level, 'platform');
    await api('DELETE', `/policies/${allow.json.id}`, { cookie: admin });

    const tried = await api('POST', '/platform/access-rules/evaluate', { cookie: staff, body: { tenantId: A.tenantId, email: A.managerEmail, action: 'users:read' } });
    assert.equal(tried.json.decision, 'DENY');
    // Organizations can't change the platform's rules
    assert.equal((await api('POST', '/platform/access-rules', { cookie: admin, body: created.json })).status, 403);
  } finally {
    assert.equal((await api('DELETE', `/platform/access-rules/${created.json.id}`, { cookie: staff })).status, 204);
  }
  assert.equal((await api('GET', '/users', { cookie: manager })).status, 200);
});
