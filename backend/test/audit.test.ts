/**
 * Audit log: what gets recorded, who can see it, and that tampering of any
 * kind (edits, removed entries, cut-off ends, altered archives) is detected.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  PASSWORD, api, baseUrl, db, grantSupportSession, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp,
  type PlatformSeed, type TenantSeed,
} from './helpers.js';
import { archiveChain, auditCatalog, recordAudit, verifyChain } from '../src/lib/audit.js';
import { targetForTenant, dbForTenant } from '../src/lib/tenant-db.js';
import { ownerUrl, schemaOf } from '../src/lib/tenant-targets.js';
import { withConnection } from '../src/lib/tenant-migrations.js';
import { config } from '../src/config/env.js';

let A: TenantSeed;
let B: TenantSeed;
let P: PlatformSeed;
let controlDb: Awaited<ReturnType<typeof db>>['controlDb'];

before(async () => {
  ({ controlDb } = await db());
  A = await seedTenant('audit-a');
  B = await seedTenant('audit-b');
  P = await seedPlatformUsers();
  await startServer();
});
after(stopServerAndCleanUp);

/** Run SQL as the owner of A's tables (can switch triggers off, as an attacker with that access could). */
async function asOwner(sql: string, params: unknown[] = []) {
  const target = await targetForTenant(A.tenantId);
  const s = `"${schemaOf(target)}"`;
  return withConnection(ownerUrl(target), (c) => c.query(sql.replaceAll('$schema', s), params));
}

const entries = async (cookie: string, query = '') => (await api('GET', `/audit${query}`, { cookie })).json;

// ------------------------------------------------------------ static

test('every audit event used in the code is in the catalog', () => {
  const catalog = auditCatalog();
  const used = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'generated') walk(path);
      } else if (path.endsWith('.ts')) {
        const src = readFileSync(path, 'utf8');
        for (const m of src.matchAll(/(?:audit\(request,\s*|recordAudit\([^)]*?\},\s*)'([a-z_.]+)'/g)) used.add(m[1]);
        for (const m of src.matchAll(/\?\s*'([a-z_]+\.[a-z_.]+)'\s*:\s*'([a-z_]+\.[a-z_.]+)'/g)) used.add(m[1]).add(m[2]);
      }
    }
  };
  walk(resolve(import.meta.dirname, '..', 'src'));
  assert.ok(used.size > 40, `found ${used.size} event keys in the code`);
  const unknown = [...used].filter((k) => !(k in catalog) && !k.startsWith('platform-') && k.includes('.'));
  assert.deepEqual(unknown, []);
});

test('an unknown event is refused', async () => {
  await assert.rejects(recordAudit({ actor: { type: 'SYSTEM' }, tenantId: A.tenantId }, 'nope.never'), /Unknown audit event/);
});

// ------------------------------------------------------------ recording

test('changes are recorded with who, what, before and after', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const group = await api('POST', '/groups', { cookie: admin.cookie, body: { name: `Auditors ${Date.now()}`, description: 'first' } });
  assert.equal(group.status, 201);
  await api('PATCH', `/groups/${group.json.id}`, { cookie: admin.cookie, body: { description: 'second' } });
  await api('PATCH', '/auth-config', { cookie: admin.cookie, body: { sessionTimeout: 45 } });

  const list = await entries(admin.cookie, `?resourceId=${group.json.id}`);
  assert.deepEqual(list.data.map((e: { event: string }) => e.event), ['group.updated', 'group.created']);
  const updated = list.data[0];
  assert.equal(updated.actorType, 'USER');
  assert.equal(updated.actorEmail, A.adminEmail);
  assert.deepEqual(updated.changes, { description: ['first', 'second'] });
  assert.ok(updated.ip && updated.requestId && updated.hash.length === 64);

  const auth = (await entries(admin.cookie, '?event=auth_config.updated')).data[0];
  assert.deepEqual(auth.changes.sessionTimeout, [60, 45]);
  await api('PATCH', '/auth-config', { cookie: admin.cookie, body: { sessionTimeout: 60 } });
});

