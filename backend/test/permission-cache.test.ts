/**
 * A tenant user's permissions are kept between requests while the tenant's
 * access version stands. A database trigger moves the version on with every
 * change to who may do what, so grants and revocations still apply on the
 * next request.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, loginSession, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';

let A: TenantSeed;
let admin: { cookie: string };
let user: { cookie: string };
let userId: string;

before(async () => {
  A = await seedTenant('pcache');
  await startServer();
  admin = await loginSession(A.slug, A.adminEmail);
  user = await loginSession(A.slug, A.userEmail);
  userId = (await A.db.user.findFirstOrThrow({ where: { tenantId: A.tenantId, email: A.userEmail } })).id;
});

after(async () => {
  await stopServerAndCleanUp();
});

const version = async () => (await A.db.accessVersion.findUnique({ where: { tenantId: A.tenantId } }))?.version ?? 0;
/** How often permissions were kept from an earlier request (hit) or worked out (miss), from the server's metrics */
async function lookups(result: 'hit' | 'miss'): Promise<number> {
  const text = (await api('GET', '/internal/metrics')).json as string;
  return Number(text.match(new RegExp(`^permission_lookups_total\\{result="${result}"\\} (\\d+)$`, 'm'))?.[1] ?? 0);
}
const readAudit = (who: { cookie: string }) => api('GET', '/audit', { cookie: who.cookie });
async function auditorRole() {
  const role = await api('POST', '/roles', { cookie: admin.cookie, body: { name: `Auditor ${Date.now()} ${Math.random().toString(36).slice(2, 6)}`, permissions: ['audit:read'] } });
  assert.equal(role.status, 201, JSON.stringify(role.json));
  return role.json.id as string;
}
async function assign(roleId: string) {
  const res = await api('POST', '/roles/assign', { cookie: admin.cookie, body: { roleId, principalType: 'USER', userId } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id as string;
}

test('a grant applies on the next request, is then kept, and taking it away applies on the next request', async () => {
  assert.equal((await readAudit(user)).status, 403, 'not before');

  const assignmentId = await assign(await auditorRole());
  assert.equal((await readAudit(user)).status, 200, 'the request after the grant');

  // Nothing changes: the next requests use what was worked out
  const [hits, misses] = [await lookups('hit'), await lookups('miss')];
  assert.equal((await readAudit(user)).status, 200);
  assert.equal((await readAudit(user)).status, 200);
  assert.equal(await lookups('hit'), hits + 2);
  assert.equal(await lookups('miss'), misses);

  const removed = await api('DELETE', `/roles/assignments/${assignmentId}`, { cookie: admin.cookie });
  assert.equal(removed.status, 204, JSON.stringify(removed.json));
  assert.equal((await readAudit(user)).status, 403, 'the request after it was taken away');
  assert.equal(await lookups('miss'), misses + 1, 'worked out again');
});

test('a change made straight in the database is seen on the next request too', async () => {
  const assignmentId = await assign(await auditorRole());
  assert.equal((await readAudit(user)).status, 200);
  assert.equal((await readAudit(user)).status, 200);

  // Not through the API: the assignment ended a minute ago
  await A.db.roleAssignment.updateMany({ where: { id: assignmentId, tenantId: A.tenantId }, data: { validTo: new Date(Date.now() - 60_000) } });
  assert.equal((await readAudit(user)).status, 403);
});

test('every kind of change to who may do what moves the version on', async () => {
  const moved = async (what: string, change: () => Promise<unknown>) => {
    const from = await version();
    await change();
    assert.ok((await version()) > from, what);
  };
  const stamp = `${Date.now()}`;
  let roleId = '';
  await moved('a role', async () => {
    roleId = (await A.db.role.create({ data: { tenantId: A.tenantId, name: `Versioned ${stamp}` } })).id;
  });
  await moved('a permission added to a role', () => A.db.rolePermission.create({ data: { tenantId: A.tenantId, roleId, permission: 'audit:read' } }));
  await moved('a permission taken from a role', () => A.db.rolePermission.deleteMany({ where: { tenantId: A.tenantId, roleId } }));
  let groupId = '';
  await moved('a group', async () => {
    groupId = (await A.db.group.create({ data: { tenantId: A.tenantId, name: `Versioned ${stamp}` } })).id;
  });
  await moved('a member joining a group', () => A.db.groupMembership.create({ data: { tenantId: A.tenantId, groupId, userId, validFrom: new Date() } }));
  await moved('a group turned off', () => A.db.group.update({ where: { id: groupId }, data: { status: 'INACTIVE' } }));
  let assignmentId = '';
  await moved('a role given to a group', async () => {
    assignmentId = (
      await A.db.roleAssignment.create({
        data: { tenantId: A.tenantId, roleId, principalType: 'GROUP', groupId, scopeType: 'TENANT', scopeId: A.tenantId, validFrom: new Date() },
      })
    ).id;
  });
  await moved('an assignment removed', () => A.db.roleAssignment.delete({ where: { id: assignmentId } }));
  await moved('a member leaving a group', () => A.db.groupMembership.deleteMany({ where: { tenantId: A.tenantId, groupId } }));

  // Something else entirely doesn't
  const from = await version();
  await A.db.user.updateMany({ where: { id: userId, tenantId: A.tenantId }, data: { name: `Renamed ${stamp}` } });
  assert.equal(await version(), from);
});

test("an administrator's permissions are worked out every time", async () => {
  const [hits, misses] = [await lookups('hit'), await lookups('miss')];
  assert.equal((await readAudit(admin)).status, 200);
  assert.equal((await readAudit(admin)).status, 200);
  assert.deepEqual([await lookups('hit'), await lookups('miss')], [hits, misses]);
});
