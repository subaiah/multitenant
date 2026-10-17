/**
 * Self-service sign-up (routes/signup.ts) and organizations' own domains
 * (lib/domains.ts, routes/custom-domain.ts), end to end: mail goes to a file
 * the test reads like an inbox, and DNS lookups go to a small DNS server the
 * test runs, so a TXT record can be "added" without touching real DNS.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

// ---- A DNS server that answers TXT questions from a map ---------------------
const txt = new Map<string, string[]>();
const dnsServer: Socket = createSocket('udp4');
dnsServer.on('message', (msg, rinfo) => {
  // Question name: length-prefixed labels from byte 12
  const labels: string[] = [];
  let i = 12;
  while (msg[i] !== 0) {
    labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString('ascii'));
    i += msg[i] + 1;
  }
  const qEnd = i + 5; // the 0 byte, then type and class
  const qtype = msg.readUInt16BE(i + 1);
  const records = qtype === 16 ? (txt.get(labels.join('.').toLowerCase()) ?? []) : [];
  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2); // the same id
  header.writeUInt16BE(records.length ? 0x8180 : 0x8183, 2); // a response; NXDOMAIN when there's nothing
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(records.length, 6);
  const answers = records.map((value) => {
    const data = Buffer.concat([Buffer.from([value.length]), Buffer.from(value, 'ascii')]);
    const rr = Buffer.alloc(12);
    rr.writeUInt16BE(0xc00c, 0); // the name: a pointer to the question's
    rr.writeUInt16BE(16, 2); // TXT
    rr.writeUInt16BE(1, 4); // IN
    rr.writeUInt32BE(60, 6);
    rr.writeUInt16BE(data.length, 10);
    return Buffer.concat([rr, data]);
  });
  dnsServer.send(Buffer.concat([header, msg.subarray(12, qEnd), ...answers]), rinfo.port, rinfo.address);
});
await new Promise<void>((resolve) => dnsServer.bind(0, '127.0.0.1', resolve));

const outbox = join(mkdtempSync(join(tmpdir(), 'mail-')), 'outbox.jsonl');
process.env.EMAIL_TRANSPORT = 'file';
process.env.MAIL_OUTBOX_FILE = outbox;
process.env.FRONTEND_URL = 'http://app.test';
process.env.CUSTOM_DOMAIN_TARGET = 'edge.app.test';
process.env.DNS_SERVERS = `127.0.0.1:${(dnsServer.address() as AddressInfo).port}`;

const { PASSWORD, api, baseUrl, db, loginSession, seedTenant, startExtraServer, startServer, stopServerAndCleanUp, trackTenant, waitForProvisioning } =
  await import('./helpers.js');
type TenantSeed = Awaited<ReturnType<typeof seedTenant>>;

let A: TenantSeed;
let B: TenantSeed;
let controlDb: Awaited<ReturnType<typeof db>>['controlDb'];
const run = Math.random().toString(36).slice(2, 8);
const STRONG = 'Sign-up-Passw0rd';

interface Mail { to: string; subject: string; text: string; html: string }
const inbox = (to: string): Mail[] =>
  !existsSync(outbox) ? [] : readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Mail).filter((m) => m.to === to);
const tokenFrom = (mail: Mail | undefined) => {
  const m = mail?.text.match(/token=([A-Za-z0-9_.%-]+)/);
  assert.ok(m, `no link in mail: ${mail?.text}`);
  return decodeURIComponent(m[1]);
};

/** A request with a Host header of our choosing (fetch won't send one) */
function onHost(host: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any; cookies: string[]; location?: string }> {
  const url = new URL(baseUrl());
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, method, path, headers: { host, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json: any = text;
          try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
          const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
          resolve({ status: res.statusCode ?? 0, json, cookies, location: res.headers.location });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const signupBody = (slug: string, email: string, extra: Record<string, unknown> = {}) => ({
  organization: `Org ${slug}`, slug, name: 'Founder', email, password: STRONG, ...extra,
});

/** The sign-up limit is per IP address over an hour, and every request here comes from one */
const resetSignupLimit = () =>
  controlDb.rateLimitHit.deleteMany({
    where: { key: { in: ['127.0.0.1', '::ffff:127.0.0.1'].map((ip) => createHash('sha256').update(`signup:${ip}`).digest('base64url')) } },
  });

before(async () => {
  ({ controlDb } = await db());
  await resetSignupLimit();
  A = await seedTenant('dom');
  B = await seedTenant('dom2');
  await startServer();
});

after(async () => {
  await controlDb.signupRequest.deleteMany({ where: { email: { endsWith: `-${run}@signup.test` } } });
  await stopServerAndCleanUp();
  dnsServer.close();
});

// ---- Sign-up -----------------------------------------------------------------

test('signing up: email link, a trial organization, its admin signs in with the chosen password', async () => {
  const slug = `su-${run}`;
  const email = `founder-${run}@signup.test`;
  const site = await api('GET', '/bff/site');
  assert.equal(site.status, 200);
  assert.deepEqual(site.json, { tenant: null, signup: { passwordPolicy: 'STRONG' } });

  const started = await api('POST', '/bff/signup', { body: signupBody(slug, email) });
  assert.equal(started.status, 202, JSON.stringify(started.json));
  // Nothing exists until the link is opened
  assert.equal(await controlDb.tenant.findUnique({ where: { slug } }), null);
  const row = await controlDb.signupRequest.findFirstOrThrow({ where: { email } });
  assert.ok(row.passwordHash && !row.passwordHash.includes(STRONG), 'only a hash of the password is kept');
  const mail = inbox(email).at(-1);
  assert.ok(mail?.text.includes('http://app.test/signup/verify?token='), String(mail?.text));
  const token = tokenFrom(mail);
  assert.notEqual(row.tokenHash, token, 'the token is stored hashed');

  const verified = await api('POST', '/bff/signup/verify', { body: { token } });
  assert.equal(verified.status, 200, JSON.stringify(verified.json));
  assert.deepEqual(verified.json, { slug, organization: `Org ${slug}`, email });
  const tenant = await controlDb.tenant.findUniqueOrThrow({ where: { slug } });
  trackTenant(tenant.id);
  assert.equal(tenant.status, 'TRIAL');
  assert.equal(tenant.plan, 'FREE');
  assert.equal(tenant.createdById, null);

  // Opening the link again shows the same organization, not a second one
  assert.deepEqual((await api('POST', '/bff/signup/verify', { body: { token } })).json, verified.json);
  assert.equal(await controlDb.tenant.count({ where: { slug } }), 1);

  assert.equal(await waitForProvisioning(tenant.id), 'READY');
  const status = await api('GET', `/bff/signup/status?token=${encodeURIComponent(token)}`);
  assert.deepEqual(status.json, { status: 'READY', slug, email });
  // The password is used once and not kept
  assert.equal((await controlDb.signupRequest.findFirstOrThrow({ where: { email } })).passwordHash, null);
  const ready = inbox(email).at(-1);
  assert.match(ready!.subject, /ready/i);
  assert.ok(ready!.text.includes(`http://app.test/${slug}/login?email=`), ready!.text);

  const login = await api('POST', '/bff/auth/login', { body: { tenantSlug: slug, email, password: STRONG } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  // An administrator: can manage users
  assert.equal((await api('GET', '/users', { cookie })).status, 200);

  const auditRow = await controlDb.platformAuditEvent.findFirst({ where: { event: 'tenant.signed_up', tenantId: tenant.id } });
  assert.equal(auditRow?.actorType, 'ANONYMOUS');
  assert.equal(auditRow?.actorEmail, email);
});

test('sign-up checks: strong password, free and unreserved address, valid link', async () => {
  const email = `checks-${run}@signup.test`;
  const weak = await api('POST', '/bff/signup', { body: signupBody(`weak-${run}`, email, { password: 'short' }) });
  assert.equal(weak.status, 400);
  assert.match(weak.json.message, /at least 10 characters/);
  for (const slug of [A.slug, 'platform', 'login', 'signup']) {
    const res = await api('POST', '/bff/signup', { body: signupBody(slug, email) });
    assert.equal(res.status, 409, `${slug}: ${JSON.stringify(res.json)}`);
  }
  assert.equal((await api('POST', '/bff/signup', { body: signupBody('Not A Slug!', email) })).status, 400);
  assert.equal(inbox(email).length, 0);

  const bad = await api('POST', '/bff/signup/verify', { body: { token: 'not-a-real-token-at-all' } });
  assert.equal(bad.status, 404);
  assert.equal(bad.json.code, 'SIGNUP_EXPIRED');
  assert.equal((await api('GET', '/bff/signup/status?token=not-a-real-token-at-all')).status, 404);

  // An expired link creates nothing
  await api('POST', '/bff/signup', { body: signupBody(`late-${run}`, email) });
  const token = tokenFrom(inbox(email).at(-1));
  await controlDb.signupRequest.updateMany({ where: { email }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await api('POST', '/bff/signup/verify', { body: { token } })).status, 404);
  assert.equal(await controlDb.tenant.findUnique({ where: { slug: `late-${run}` } }), null);

  // The address got taken between the email and the link
  await api('POST', '/bff/signup', { body: signupBody(`race-${run}`, email) });
  const raceToken = tokenFrom(inbox(email).at(-1));
  const racer = await controlDb.tenant.create({ data: { name: 'Racer', slug: `race-${run}`, plan: 'FREE', status: 'ACTIVE' } });
  const raced = await api('POST', '/bff/signup/verify', { body: { token: raceToken } }).finally(() => controlDb.tenant.delete({ where: { id: racer.id } }));
  assert.equal(raced.status, 409);
  assert.equal(raced.json.code, 'SLUG_TAKEN');
  assert.equal((await controlDb.signupRequest.findFirstOrThrow({ where: { email } })).verifiedAt, null, 'the claim is undone');
});

test('sign-up is limited per address', async () => {
  await resetSignupLimit();
  const body = signupBody('Not A Slug!', `limit-${run}@signup.test`);
  for (let i = 0; i < 10; i++) assert.equal((await api('POST', '/bff/signup', { body })).status, 400, `attempt ${i + 1}`);
  assert.equal((await api('POST', '/bff/signup', { body })).status, 429);
  await resetSignupLimit();
});

test('SELF_SIGNUP=false closes sign-up', async () => {
  const closed = await startExtraServer({ SELF_SIGNUP: 'false' });
  try {
    assert.deepEqual((await closed.api('GET', '/bff/site')).json, { tenant: null, signup: null });
    const res = await closed.api('POST', '/bff/signup', { body: signupBody(`closed-${run}`, `closed-${run}@signup.test`) });
    assert.equal(res.status, 404);
    assert.equal(res.json.code, 'SIGNUP_DISABLED');
    assert.equal((await closed.api('POST', '/bff/signup/verify', { body: { token: 'not-a-real-token-at-all' } })).json.code, 'SIGNUP_DISABLED');
  } finally {
    await closed.stop();
  }
});

// ---- Custom domains --------------------------------------------------------

test('custom domain: pending until its TXT record is found, then the app, emails and sign-in use it', async () => {
  await resetSignupLimit();
  const domain = `portal-${run}.example.com`;
  const admin = await loginSession(A.slug, A.adminEmail);
  const user = await loginSession(A.slug, A.userEmail);

  const none = await api('GET', '/custom-domain', { cookie: admin.cookie });
  assert.deepEqual(none.json, { enabled: true, domain: null });
  // Only admins change it
  assert.equal((await api('PUT', '/custom-domain', { cookie: user.cookie, body: { domain } })).status, 403);
  // Not the platform's own addresses, nor something that isn't a hostname
  for (const bad of ['app.test', 'acme.app.test', 'edge.app.test', 'localhost', '10.0.0.1', 'not a domain']) {
    assert.equal((await api('PUT', '/custom-domain', { cookie: admin.cookie, body: { domain: bad } })).status, 400, bad);
  }

  const added = await api('PUT', '/custom-domain', { cookie: admin.cookie, body: { domain: `https://${domain.toUpperCase()}/login` } });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.equal(added.json.domain, domain);
  assert.equal(added.json.status, 'PENDING');
  const [cname, record] = added.json.records;
  assert.deepEqual([cname.type, cname.name, cname.value], ['CNAME', domain, 'edge.app.test']);
  assert.equal(record.name, `_tenant-verify.${domain}`);
  assert.match(record.value, /^tenant-verify=[A-Za-z0-9_-]+$/);

  // Another organization can't take it
  const other = await loginSession(B.slug, B.adminEmail);
  assert.equal((await api('PUT', '/custom-domain', { cookie: other.cookie, body: { domain } })).status, 409);

  // Pending: the domain does nothing yet
  assert.equal((await onHost(domain, 'GET', '/bff/site')).json.tenant, null);
  assert.equal((await api('GET', `/internal/tls-allowed?domain=${domain}`)).status, 404);

  // No record yet, then the wrong one, then the right one
  let checked = await api('POST', '/custom-domain/check', { cookie: admin.cookie });
  assert.equal(checked.json.status, 'PENDING');
  assert.match(checked.json.error, /No TXT record/);
  txt.set(`_tenant-verify.${domain}`, ['tenant-verify=somebody-else']);
  checked = await api('POST', '/custom-domain/check', { cookie: admin.cookie });
  assert.match(checked.json.error, /not the one shown here/);
  txt.set(`_tenant-verify.${domain}`, ['v=spf1 -all', record.value]);
  checked = await api('POST', '/custom-domain/check', { cookie: admin.cookie });
  assert.equal(checked.json.status, 'VERIFIED', JSON.stringify(checked.json));
  assert.ok(checked.json.verifiedAt);
  const audit = (await api('GET', '/audit?event=custom_domain.verified', { cookie: admin.cookie })).json.data;
  assert.equal(audit[0]?.resourceLabel ?? audit[0]?.resource?.label, domain);

  // Removing the record later doesn't take the domain away
  txt.delete(`_tenant-verify.${domain}`);
  assert.equal((await api('POST', '/custom-domain/check', { cookie: admin.cookie })).json.status, 'VERIFIED');

  // The web server may get a certificate for it, and only for it
  assert.equal((await api('GET', `/internal/tls-allowed?domain=${domain}`)).status, 200);
  assert.equal((await api('GET', `/internal/tls-allowed?domain=other-${domain}`)).status, 404);

  // On the domain: this organization, no sign-up
  assert.deepEqual((await onHost(domain, 'GET', '/bff/site')).json, { tenant: { slug: A.slug, name: 'Test dom' }, signup: null });
  assert.equal((await onHost(domain, 'POST', '/bff/signup', signupBody(`ondomain-${run}`, `d-${run}@signup.test`))).status, 404);

  // Signs in to its own organization only
  const own = await onHost(domain, 'POST', '/bff/auth/login', { tenantSlug: A.slug, email: A.adminEmail, password: PASSWORD });
  assert.equal(own.status, 200, JSON.stringify(own.json));
  const foreign = await onHost(domain, 'POST', '/bff/auth/login', { tenantSlug: B.slug, email: B.adminEmail, password: PASSWORD });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.json.code, 'WRONG_DOMAIN');
  assert.equal(foreign.cookies.length, 0);
  const portal = await onHost(domain, 'POST', '/bff/auth/login', { tenantSlug: 'platform', email: 'someone@example.com', password: PASSWORD });
  assert.equal(portal.json.code, 'WRONG_DOMAIN', JSON.stringify(portal));
  assert.equal((await onHost(domain, 'POST', '/bff/auth/otp/request', { tenantSlug: B.slug, email: B.adminEmail })).status, 403);
  // The platform's address still signs in to anyone
  assert.equal((await api('POST', '/bff/auth/login', { body: { tenantSlug: B.slug, email: B.adminEmail, password: PASSWORD } })).status, 200);

  // Emails link to the domain
  await api('POST', '/bff/account/password/forgot', { body: { tenantSlug: A.slug, email: A.userEmail } });
  const reset = inbox(A.userEmail).at(-1);
  assert.ok(reset?.text.includes(`https://${domain}/reset-password?token=`), String(reset?.text));

  // Single sign-on can return to either address; the tenant registers both
  const sso = await api('GET', '/auth-config', { cookie: admin.cookie });
  assert.equal(sso.json.ssoRedirectUris.length, 2, JSON.stringify(sso.json.ssoRedirectUris));
  assert.ok(sso.json.ssoRedirectUris[1].startsWith(`https://${domain}/`), sso.json.ssoRedirectUris[1]);

  // Single sign-on started for another organization on this domain goes back with an error
  const ssoForeign = await onHost(domain, 'GET', `/bff/auth/sso/start?tenantSlug=${B.slug}&providerId=${B.providerId}`);
  assert.equal(ssoForeign.status, 302);
  const back = new URL(ssoForeign.location!);
  assert.equal(back.host, domain);
  assert.equal(back.searchParams.get('sso_error'), 'WRONG_DOMAIN');

  // Removed: back to the platform's address
  const removed = await api('DELETE', '/custom-domain', { cookie: admin.cookie });
  assert.deepEqual(removed.json, { enabled: true, domain: null });
  assert.equal((await api('GET', `/internal/tls-allowed?domain=${domain}`)).status, 404);
  assert.equal((await onHost(domain, 'POST', '/bff/auth/login', { tenantSlug: B.slug, email: B.adminEmail, password: PASSWORD })).status, 200);
});
