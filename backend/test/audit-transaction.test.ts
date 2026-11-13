/**
 * Changes made inside withAudit() / withPlatformAudit() and their audit
 * entries are one transaction: both are saved, or neither.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { api, db, loginSession, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';
import { verifyChain, withAudit, withPlatformAudit } from '../src/lib/audit.js';
import { dbForTenant } from '../src/lib/tenant-db.js';

let A: TenantSeed;
let request: FastifyRequest;

before(async () => {
  A = await seedTenant('audit-tx');
  await startServer();
  const admin = await A.db.user.findFirstOrThrow({ where: { tenantId: A.tenantId, email: A.adminEmail } });
  // What a handler has to hand: the tenant's own (row-level-secured) client and who is asking
  request = {
    db: await dbForTenant(A.tenantId),
    tenant: { id: A.tenantId, slug: A.slug },
    user: { userId: admin.id, tenantId: A.tenantId, userType: 'TENANT_ADMIN' },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'test' },
    id: 'audit-transaction-test',
    log: console,
  } as unknown as FastifyRequest;
});

after(async () => {
  await stopServerAndCleanUp();
});

const groupNamed = (name: string) => A.db.group.findFirst({ where: { tenantId: A.tenantId, name } });
const entriesFor = (resourceId: string) => A.db.auditEvent.findMany({ where: { tenantId: A.tenantId, resourceId }, orderBy: { seq: 'asc' } });
const entryCount = () => A.db.auditEvent.count({ where: { tenantId: A.tenantId } });

test('the change and its entry are saved together', async () => {
  const name = `Saved ${Date.now()}`;
  const group = await withAudit(request, async (tx, record) => {
    const created = await tx.group.create({ data: { tenantId: A.tenantId, name } });
    await record('group.created', { resource: { type: 'group', id: created.id, label: created.name } });
    return created;
  });
  assert.ok(await groupNamed(name));
  const [entry] = await entriesFor(group.id);
  assert.equal(entry.event, 'group.created');
  assert.equal(entry.actorEmail, A.adminEmail);
  assert.equal(entry.requestId, 'audit-transaction-test');
  // The chain, and its recorded head, include it
  const report = await verifyChain(A.tenantId);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  const { controlDb } = await db();
  assert.equal((await controlDb.auditHead.findUniqueOrThrow({ where: { chain: A.tenantId } })).seq, entry.seq);
});

test('a change that fails after its entry was written leaves neither', async () => {
  const name = `Undone ${Date.now()}`;
  const before = await entryCount();
  await assert.rejects(
    withAudit(request, async (tx, record) => {
      const created = await tx.group.create({ data: { tenantId: A.tenantId, name } });
      await record('group.created', { resource: { type: 'group', id: created.id, label: created.name } });
      throw new Error('after the entry');
    }),
    /after the entry/,
  );
  assert.equal(await groupNamed(name), null);
  assert.equal(await entryCount(), before);
  assert.equal((await verifyChain(A.tenantId)).ok, true);
});

test('an entry that cannot be recorded undoes the change', async () => {
  const before = await entryCount();
  const unknown = `Unknown ${Date.now()}`;
  await assert.rejects(
    withAudit(request, async (tx, record) => {
      await tx.group.create({ data: { tenantId: A.tenantId, name: unknown } });
      await record('nope.never');
    }),
    /Unknown audit event/,
  );
  assert.equal(await groupNamed(unknown), null);

  // An event for the platform's log can't be saved by a tenant's transaction, or the reverse
  const wrongLog = `Wrong log ${Date.now()}`;
  await assert.rejects(
    withAudit(request, async (tx, record) => {
      await tx.group.create({ data: { tenantId: A.tenantId, name: wrongLog } });
      await record('platform_role.created');
    }),
    /platform's log/,
  );
  assert.equal(await groupNamed(wrongLog), null);
  await assert.rejects(
    withPlatformAudit(request, async (_tx, record) => record('group.created')),
    /tenant's log/,
  );
  assert.equal(await entryCount(), before);
});

test('entries recorded at the same moment still form one chain', async () => {
  const stamp = Date.now();
  await Promise.all(
    [1, 2, 3, 4, 5, 6].map((n) =>
      withAudit(request, async (tx, record) => {
        const created = await tx.group.create({ data: { tenantId: A.tenantId, name: `Together ${stamp} ${n}` } });
        await record('group.created', { resource: { type: 'group', id: created.id, label: created.name } });
      }),
    ),
  );
  const report = await verifyChain(A.tenantId);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
});

test('through the API: a role and the record of it', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const created = await api('POST', '/roles', { cookie: admin.cookie, body: { name: `Auditor ${Date.now()}`, permissions: ['users:read'] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const [entry] = await entriesFor(created.json.id);
  assert.equal(entry?.event, 'role.created');
  const removed = await api('DELETE', `/roles/${created.json.id}`, { cookie: admin.cookie });
  assert.ok(removed.status < 300, JSON.stringify(removed.json));
  assert.deepEqual((await entriesFor(created.json.id)).map((e) => e.event), ['role.created', 'role.deleted']);
  assert.equal((await verifyChain(A.tenantId)).ok, true);
});