test('sign-ins are recorded, including refused ones', async () => {
  const bad = await api('POST', '/bff/auth/login', { body: { email: A.userEmail, tenantSlug: A.slug, password: 'nope' } });
  assert.equal(bad.status, 401);
  await api('POST', '/bff/auth/login', { body: { email: 'ghost@nowhere.test', tenantSlug: A.slug, password: 'x' } });
  await loginSession(A.slug, A.userEmail);

  const admin = await loginSession(A.slug, A.adminEmail);
  const failed = (await entries(admin.cookie, '?event=auth.sign_in_failed')).data;
  const wrong = failed.find((e: { actorEmail: string }) => e.actorEmail === A.userEmail);
  assert.ok(wrong, 'wrong password recorded');
  assert.deepEqual([wrong.outcome, wrong.actorType, wrong.details.reason], ['FAILURE', 'USER', 'wrong password']);
  const ghost = failed.find((e: { actorEmail: string }) => e.actorEmail === 'ghost@nowhere.test');
  assert.deepEqual([ghost.actorType, ghost.details.reason], ['ANONYMOUS', 'no such account']);
  const ok = (await entries(admin.cookie, `?event=auth.signed_in&q=${encodeURIComponent(A.userEmail)}`)).data[0];
  assert.deepEqual([ok.outcome, ok.details.method], ['SUCCESS', 'password']);
  assert.ok(!JSON.stringify(failed).includes('nope'), 'no passwords in the log');
});

test('secrets never reach the audit log', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const res = await api('PATCH', `/auth-config/providers/${A.providerId}`, { cookie: admin.cookie, body: { clientSecret: 'NEW-TOP-SECRET', enabled: true } });
  assert.equal(res.status, 200);
  const e = (await entries(admin.cookie, '?event=auth_provider.updated')).data[0];
  assert.deepEqual(e.changes.clientSecret, ['[redacted]', '[changed]']);
  assert.deepEqual(e.changes.enabled, [false, true]);
  assert.ok(!JSON.stringify(e).includes('NEW-TOP-SECRET'));
});

test('only people with audit:read see the log, and only their own tenant’s', async () => {
  const user = await loginSession(A.slug, A.userEmail);
  assert.equal((await api('GET', '/audit', { cookie: user.cookie })).status, 403);
  const b = await loginSession(B.slug, B.adminEmail);
  const list = await entries(b.cookie);
  assert.ok(list.data.length > 0);
  assert.ok(list.data.every((e: { tenantId: string }) => e.tenantId === B.tenantId));
  assert.equal((await api('GET', '/platform-audit', { cookie: b.cookie })).status, 403);
});

test('paging walks back through the log', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const first = await entries(admin.cookie, '?limit=2');
  assert.equal(first.data.length, 2);
  assert.ok(first.nextBefore);
  const second = await entries(admin.cookie, `?limit=2&before=${first.nextBefore}`);
  assert.ok(second.data[0].seq < first.data[1].seq + 1);
  assert.ok(second.data[0].seq === first.data[1].seq - 1);
});

