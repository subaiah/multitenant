// Release smoke test, in a real browser, against a running installation
// (CI: the Docker Compose stack from deploy/, as it ships):
//
//   1. the first platform administrator accepts their invitation, sets up
//      two-factor and signs in;
//   2. they create a tenant in its own database and wait until it's ready;
//   3. the tenant's first administrator accepts their invitation, signs in,
//      and exports the organization's data (a ZIP download);
//   4. someone signs up a new organization themselves, confirms by email,
//      signs in to its trial, and closes it; platform staff restore it;
//   5. pages with sample data are hidden, and nothing on the way breaks the
//      content policy or throws.
//
//   APP=http://localhost ADMIN_LINK=<from create-admin> MAIL_CMD="<prints sent emails>" node e2e/smoke.mjs
//
// MAIL_CMD prints whatever the server sent (the API's log with
// EMAIL_TRANSPORT=log, or the outbox file); links are found in it.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const APP = (process.env.APP ?? 'http://localhost').replace(/\/$/, '');
const ADMIN_LINK = process.env.ADMIN_LINK;
const MAIL_CMD = process.env.MAIL_CMD;
const SHOTS = process.env.SHOTS ?? fileURLToPath(new URL('./screenshots', import.meta.url));
mkdirSync(SHOTS, { recursive: true });
if (!ADMIN_LINK || !MAIL_CMD) throw new Error('Set ADMIN_LINK and MAIL_CMD (see the top of this file)');

const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`);
const stamp = Date.now().toString(36).slice(-5);
const TENANT = { name: `Smoke Test ${stamp}`, slug: `smoke-test-${stamp}`, admin: `owner-${stamp}@smoke.test` };
const PASSWORD = `Smoke-${stamp}-Passw0rd!`;
const SIGNUP = { org: `Self Serve ${stamp}`, slug: `self-serve-${stamp}`, email: `founder-${stamp}@smoke.test` };

// ---- TOTP, as the server computes it
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.replace(/[\s=]/g, '').toUpperCase()) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', b32(secret)).update(c).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// Everything that goes wrong in a page: script errors, failed requests to
// our own address, and content-policy violations
const problems = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
async function newPage() {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  page.on('pageerror', (e) => problems.push(`script error: ${e.message}`));
  page.on('console', (m) => { if (/Content.Security.Policy|Refused to/i.test(m.text())) problems.push(`policy: ${m.text()}`); });
  page.on('response', (r) => { if (r.url().startsWith(APP) && r.status() >= 500) problems.push(`${r.status()} ${r.url()}`); });
  page.on('dialog', (d) => d.accept());
  return page;
}

async function waitForLink(to, path) {
  for (let i = 0; i < 60; i++) {
    const link = latestLink(to, path);
    if (link) return link;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function latestLink(to, path) {
  const text = execSync(MAIL_CMD, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // The email's recipient comes before its link, in the log and the outbox alike
  const start = text.lastIndexOf(to);
  if (start < 0) return null;
  return text.slice(start).match(new RegExp(`https?://[^\\s"\\\\]+/${path}\\?token=[^\\s"\\\\]+`))?.[0] ?? null;
}

async function acceptInvitation(page, link, heading) {
  await page.goto(link);
  await page.getByRole('heading', { name: heading }).waitFor();
  await page.fill('#new-password', PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/login\?notice=invite-accepted/, { timeout: 15000 });
}

async function signIn(page) {
  const b = page.getByRole('button', { name: 'Sign in with Email' });
  if (await b.isVisible().catch(() => false)) await b.click();
  await page.fill('input[type=password]', PASSWORD);
  await page.locator('form button[type=submit]').last().click();
}

