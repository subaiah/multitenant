/**
 * Tenants are created by platform admins (no self sign-up): the tenant goes
 * in the control plane, its defaults and first administrator in the tenant
 * plane, and the administrator is invited by email. Deleting a tenant removes
 * its data from both planes.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outbox = join(mkdtempSync(join(tmpdir(), 'mail-')), 'outbox.jsonl');
process.env.EMAIL_TRANSPORT = 'file';
process.env.MAIL_OUTBOX_FILE = outbox;
process.env.FRONTEND_URL = 'http://app.test';

const { PASSWORD, api, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, trackTenant } = await import('./helpers.js');

let platformAdmin: string;
let platformSupport: string;
let A: Awaited<ReturnType<typeof seedTenant>>;
const stamp = Date.now().toString(36);

const lastMail = (to: string) =>
  existsSync(outbox)
    ? readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.to === to).at(-1)
    : undefined;

before(async () => {
  ({ adminEmail: platformAdmin, supportEmail: platformSupport } = await seedPlatformUsers());
  A = await seedTenant('tcreate');
  await startServer();
});
after(stopServerAndCleanUp);

const asPlatform = async (email: string) => (await loginSession('platform', email)).cookie;

test('a platform admin creates a tenant; its first admin is invited and can sign in', async () => {
  const { controlDb, tenantDb } = await db();
  const cookie = await asPlatform(platformAdmin);
  const slug = `new-${stamp}`;
  const adminEmail = `first-admin-${stamp}@test.local`;
  const res = await api('POST', '/tenants', {
    cookie,
    body: { name: 'New Co', slug, plan: 'STARTER', adminName: 'First Admin', adminEmail },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  trackTenant(res.json.id);
  assert.equal(res.json.adminInvited, adminEmail);

  // Control plane: the tenant and where its data lives
  const cfg = await controlDb.databaseConfig.findUnique({ where: { tenantId: res.json.id } });
  assert.equal(cfg?.strategy, 'SHARED_TABLES');
  // Tenant plane: defaults and a pending administrator
  assert.ok(await tenantDb.authConfig.findUnique({ where: { tenantId: res.json.id } }));
  const roles = await tenantDb.role.findMany({ where: { tenantId: res.json.id }, select: { name: true } });
  assert.ok(roles.some((r) => r.name === 'Tenant Admin'), 'built-in roles created');
  const admin = await tenantDb.user.findFirstOrThrow({ where: { tenantId: res.json.id, email: adminEmail } });
  assert.equal(admin.status, 'PENDING');
  assert.equal(admin.userType, 'TENANT_ADMIN');

  // The invitation works and the new admin can use their tenant
  const token = lastMail(adminEmail)?.text.match(/token=([A-Za-z0-9_.-]+)/)?.[1];
  assert.ok(token?.startsWith(`${slug}.`), 'invitation token names the tenant');
  const accepted = await api('POST', '/bff/account/invitations/accept', { body: { token, password: PASSWORD } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  const session = await loginSession(slug, adminEmail);
  assert.equal((await api('GET', '/users', { cookie: session.cookie })).status, 200);

  // It shows on the tenants page with its counts
  const list = await api('GET', `/tenants?search=${slug}`, { cookie });
  assert.equal(list.json.data[0]._count.users, 1);
});

test('slugs are validated, unique, and the platform slugs are reserved', async () => {
  const cookie = await asPlatform(platformAdmin);
  const body = { name: 'Xylo', adminName: 'X Admin', adminEmail: `x-${stamp}@test.local` };
  assert.equal((await api('POST', '/tenants', { cookie, body: { ...body, slug: 'platform' } })).status, 409);
  assert.equal((await api('POST', '/tenants', { cookie, body: { ...body, slug: 'admin' } })).status, 409);
  assert.equal((await api('POST', '/tenants', { cookie, body: { ...body, slug: A.slug } })).status, 409);
  assert.equal((await api('POST', '/tenants', { cookie, body: { ...body, slug: 'Not OK!' } })).status, 400);
});

test('only platform admins can create tenants', async () => {
  const body = { name: 'Nope', slug: `nope-${stamp}`, adminName: 'N', adminEmail: `n-${stamp}@test.local` };
  assert.equal((await api('POST', '/tenants', { cookie: await asPlatform(platformSupport), body })).status, 403);
  const tenantAdmin = (await loginSession(A.slug, A.adminEmail)).cookie;
  assert.equal((await api('POST', '/tenants', { cookie: tenantAdmin, body })).status, 403);
});

test('deleting a tenant removes its data from both planes', async () => {
  const { controlDb, tenantDb } = await db();
  const cookie = await asPlatform(platformAdmin);
  const slug = `gone-${stamp}`;
  const res = await api('POST', '/tenants', {
    cookie,
    body: { name: 'Gone Co', slug, adminName: 'Gone Admin', adminEmail: `gone-${stamp}@test.local` },
  });
  assert.equal(res.status, 201);
  const id = res.json.id;
  trackTenant(id);

  assert.equal((await api('DELETE', `/tenants/${id}`, { cookie })).status, 204);
  assert.equal(await controlDb.tenant.findUnique({ where: { id } }), null);
  assert.equal(await controlDb.databaseConfig.findUnique({ where: { tenantId: id } }), null);
  assert.equal(await tenantDb.user.count({ where: { tenantId: id } }), 0);
  assert.equal(await tenantDb.role.count({ where: { tenantId: id } }), 0);
  assert.equal(await tenantDb.authConfig.count({ where: { tenantId: id } }), 0);
});