test('export gives CSV and is itself recorded', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const res = await fetch(`${baseUrl()}/audit/export?category=access`, { headers: { cookie: admin.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
  const csv = await res.text();
  const lines = csv.trim().split('\n');
  assert.ok(lines[0].startsWith('seq,occurredAt,event'));
  assert.ok(lines.length > 2);
  assert.ok(lines.slice(1).every((l) => l.includes('"access"')));
  const exp = (await entries(admin.cookie, '?event=audit.exported')).data[0];
  assert.deepEqual(exp.details.filter, { category: 'access' });
  const user = await loginSession(A.slug, A.userEmail);
  assert.equal((await api('GET', '/audit/export', { cookie: user.cookie })).status, 403);
});

// ------------------------------------------------------------ append-only and tamper-evident

test('the tenant’s own role can add entries but never change or remove them', async () => {
  const own = await dbForTenant(A.tenantId);
  await assert.rejects(own.auditEvent.updateMany({ where: { tenantId: A.tenantId }, data: { event: 'x' } }));
  await assert.rejects(own.auditEvent.deleteMany({ where: { tenantId: A.tenantId } }));
  // Nor can the platform role, which sees every row (trigger)
  await assert.rejects(A.db.auditEvent.updateMany({ where: { tenantId: A.tenantId }, data: { event: 'x' } }), /cannot be changed/);
});

test('the chain verifies, and detects edits, removed entries and a cut-off end', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const clean = (await api('GET', '/audit/verify', { cookie: admin.cookie })).json;
  assert.equal(clean.ok, true, JSON.stringify(clean.problems));
  assert.ok(clean.entries >= 5);

  const rows = await A.db.auditEvent.findMany({ where: { tenantId: A.tenantId }, orderBy: { seq: 'asc' } });
  const middle = rows[Math.floor(rows.length / 2)];

  // Edited (with the trigger switched off, as the table owner could)
  const edit = async (label: string | null) => {
    await asOwner('ALTER TABLE $schema.audit_events DISABLE TRIGGER audit_events_no_update');
    try {
      await A.db.auditEvent.update({ where: { id: middle.id }, data: { resourceLabel: label } });
    } finally {
      await asOwner('ALTER TABLE $schema.audit_events ENABLE TRIGGER audit_events_no_update');
    }
  };
  await edit('forged');
  const edited = await verifyChain(A.tenantId);
  assert.equal(edited.ok, false);
  assert.deepEqual(edited.problems.map((p) => p.seq), [middle.seq]);
  assert.match(edited.problems[0].problem, /changed/);
  await edit(middle.resourceLabel);
  assert.equal((await verifyChain(A.tenantId)).ok, true);

  // Removed from the middle
  await A.db.auditEvent.delete({ where: { id: middle.id } });
  const gap = await verifyChain(A.tenantId);
  assert.equal(gap.ok, false);
  assert.ok(gap.problems.some((p) => /missing/.test(p.problem)));
  await A.db.auditEvent.create({ data: { ...middle, changes: middle.changes ?? undefined, details: middle.details ?? undefined } });
  assert.equal((await verifyChain(A.tenantId)).ok, true);

  // Cut off the end: the chain alone looks fine, the head in the control plane doesn't
  const last = await A.db.auditEvent.findFirstOrThrow({ where: { tenantId: A.tenantId }, orderBy: { seq: 'desc' } });
  await A.db.auditEvent.delete({ where: { id: last.id } });
  const cut = await verifyChain(A.tenantId);
  assert.equal(cut.ok, false);
  assert.match(cut.problems[0].problem, /missing from the end/);
  await A.db.auditEvent.create({ data: { ...last, changes: last.changes ?? undefined, details: last.details ?? undefined } });
  assert.equal((await verifyChain(A.tenantId)).ok, true);
});

test('entries recorded at the same moment still form one chain', async () => {
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      recordAudit({ actor: { type: 'SYSTEM' }, tenantId: B.tenantId }, 'roles.initialized', { details: { i } }),
    ),
  );
  const report = await verifyChain(B.tenantId);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
});

// ------------------------------------------------------------ archiving