try {
  // ---- headers as served
  const home = await fetch(`${APP}/`);
  check('the app is served with a content policy', /default-src 'self'/.test(home.headers.get('content-security-policy') ?? ''));
  const health = await fetch(`${APP}/api/health`);
  check('the API answers under /api', health.ok, String(health.status));
  check('the API reference is off', (await fetch(`${APP}/api/docs`)).status === 404);

  // ---- 1. the first platform administrator
  const admin = await newPage();
  await acceptInvitation(admin, ADMIN_LINK, /Join (Platform Administration|the platform)/);
  check('first administrator sets a password', true);
  await signIn(admin);
  // Platform staff must use two-factor in production
  await admin.getByText('Set up two-factor sign-in').waitFor({ timeout: 15000 });
  await admin.locator('img[alt^="QR code"]').waitFor();
  await admin.getByText("Can't scan? Enter this key instead").click();
  const secret = (await admin.locator('details code').innerText()).replace(/\s/g, '');
  await admin.getByLabel('Authentication code').fill(totp(secret));
  await admin.getByRole('button', { name: 'Confirm and sign in' }).click();
  await admin.getByLabel('Recovery codes').waitFor();
  await admin.getByRole('button', { name: /saved them/ }).click();
  await admin.waitForURL('**/platform/dashboard', { timeout: 15000 });
  check('signed in with two-factor', true);
  await admin.waitForLoadState('networkidle');
  await admin.screenshot({ path: `${SHOTS}/platform-dashboard.png`, fullPage: true });
  const platformMenu = await admin.locator('nav').innerText();
  check('platform "coming soon" pages are hidden', !/Global policies/i.test(platformMenu), platformMenu.replace(/\s+/g, ' '));

  // ---- 2. a tenant in its own database
  await admin.goto(`${APP}/platform/tenants`);
  await admin.getByRole('button', { name: 'New tenant' }).click();
  const dlg = admin.getByRole('dialog', { name: 'New tenant' });
  await dlg.getByLabel('Organization name').fill(TENANT.name);
  await dlg.getByLabel('Name', { exact: true }).fill('Smoke Owner');
  await dlg.getByLabel('Email').fill(TENANT.admin);
  await dlg.getByRole('radio', { name: /Own database/ }).check();
  await dlg.getByRole('button', { name: 'Create tenant' }).click();
  const card = admin.getByRole('button', { name: new RegExp(TENANT.name) });
  await card.waitFor();
  await card.getByText('Setting up…').waitFor({ state: 'detached', timeout: 60000 });
  check('tenant provisioned in its own database', (await card.innerText()).includes('Own database'));

  // ---- 3. its first administrator
  let link = null;
  for (let i = 0; i < 60 && !link; i++) {
    link = latestLink(TENANT.admin, 'accept-invite');
    if (!link) await new Promise((r) => setTimeout(r, 500));
  }
  check('tenant invitation sent', !!link);
  const owner = await newPage();
  await acceptInvitation(owner, link, new RegExp(`Join ${TENANT.name}`));
  await signIn(owner);
  await owner.waitForURL('**/dashboard', { timeout: 15000 });
  check('tenant administrator signs in', true);
  await owner.getByText(/Welcome back/).waitFor();
  await owner.screenshot({ path: `${SHOTS}/tenant-dashboard.png`, fullPage: true });
  const tenantMenu = await owner.locator('nav').innerText();
  check('sample-data pages are hidden', !/Infrastructure/i.test(tenantMenu) && (await owner.getByText('Apps running').count()) === 0);
  await owner.goto(`${APP}/users`);
  await owner.locator('tr', { hasText: TENANT.admin }).waitFor();
  check('their Users page lists them', true);

  // ---- ...and export the organization's data
  await owner.goto(`${APP}/settings`);
  await owner.getByRole('button', { name: 'Export all data' }).click();
  const downloadButton = owner.locator('#data-export').getByRole('button', { name: 'Download' }).first();
  await downloadButton.waitFor({ timeout: 60000 });
  const [download] = await Promise.all([owner.waitForEvent('download'), downloadButton.click()]);
  const zip = `${SHOTS}/export.zip`;
  await download.saveAs(zip);
  check('data export downloads as a ZIP', readFileSync(zip).subarray(0, 2).toString('latin1') === 'PK', download.suggestedFilename());

  // ---- 4. self-service sign-up, on its own trial
  const visitor = await newPage();
  await visitor.goto(`${APP}/login`);
  await visitor.getByRole('link', { name: 'Create an organization' }).click();
  await visitor.getByLabel('Organization name').fill(SIGNUP.org);
  await visitor.getByLabel('Your name').fill('Smoke Founder');
  await visitor.getByLabel('Work email').fill(SIGNUP.email);
  await visitor.getByLabel('Password', { exact: true }).fill(PASSWORD);
  check('sign-up suggests the address', (await visitor.getByLabel('Sign-in address').inputValue()) === SIGNUP.slug);
  await visitor.getByRole('button', { name: 'Create organization' }).click();
  await visitor.getByRole('heading', { name: 'Check your email' }).waitFor();
  const confirm = await waitForLink(SIGNUP.email, 'signup/verify');
  check('sign-up confirmation sent', !!confirm);
  await visitor.goto(confirm);
  await visitor.getByRole('heading', { name: `${SIGNUP.org} is ready` }).waitFor({ timeout: 90000 });
  await visitor.getByRole('link', { name: 'Sign in' }).click();
  await signIn(visitor);
  await visitor.waitForURL('**/dashboard', { timeout: 15000 });
  await visitor.getByRole('status').filter({ hasText: 'Trial:' }).waitFor();
  check('signed-up administrator signs in to a trial', true);

  // ---- ...closes it, and platform staff restore it
  await visitor.goto(`${APP}/settings`);
  await visitor.getByRole('button', { name: 'Close organization…' }).click();
  const closing = visitor.getByRole('dialog', { name: `Close ${SIGNUP.org}` });
  await closing.getByLabel('Organization address').fill(SIGNUP.slug);
  await closing.getByLabel('Your password').fill(PASSWORD);
  await closing.getByRole('button', { name: 'Close organization' }).click();
  await visitor.waitForURL('**/login?notice=organization-closed', { timeout: 15000 });
  check('organization closed', true);
  await admin.goto(`${APP}/platform/tenants?search=${SIGNUP.slug}`);
  const closedCard = admin.getByRole('button', { name: new RegExp(SIGNUP.org) });
  await closedCard.getByText('Closing').waitFor();
  await closedCard.click();
  await admin.getByRole('dialog', { name: SIGNUP.org }).getByRole('button', { name: 'Restore' }).click();
  await admin.getByRole('status').filter({ hasText: 'was restored' }).waitFor();
  check('platform staff restore it', true);

  check('no script errors, server errors or blocked content', problems.length === 0, problems.slice(0, 5).join(' | '));
} catch (err) {
  check('journey finished', false, err instanceof Error ? err.message.split('\n')[0] : String(err));
  for (const p of problems.slice(0, 10)) console.log(p);
} finally {
  await browser.close();
  console.log(results.join('\n'));
  process.exitCode = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
}
