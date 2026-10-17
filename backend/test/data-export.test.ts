/**
 * Organizations' data exports (lib/data-export.ts, routes/data-exports.ts):
 * a ZIP of CSV files with the organization's own rows only, without secrets,
 * for its administrators only, kept for a limited time.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const outbox = join(mkdtempSync(join(tmpdir(), 'mail-')), 'outbox.jsonl');
process.env.EMAIL_TRANSPORT = 'file';
process.env.MAIL_OUTBOX_FILE = outbox;
process.env.FRONTEND_URL = 'http://app.test';

const { api, baseUrl, db, grantSupportSession, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp } = await import('./helpers.js');
const { csvCell, exportFile, maintainExports } = await import('../src/lib/data-export.js');
type TenantSeed = Awaited<ReturnType<typeof seedTenant>>;

let A: TenantSeed;
let B: TenantSeed;
let platformAdmin: string;
let controlDb: Awaited<ReturnType<typeof db>>['controlDb'];
const work = mkdtempSync(join(tmpdir(), 'export-test-'));

before(async () => {
  ({ controlDb } = await db());
  A = await seedTenant('exp');
  B = await seedTenant('exp2');
  platformAdmin = (await seedPlatformUsers()).adminEmail;
  await startServer();
});
after(stopServerAndCleanUp);

async function finished(cookie: string, id: string) {
  for (let i = 0; i < 100; i++) {
    const e = (await api('GET', '/data-exports', { cookie })).json.exports.find((x: { id: string }) => x.id === id);
    if (e.status === 'READY' || e.status === 'FAILED') return e;
    await sleep(200);
  }
  throw new Error('export did not finish');
}

async function download(cookie: string, id: string) {
  const res = await fetch(`${baseUrl()}/data-exports/${id}/download`, { headers: { cookie } });
  const file = join(work, `${id}.zip`);
  if (res.ok) writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return { status: res.status, headers: res.headers, file };
}
const unzip = (file: string, name: string) => execFileSync('unzip', ['-p', file, name]).toString('utf8');
const parseCsv = (text: string) => text.replace(/^﻿/, '').trim().split('\r\n');

test('CSV values are quoted, typed and kept away from spreadsheet formulas', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a, "b"'), '"a, ""b"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-42.5'), '-42.5', 'numbers stay numbers');
  assert.equal(csvCell(-3), '-3');
  assert.equal(csvCell(['a', 'b']), '"[""a"",""b""]"');
  assert.equal(csvCell({ k: 1 }), '"{""k"":1}"');
  assert.equal(csvCell(true), 'true');
});

test("an administrator exports the organization's data: its rows only, no secrets", async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  // Data worth checking: a formula-looking name, commas and quotes, other scripts
  await A.db.group.create({ data: { tenantId: A.tenantId, name: '=cmd|calc', description: 'Ünïcode, "quoted"' } });

  const started = await api('POST', '/data-exports', { cookie: admin.cookie });
  assert.equal(started.status, 202, JSON.stringify(started.json));
  const done = await finished(admin.cookie, started.json.id);
  assert.equal(done.status, 'READY', JSON.stringify(done));
  assert.ok(done.sizeBytes > 0);
  assert.ok(new Date(done.expiresAt).getTime() > Date.now() + 6 * 86_400_000);
  const mail = readFileSync(outbox, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((m) => m.to === A.adminEmail).at(-1);
  assert.match(mail.subject, /data export is ready/);
  assert.ok(mail.text.includes('http://app.test/settings'));

  const dl = await download(admin.cookie, started.json.id);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/zip');
  assert.match(dl.headers.get('content-disposition')!, new RegExp(`${A.slug}-data-\\d{4}-\\d{2}-\\d{2}\\.zip`));
  execFileSync('unzip', ['-t', dl.file]);
  const listing = execFileSync('unzip', ['-Z1', dl.file]).toString().trim().split('\n');
  for (const f of ['users.csv', 'groups.csv', 'audit_events.csv', 'roles.csv', 'manifest.json', 'README.txt']) assert.ok(listing.includes(f), `${f} in ${listing}`);
  for (const f of ['refresh_tokens.csv', 'otp_codes.csv', 'user_tokens.csv', 'oauth_sessions.csv', 'tenant_roles.csv']) assert.ok(!listing.includes(f), `${f} left out`);

  // Users: everyone in A, nobody from B, no secrets
  const users = parseCsv(unzip(dl.file, 'users.csv'));
  const header = users[0].split(',');
  assert.ok(header.includes('email') && header.includes('tenant_id'));
  for (const secret of ['password_hash', 'totp_secret', 'mfa_recovery_codes']) assert.ok(!header.includes(secret), `${secret} left out`);
  assert.equal(users.length - 1, 3);
  const all = execFileSync('unzip', ['-p', dl.file]).toString('utf8');
  for (const email of [A.adminEmail, A.managerEmail, A.userEmail]) assert.ok(all.includes(email));
  for (const email of [B.adminEmail, B.managerEmail, B.userEmail]) assert.ok(!all.includes(email), `${email} from another tenant`);
  assert.ok(!all.includes(B.tenantId), "no row of B's");
  assert.ok(!all.includes('TOP-SECRET'), 'SSO client secret left out');

  const groups = unzip(dl.file, 'groups.csv');
  assert.ok(groups.includes(`'=cmd|calc`));
  assert.ok(groups.includes('"Ünïcode, ""quoted"""'));

  const manifest = JSON.parse(unzip(dl.file, 'manifest.json'));
  assert.equal(manifest.address, A.slug);
  assert.equal(manifest.tables.find((t: { table: string }) => t.table === 'users').rows, 3);
  assert.deepEqual(manifest.tables.find((t: { table: string }) => t.table === 'users').omittedColumns.sort(), ['mfa_recovery_codes', 'password_hash', 'totp_secret']);
  assert.ok(manifest.omittedTables.includes('refresh_tokens'));

  // In the organization's audit log
  const log = (await api('GET', '/audit?event=data_export.downloaded', { cookie: admin.cookie })).json.data;
  assert.equal(log.length, 1);
});

test('only its own administrators can export or download', async () => {
  const admin = await loginSession(A.slug, A.adminEmail);
  const manager = await loginSession(A.slug, A.managerEmail);
  const otherAdmin = await loginSession(B.slug, B.adminEmail);
  const e = await controlDb.dataExport.findFirstOrThrow({ where: { tenantId: A.tenantId, status: 'READY' } });

  assert.equal((await api('POST', '/data-exports', { cookie: manager.cookie })).status, 403);
  assert.equal((await download(manager.cookie, e.id)).status, 403);
  assert.equal((await download(otherAdmin.cookie, e.id)).status, 404, "another organization's admin");

  // Platform staff in a support session, even with settings access
  await grantSupportSession(platformAdmin, A.tenantId, 'READ_WRITE', ['settings:manage']);
  const platform = await loginSession('platform', platformAdmin);
  assert.equal((await api('POST', '/data-exports', { cookie: platform.cookie, tenant: A.tenantId })).status, 403);
  const res = await fetch(`${baseUrl()}/data-exports/${e.id}/download`, { headers: { cookie: platform.cookie, 'x-tenant-id': A.tenantId } });
  assert.equal(res.status, 403);

  // One at a time
  const pending = await controlDb.dataExport.create({ data: { tenantId: A.tenantId, status: 'RUNNING', startedAt: new Date() } });
  assert.equal((await api('POST', '/data-exports', { cookie: admin.cookie })).json.code, 'EXPORT_IN_PROGRESS');
  await controlDb.dataExport.delete({ where: { id: pending.id } });
});

test('allowed when the trial has ended; expired exports are removed', async () => {
  await controlDb.tenant.update({ where: { id: A.tenantId }, data: { status: 'TRIAL', trialEndsAt: new Date(Date.now() - 1000) } });
  try {
    const admin = await loginSession(A.slug, A.adminEmail);
    assert.equal((await api('POST', '/groups', { cookie: admin.cookie, body: { name: 'Nope' } })).status, 403, 'read-only');
    const started = await api('POST', '/data-exports', { cookie: admin.cookie });
    assert.equal(started.status, 202, JSON.stringify(started.json));
    const done = await finished(admin.cookie, started.json.id);
    assert.equal(done.status, 'READY');

    const e = await controlDb.dataExport.findUniqueOrThrow({ where: { id: done.id } });
    assert.ok(existsSync(exportFile(e)));
    await controlDb.dataExport.update({ where: { id: e.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await download(admin.cookie, e.id)).status, 410);
    await maintainExports();
    assert.ok(!existsSync(exportFile(e)), 'file removed');
    assert.equal(await controlDb.dataExport.findUnique({ where: { id: e.id } }), null);
  } finally {
    await controlDb.tenant.update({ where: { id: A.tenantId }, data: { status: 'ACTIVE', trialEndsAt: null } });
  }
});

test("an export a restart interrupted is built by the next check; deleting the tenant removes its exports", async () => {
  const C = await seedTenant('exp3');
  const stuck = await controlDb.dataExport.create({ data: { tenantId: C.tenantId, status: 'RUNNING', startedAt: new Date(Date.now() - 3 * 3_600_000) } });
  const r = await maintainExports();
  assert.ok(r.resumed >= 1);
  const e = await controlDb.dataExport.findUniqueOrThrow({ where: { id: stuck.id } });
  assert.equal(e.status, 'READY', e.error ?? '');
  assert.ok(existsSync(exportFile(e)));

  const { deprovisionTenant } = await import('../src/lib/provisioning.js');
  await deprovisionTenant(C.tenantId);
  assert.ok(!existsSync(exportFile(e)));
  assert.equal(await controlDb.dataExport.count({ where: { tenantId: C.tenantId } }), 0);
});