test('old entries move to an archive file and the chain still verifies across it', async () => {
  const before = await B.db.auditEvent.count({ where: { tenantId: B.tenantId } });
  const result = await archiveChain(B.tenantId, { before: new Date(Date.now() + 1000) });
  assert.equal(result.archived, before - 1, 'all but the newest');
  assert.equal(await B.db.auditEvent.count({ where: { tenantId: B.tenantId } }), 1);

  const manifest = await controlDb.auditArchive.findFirstOrThrow({ where: { chain: B.tenantId } });
  const path = resolve(config.auditArchiveDir, manifest.file);
  const lines = gunzipSync(readFileSync(path)).toString().trim().split('\n');
  assert.equal(lines.length, manifest.rows);

  // New entries continue the chain
  const admin = await loginSession(B.slug, B.adminEmail);
  const report = (await api('GET', '/audit/verify', { cookie: admin.cookie })).json;
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(report.archivedEntries, manifest.rows);

  // Admins can list and download their archives (not another tenant's)
  const archives = (await api('GET', '/audit/archives', { cookie: admin.cookie })).json;
  assert.equal(archives[0].id, manifest.id);
  const file = await fetch(`${baseUrl()}/audit/archives/${manifest.id}/download`, { headers: { cookie: admin.cookie } });
  assert.equal(file.status, 200);
  assert.equal(Buffer.from(await file.arrayBuffer()).length, manifest.bytes);
  const other = await loginSession(A.slug, A.adminEmail);
  assert.equal((await api('GET', `/audit/archives/${manifest.id}/download`, { cookie: other.cookie })).status, 404);

  // An altered archive file is detected
  const original = readFileSync(path);
  writeFileSync(path, Buffer.concat([original, Buffer.from([0])]));
  try {
    const tampered = await verifyChain(B.tenantId);
    assert.equal(tampered.ok, false);
    assert.match(tampered.problems[0].problem, /was changed/);
  } finally {
    writeFileSync(path, original);
  }
  assert.equal((await verifyChain(B.tenantId)).ok, true);
});

test('deleting a tenant archives its whole audit log first', async () => {
  const C = await seedTenant('audit-c');
  await recordAudit({ actor: { type: 'SYSTEM' }, tenantId: C.tenantId }, 'roles.initialized');
  await recordAudit({ actor: { type: 'SYSTEM' }, tenantId: C.tenantId }, 'roles.initialized');
  const { deprovisionTenant } = await import('../src/lib/provisioning.js');
  await deprovisionTenant(C.tenantId);
  const archives = await controlDb.auditArchive.findMany({ where: { chain: C.tenantId } });
  assert.equal(archives.reduce((n, a) => n + a.rows, 0), 2);
  assert.ok(archives.every((a) => readFileSync(resolve(config.auditArchiveDir, a.file)).length === a.bytes));
});

// ------------------------------------------------------------ platform

test('the platform has its own log, for platform staff only', async () => {
  const admin = await loginSession('platform', P.adminEmail);
  const provisioned = (await api('GET', `/platform-audit?event=tenant.provisioned&tenantId=${A.tenantId}`, { cookie: admin.cookie })).json;
  assert.equal(provisioned.data.length, 1);
  assert.equal(provisioned.data[0].actorType, 'SYSTEM');
  const signedIn = (await api('GET', `/platform-audit?event=platform.auth.signed_in&q=${encodeURIComponent(P.adminEmail)}`, { cookie: admin.cookie })).json;
  assert.equal(signedIn.data[0].actorEmail, P.adminEmail);

  const verify = (await api('GET', `/platform-audit/verify?chain=${A.tenantId}`, { cookie: admin.cookie })).json;
  assert.equal(verify.ok, true, JSON.stringify(verify.problems));
  assert.equal((await api('GET', '/platform-audit/verify', { cookie: admin.cookie })).json.chain, 'platform');

  const support = await loginSession('platform', P.supportEmail);
  assert.equal((await api('GET', '/platform-audit/verify', { cookie: support.cookie })).status, 403);
  const events = (await api('GET', '/platform-audit/events', { cookie: admin.cookie })).json;
  assert.ok(events.some((e: { key: string }) => e.key === 'tenant.created'));
  assert.ok(!events.some((e: { key: string }) => e.key === 'group.created'));
});

test('a platform user working in a tenant appears in that tenant’s log as platform staff', async () => {
  const admin = await loginSession('platform', P.adminEmail);
  await grantSupportSession(P.adminEmail, A.tenantId, 'READ_WRITE', ['groups:create']);
  const res = await api('POST', '/groups', { cookie: admin.cookie, tenant: A.tenantId, body: { name: `Support-made ${Date.now()}` } });
  assert.equal(res.status, 201);
  const own = await loginSession(A.slug, A.adminEmail);
  const e = (await entries(own.cookie, `?resourceId=${res.json.id}`)).data[0];
  assert.deepEqual([e.event, e.actorType, e.actorEmail], ['group.created', 'PLATFORM', P.adminEmail]);
  void PASSWORD;
});
