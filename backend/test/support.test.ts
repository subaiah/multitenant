/**
 * Isolation gaps closed: platform staff reach tenant data only through an
 * approved, time-limited support session (read-only unless approved
 * otherwise, enforced in Postgres too); platform roles instead of
 * all-or-nothing user types; one usage refresh at a time.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  api, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type PlatformSeed, type TenantSeed,
} from './helpers.js';

let A: TenantSeed;
let B: TenantSeed;
let P: PlatformSeed;
let controlDb: Awaited<ReturnType<typeof db>>['controlDb'];

before(async () => {
  ({ controlDb } = await db());
  A = await seedTenant('support-a');
  B = await seedTenant('support-b');
  P = await seedPlatformUsers();
  await startServer();
});
after(stopServerAndCleanUp);

const platform = (email: string) => loginSession('platform', email);
const request = (cookie: string, body: Record<string, unknown>) =>
  api('POST', '/support-sessions/request', { cookie, body: { tenantId: A.tenantId, reason: 'Customer reported a sign-in problem', durationMinutes: 30, ...body } });

async function endAll() {
  await controlDb.supportSession.updateMany({ where: { tenantId: { in: [A.tenantId, B.tenantId] }, status: { in: ['ACTIVE', 'PENDING'] } }, data: { status: 'REVOKED' } });
}

// ------------------------------------------------------------ support sessions

test('no session, no tenant data: request, approval by someone else, then read-only access', async () => {
  await endAll();
  const support = await platform(P.supportEmail);
  const admin = await platform(P.adminEmail);
  assert.equal((await api('GET', '/users', { cookie: support.cookie, tenant: A.tenantId })).json.code, 'SUPPORT_SESSION_REQUIRED');
  assert.equal((await api('GET', '/users', { cookie: admin.cookie, tenant: A.tenantId })).json.code, 'SUPPORT_SESSION_REQUIRED', 'platform admins too');

  const req = await request(support.cookie, {});
  assert.equal(req.status, 201, JSON.stringify(req.json));
  assert.deepEqual([req.json.status, req.json.access], ['PENDING', 'READ_ONLY']);
  assert.equal((await request(support.cookie, {})).status, 409, 'one open request per tenant');
  assert.equal((await api('GET', '/users', { cookie: support.cookie, tenant: A.tenantId })).status, 403, 'pending is not access');

  const approved = await api('POST', `/support-sessions/${req.json.id}/decide`, { cookie: admin.cookie, body: { approved: true, note: 'ok' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.status, 'ACTIVE');
  assert.ok(new Date(approved.json.validTo).getTime() - Date.now() <= 30 * 60_000 + 5000);
  assert.equal((await api('POST', `/support-sessions/${req.json.id}/decide`, { cookie: admin.cookie, body: { approved: true } })).status, 409);

  // Reading works; writing doesn't
  const users = await api('GET', '/users', { cookie: support.cookie, tenant: A.tenantId });
  assert.equal(users.status, 200);
  assert.ok(users.json.data.every((u: { email: string }) => u.email.includes('support-a')));
  assert.equal((await api('POST', '/groups', { cookie: support.cookie, tenant: A.tenantId, body: { name: 'Nope' } })).status, 403);
  // Only the tenant the session is for
  assert.equal((await api('GET', '/users', { cookie: support.cookie, tenant: B.tenantId })).json.code, 'SUPPORT_SESSION_REQUIRED');

  // The tenant sees it: audit entry (as the support person) and admins notified
  const tenantAdmin = await loginSession(A.slug, A.adminEmail);
  const started = (await api('GET', '/audit?event=support.session_started', { cookie: tenantAdmin.cookie })).json.data[0];
  assert.deepEqual([started.actorType, started.actorEmail, started.details.access, started.details.approvedBy], ['PLATFORM', P.supportEmail, 'READ_ONLY', P.adminEmail]);
  const seen = await api('GET', '/audit?event=support.session_started', { cookie: tenantAdmin.cookie });
  assert.equal(seen.status, 200);
  const access = (await api('GET', '/support-access', { cookie: tenantAdmin.cookie })).json;
  assert.equal(access[0].staffEmail, P.supportEmail);
  assert.equal(access[0].status, 'ACTIVE');
});

test("a platform admin's everything doesn't cover tenant data in a read-only session", async () => {
  await endAll();
  const admin = await platform(P.adminEmail);
  const { grantSupportSession } = await import('./helpers.js');
  await grantSupportSession(P.adminEmail, A.tenantId, 'READ_ONLY');
  assert.equal((await api('GET', '/groups', { cookie: admin.cookie, tenant: A.tenantId })).status, 200);
  assert.equal((await api('POST', '/groups', { cookie: admin.cookie, tenant: A.tenantId, body: { name: 'Admin tries' } })).status, 403);
  assert.equal((await api('DELETE', `/users/${(await A.db.user.findFirstOrThrow({ where: { tenantId: A.tenantId, email: A.userEmail } })).id}`, { cookie: admin.cookie, tenant: A.tenantId })).status, 403);
  // Platform-level permissions still apply to platform routes
  assert.equal((await api('GET', '/tenants', { cookie: admin.cookie })).status, 200);
});

test('Postgres itself refuses writes on a read-only session’s connection', async () => {
  const { dbForTenant } = await import('../src/lib/tenant-db.js');
  const ro = await dbForTenant(A.tenantId, undefined, { readOnly: true });
  assert.ok(await ro.user.count({ where: { tenantId: A.tenantId } }));
  await assert.rejects(ro.group.create({ data: { tenantId: A.tenantId, name: `ro-${Date.now()}` } }), /read-only/);
  const { classifyDatabaseError } = await import('../src/lib/db-errors.js');
  const err = await ro.group.create({ data: { tenantId: A.tenantId, name: `ro2-${Date.now()}` } }).catch((e) => e);
  assert.equal(classifyDatabaseError(err), 'read-only');
});

test('read-write sessions get only the permissions approved', async () => {
  await endAll();
  const support = await platform(P.supportEmail);
  const admin = await platform(P.adminEmail);
  assert.equal((await request(support.cookie, { access: 'READ_WRITE' })).status, 400, 'must say which permissions');
  assert.equal((await request(support.cookie, { access: 'READ_WRITE', permissions: ['tenants:manage'] })).status, 400, 'tenant permissions only');
  assert.equal((await request(support.cookie, { durationMinutes: 60 * 24 })).status, 400, 'too long');

  const req = await request(support.cookie, { access: 'READ_WRITE', permissions: ['groups:create'] });
  await api('POST', `/support-sessions/${req.json.id}/decide`, { cookie: admin.cookie, body: { approved: true } });
  const made = await api('POST', '/groups', { cookie: support.cookie, tenant: A.tenantId, body: { name: `Fixed by support ${Date.now()}` } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal((await api('DELETE', `/groups/${made.json.id}`, { cookie: support.cookie, tenant: A.tenantId })).status, 403, 'not approved');
});

test('nobody approves their own request; rejected requests give nothing', async () => {
  await endAll();
  const admin = await platform(P.adminEmail);
  const own = await request(admin.cookie, {});
  assert.equal(own.json.status, 'PENDING');
  assert.equal((await api('POST', `/support-sessions/${own.json.id}/decide`, { cookie: admin.cookie, body: { approved: true } })).status, 403);
  await api('POST', `/support-sessions/${own.json.id}/revoke`, { cookie: admin.cookie });

  const support = await platform(P.supportEmail);
  const req = await request(support.cookie, {});
  const rejected = await api('POST', `/support-sessions/${req.json.id}/decide`, { cookie: admin.cookie, body: { approved: false, note: 'Use the customer’s screen share' } });
  assert.equal(rejected.json.status, 'REJECTED');
  assert.equal((await api('GET', '/users', { cookie: support.cookie, tenant: A.tenantId })).status, 403);
  // The requester is told
  const box = (await api('GET', '/notifications', { cookie: support.cookie })).json.data as { type: string }[];
  const deadline = Date.now() + 5000;
  let told = box.some((n) => n.type === 'support_session.rejected');
  while (!told && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    told = ((await api('GET', '/notifications', { cookie: support.cookie })).json.data as { type: string }[]).some((n) => n.type === 'support_session.rejected');
  }
  assert.ok(told);
});

test('sessions end: at their time, by the requester, or by the tenant', async () => {
  await endAll();
  const support = await platform(P.supportEmail);
  const admin = await platform(P.adminEmail);
  const approve = async () => {
    const req = await request(support.cookie, {});
    await api('POST', `/support-sessions/${req.json.id}/decide`, { cookie: admin.cookie, body: { approved: true } });
    return req.json.id as string;
  };

  // Time's up
  const first = await approve();
  await controlDb.supportSession.update({ where: { id: first }, data: { validTo: new Date(Date.now() - 1000) } });
  assert.equal((await api('GET', '/users', { cookie: support.cookie, tenant: A.tenantId })).status, 403);
  const listed = (await api('GET', '/support-sessions', { cookie: admin.cookie })).json.sessions.find((s: { id: string }) => s.id === first);
  assert.equal(listed.status, 'EXPIRED');

  // The requester ends it
  const second = await approve();
  assert.equal((await api('GET', '/users', { cookie: support.cookie, tenant: A.tenantId })).status, 200);
  await api('POST', `/support-sessions/${second}/revoke`, { cookie: support.cookie });
  assert.equal((await api('GET', '/users', { cookie: support.cookie, tenant: A.tenantId })).status, 403);

  // The tenant ends it (another tenant can't)
  const third = await approve();
  const otherAdmin = await loginSession(B.slug, B.adminEmail);
  assert.equal((await api('POST', `/support-access/${third}/end`, { cookie: otherAdmin.cookie })).status, 404);
  const tenantUser = await loginSession(A.slug, A.userEmail);
  assert.equal((await api('POST', `/support-access/${third}/end`, { cookie: tenantUser.cookie })).status, 403);
  const tenantAdmin = await loginSession(A.slug, A.adminEmail);
  assert.equal((await api('POST', `/support-access/${third}/end`, { cookie: tenantAdmin.cookie })).status, 200);
  assert.equal((await api('GET', '/users', { cookie: support.cookie, tenant: A.tenantId })).status, 403);
  const endedEntry = (await api('GET', '/audit?event=support.session_ended', { cookie: tenantAdmin.cookie })).json.data[0];
  assert.deepEqual([endedEntry.actorEmail, endedEntry.details.endedBy], [A.adminEmail, 'tenant']);
});

// ------------------------------------------------------------ platform roles

test('platform roles add platform permissions, and nobody grants what they lack', async () => {
  const admin = await platform(P.adminEmail);
  const support = await platform(P.supportEmail);
  const roles = (await api('GET', '/platform-roles', { cookie: admin.cookie })).json;
  const byName = (n: string) => roles.roles.find((r: { name: string }) => r.name === n);
  assert.ok(byName('Support Manager')?.isSystem);
  assert.ok(roles.permissions.every((p: { name: string }) => !/^(users|groups|roles):/.test(p.name)), 'no tenant permissions offered');

  const supportId = (await controlDb.platformUser.findUniqueOrThrow({ where: { email: P.supportEmail } })).id;
  assert.equal((await api('GET', '/support-sessions', { cookie: support.cookie })).json.canApprove, false);
  // Support can't give themselves roles
  assert.equal((await api('PUT', `/platform-roles/users/${supportId}`, { cookie: support.cookie, body: { roleIds: [byName('Support Manager').id] } })).status, 403);

  const set = await api('PUT', `/platform-roles/users/${supportId}`, { cookie: admin.cookie, body: { roleIds: [byName('Support Manager').id, byName('Platform User Manager').id] } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  const again = await platform(P.supportEmail);
  assert.equal((await api('GET', '/support-sessions', { cookie: again.cookie })).json.canApprove, true);
  const users = (await api('GET', '/platform/users', { cookie: admin.cookie })).json.users;
  assert.deepEqual(users.find((u: { id: string }) => u.id === supportId).roles.map((r: { name: string }) => r.name).sort(), ['Platform User Manager', 'Support Manager']);

  // Now a user manager, but still can't hand out Tenant Operations (lacks tenants:manage)
  const escalate = await api('PUT', `/platform-roles/users/${supportId}`, {
    cookie: again.cookie,
    body: { roleIds: [byName('Support Manager').id, byName('Platform User Manager').id, byName('Tenant Operations').id] },
  });
  assert.equal(escalate.status, 403);
  assert.match(escalate.json.message, /tenants:manage/);

  // Custom roles: platform permissions only; built-ins are fixed
  assert.equal((await api('POST', '/platform-roles', { cookie: admin.cookie, body: { name: `Bad ${Date.now()}`, permissions: ['users:read'] } })).status, 400);
  assert.equal((await api('PATCH', `/platform-roles/${byName('Auditor').id}`, { cookie: admin.cookie, body: { description: 'x' } })).status, 403);
  const custom = await api('POST', '/platform-roles', { cookie: admin.cookie, body: { name: `Readers ${Date.now()}`, permissions: ['platform-audit:read'] } });
  assert.equal(custom.status, 201);
  assert.equal((await api('DELETE', `/platform-roles/${custom.json.id}`, { cookie: admin.cookie })).status, 204);

  // Audited, and the person is told
  const entry = (await api('GET', '/platform-audit?event=platform_role.assigned', { cookie: admin.cookie })).json.data[0];
  assert.equal(entry.details.user, P.supportEmail);
  await api('PUT', `/platform-roles/users/${supportId}`, { cookie: admin.cookie, body: { roleIds: [] } });
  const after = await platform(P.supportEmail);
  assert.equal((await api('GET', '/support-sessions', { cookie: after.cookie })).json.canApprove, false);
});

// ------------------------------------------------------------ usage refresh

test('the usage refresh runs on one server at a time and skips tenants being deleted', async () => {
  const { refreshTenantUsage, refreshTenantUsageOnce } = await import('../src/lib/tenant-usage.js');
  const { config } = await import('../src/config/env.js');
  const holder = new pg.Client({ connectionString: config.databaseUrl });
  await holder.connect();
  try {
    await holder.query("SELECT pg_advisory_lock(hashtext('tenant-usage-refresh'))");
    assert.equal((await refreshTenantUsageOnce()).skipped, 'busy');
  } finally {
    await holder.query("SELECT pg_advisory_unlock(hashtext('tenant-usage-refresh'))");
    await holder.end();
  }
  const ran = await refreshTenantUsageOnce();
  assert.equal(ran.skipped, undefined);
  assert.ok(await controlDb.tenantUsage.findUnique({ where: { tenantId: A.tenantId } }));

  await controlDb.tenantUsage.deleteMany({ where: { tenantId: B.tenantId } });
  await controlDb.tenant.update({ where: { id: B.tenantId }, data: { provisioningStatus: 'DEPROVISIONING' } });
  try {
    await refreshTenantUsage([B.tenantId]);
    assert.equal(await controlDb.tenantUsage.findUnique({ where: { tenantId: B.tenantId } }), null);
  } finally {
    await controlDb.tenant.update({ where: { id: B.tenantId }, data: { provisioningStatus: 'READY' } });
  }
});
