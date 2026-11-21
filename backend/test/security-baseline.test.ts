/**
 * The platform's security baseline (lib/security-baseline.ts).
 *
 * The baseline is platform-wide and test files run side by side on one
 * database, so raising it here (two-factor for admins, no emailed codes)
 * would change other files' sign-ins mid-run. The rules are checked
 * directly; the endpoint is checked for what it refuses (nothing saved) and
 * with a change that affects nobody (the session cap at its maximum).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, loginSession, seedPlatformUsers, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';
import { baselineRequiresMfa, effectiveSignIn, ipAllowed, looserThanBaseline, stricterPolicy, type SecurityBaseline } from '../src/lib/security-baseline.js';

const base: SecurityBaseline = { minPasswordPolicy: 'STANDARD', mfaRequiredFor: 'NONE', maxIdleMinutes: null, maxSessionHours: null, emailedCodesAllowed: true, staffIpAllowlist: [], updatedAt: null };
let A: TenantSeed;
let staff: string;

before(async () => {
  await startServer();
  A = await seedTenant('baseline');
  const P = await seedPlatformUsers();
  staff = (await loginSession('platform', P.adminEmail)).cookie;
});
after(async () => {
  const { controlDb } = await db();
  await controlDb.securityBaseline.deleteMany({ where: { id: 'platform' } });
  await stopServerAndCleanUp();
});

test('organizations can be stricter than the baseline, never looser', () => {
  const b: SecurityBaseline = { ...base, minPasswordPolicy: 'STRONG', maxIdleMinutes: 30, maxSessionHours: 8, emailedCodesAllowed: false, mfaRequiredFor: 'EVERYONE' };
  // What applies: the stricter of the two
  assert.deepEqual(effectiveSignIn(b, { passwordPolicy: 'STANDARD', sessionTimeout: 60, maxSessionHours: 12, otpEnabled: true }),
    { passwordPolicy: 'STRONG', sessionTimeout: 30, maxSessionHours: 8, otpEnabled: false });
  assert.deepEqual(effectiveSignIn(b, { passwordPolicy: 'VERY_STRONG', sessionTimeout: 15, maxSessionHours: 4, otpEnabled: false }),
    { passwordPolicy: 'VERY_STRONG', sessionTimeout: 15, maxSessionHours: 4, otpEnabled: false });
  // Saving looser is refused, field by field; stricter is fine
  assert.equal(looserThanBaseline(b, { passwordPolicy: 'STANDARD', sessionTimeout: 45, maxSessionHours: 9, otpEnabled: true, mfaEnabled: false }).length, 5);
  assert.deepEqual(looserThanBaseline(b, { passwordPolicy: 'VERY_STRONG', sessionTimeout: 20, maxSessionHours: 8, otpEnabled: false, mfaEnabled: true }), []);
  assert.equal(stricterPolicy('STRONG', 'STANDARD'), 'STRONG');
});

test('two-factor for administrators means organization admins and platform staff', () => {
  const admins = { ...base, mfaRequiredFor: 'ADMINS' as const };
  assert.ok(baselineRequiresMfa(admins, 'TENANT_ADMIN'));
  assert.ok(baselineRequiresMfa(admins, 'PLATFORM_USER'));
  assert.ok(!baselineRequiresMfa(admins, 'TENANT_USER'));
  assert.ok(baselineRequiresMfa({ ...base, mfaRequiredFor: 'EVERYONE' }, 'TENANT_VIEWER'));
  assert.ok(!baselineRequiresMfa(base, 'PLATFORM_ADMIN'));
});

test('staff addresses: single addresses and ranges, IPv4-mapped IPv6 included', () => {
  const list = ['203.0.113.0/24', '198.51.100.7', '2001:db8::/32'];
  assert.ok(ipAllowed(list, '203.0.113.42'));
  assert.ok(ipAllowed(list, '::ffff:198.51.100.7'));
  assert.ok(ipAllowed(list, '2001:db8::1'));
  assert.ok(!ipAllowed(list, '192.0.2.1'));
  assert.ok(ipAllowed([], '192.0.2.1'), 'no list: anywhere');
});

test('the endpoint refuses a list that would lock you out, or that isn\'t addresses', async () => {
  const body = { minPasswordPolicy: 'STANDARD', mfaRequiredFor: 'NONE', maxIdleMinutes: null, maxSessionHours: null, emailedCodesAllowed: true };
  const lockout = await api('PUT', '/platform/security-baseline', { cookie: staff, body: { ...body, staffIpAllowlist: ['192.0.2.0/24'] } });
  assert.equal(lockout.status, 400);
  assert.equal(lockout.json.code, 'WOULD_LOCK_OUT');
  const bad = await api('PUT', '/platform/security-baseline', { cookie: staff, body: { ...body, staffIpAllowlist: ['not-an-address'] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'INVALID_IP_RANGE');
  // Organizations can't change it
  const { cookie } = await loginSession(A.slug, A.adminEmail);
  assert.equal((await api('PUT', '/platform/security-baseline', { cookie, body: { ...body, staffIpAllowlist: [] } })).status, 403);
});

test('a saved baseline is recorded, and organizations see it with their settings', async () => {
  // A cap at the largest session anyone can set: changes nobody's sign-in
  const saved = await api('PUT', '/platform/security-baseline', {
    cookie: staff,
    body: { minPasswordPolicy: 'STANDARD', mfaRequiredFor: 'NONE', maxIdleMinutes: null, maxSessionHours: 720, emailedCodesAllowed: true, staffIpAllowlist: [] },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.maxSessionHours, 720);
  assert.equal(typeof saved.json.yourAddress, 'string');

  const { controlDb } = await db();
  const entry = await controlDb.platformAuditEvent.findFirst({ where: { event: 'platform.security_baseline_updated' }, orderBy: { occurredAt: 'desc' } });
  assert.ok(entry, 'recorded in the platform log');

  const { cookie } = await loginSession(A.slug, A.adminEmail);
  const settings = await api('GET', '/auth-config', { cookie });
  assert.equal(settings.status, 200);
  assert.equal(settings.json.baseline.maxSessionHours, 720);
  assert.equal(settings.json.baseline.staffIpAllowlist, undefined, "organizations don't see staff addresses");
  assert.equal(settings.json.effective.maxSessionHours, settings.json.maxSessionHours);
});
