/**
 * What happens to tenants over time, checked every TENANT_LIFECYCLE_INTERVAL_MS
 * on one server at a time:
 *
 * - Trials (TRIAL_DAYS): admins are emailed TRIAL_REMINDER_DAYS before the
 *   end, and again when it ends. An ended trial is read-only (the
 *   authenticate middleware refuses changes) until platform staff change the
 *   tenant's status or move the end date.
 * - Closed organizations (routes/organization-closure.ts): deleted once deleteAfter
 *   passes, unless platform staff restored them.
 * - Sign-up requests (routes/signup.ts): unconfirmed ones once their link has
 *   expired, and confirmed ones once the organization has been set up.
 * - Custom domains (lib/domains.ts): verified ones are checked again every
 *   DOMAIN_RECHECK_HOURS; see recheckDomains.
 * - Data exports (lib/data-export.ts): ones a restart interrupted are built,
 *   expired ones removed.
 */
import pg from 'pg';
import { config } from '../config/env.js';
import { controlDb } from './prisma.js';
import { dbForTenant } from './tenant-db.js';
import { sendMail } from './mailer.js';
import { customDomainLostEmail, trialEndedEmail, trialEndingEmail } from './email-templates.js';
import { recordAudit } from './audit.js';
import { deprovisionTenant } from './provisioning.js';
import { appOriginForTenant, lookupTxt, pointsHere, verifyRecordName, verifyRecordValue } from './domains.js';
import { maintainExports } from './data-export.js';

/** Whether a tenant is a trial past its end (read-only) */
export function trialEnded(t: { status: string; trialEndsAt: Date | null }, now = new Date()): boolean {
  return t.status === 'TRIAL' && !!t.trialEndsAt && t.trialEndsAt <= now;
}

/** The organization's active administrators, to email */
export async function tenantAdmins(tenantId: string): Promise<{ email: string; name: string | null }[]> {
  const db = await dbForTenant(tenantId);
  return db.user.findMany({ where: { tenantId, userType: 'TENANT_ADMIN', status: 'ACTIVE' }, select: { email: true, name: true } });
}

async function emailAdmins(tenantId: string, mail: (to: string) => Parameters<typeof sendMail>[0]) {
  for (const admin of await tenantAdmins(tenantId)) await sendMail(mail(admin.email)).catch(() => {});
}

export interface LifecycleResult {
  reminded: string[];
  trialsEnded: string[];
  deleted: string[];
  failed: string[];
  signupsRemoved: number;
  exports: { resumed: number; removed: number };
  domains: { checked: number; unverified: string[] };
}

/** One pass over every tenant. Safe to run on several servers at once (each step claims its rows). */
export async function runTenantLifecycle(now = new Date()): Promise<LifecycleResult> {
  const result: LifecycleResult = { reminded: [], trialsEnded: [], deleted: [], failed: [], signupsRemoved: 0, exports: { resumed: 0, removed: 0 }, domains: { checked: 0, unverified: [] } };
  const ready = { status: 'TRIAL' as const, provisioningStatus: 'READY' as const };
  const select = { id: true, name: true, slug: true, trialEndsAt: true } as const;

  // Trials ending soon
  const soon = new Date(now.getTime() + config.trialReminderDays * 86_400_000);
  for (const t of await controlDb.tenant.findMany({ where: { ...ready, trialEndsAt: { gt: now, lte: soon }, trialReminderSentAt: null }, select })) {
    const claimed = await controlDb.tenant.updateMany({ where: { id: t.id, trialReminderSentAt: null }, data: { trialReminderSentAt: now } });
    if (!claimed.count) continue;
    const link = `${await appOriginForTenant(t.id)}/${t.slug}/login`;
    await emailAdmins(t.id, (to) => trialEndingEmail(to, t.name, t.trialEndsAt!, link)).catch(() => result.failed.push(t.slug));
    result.reminded.push(t.slug);
  }

  // Trials that have ended
  for (const t of await controlDb.tenant.findMany({ where: { ...ready, trialEndsAt: { lte: now }, trialEndedNotifiedAt: null }, select })) {
    const claimed = await controlDb.tenant.updateMany({ where: { id: t.id, trialEndedNotifiedAt: null }, data: { trialEndedNotifiedAt: now } });
    if (!claimed.count) continue;
    await recordAudit({ actor: { type: 'SYSTEM' } }, 'tenant.trial_ended', {
      tenantId: t.id, resource: { type: 'tenant', id: t.id, label: t.slug }, details: { name: t.name, endedAt: t.trialEndsAt },
    }).catch(() => {});
    const link = `${await appOriginForTenant(t.id)}/${t.slug}/login`;
    await emailAdmins(t.id, (to) => trialEndedEmail(to, t.name, link)).catch(() => result.failed.push(t.slug));
    result.trialsEnded.push(t.slug);
  }

  // Closed organizations whose time is up
  for (const t of await controlDb.tenant.findMany({ where: { status: 'SUSPENDED', closedAt: { not: null }, deleteAfter: { lte: now } }, select: { id: true, slug: true } })) {
    try {
      await deprovisionTenant(t.id);
      result.deleted.push(t.slug);
    } catch {
      result.failed.push(t.slug);
    }
  }

  // Sign-up requests nobody needs any more. A confirmed one keeps its
  // password hash until provisioning has used it (a retry may still need it).
  const removed = await controlDb.signupRequest.deleteMany({
    where: {
      OR: [
        { verifiedAt: null, expiresAt: { lt: now } },
        { verifiedAt: { lt: new Date(now.getTime() - 48 * 3_600_000) }, passwordHash: null },
      ],
    },
  });
  result.signupsRemoved = removed.count;
  result.exports = await maintainExports(now);
  result.domains = await recheckDomains(now);
  return result;
}

/**
 * Verified custom domains, checked again. One stays verified while it still
 * points here (CNAME to the target, or one of its addresses) or still has its
 * TXT record; a DNS outage changes nothing. One that has neither on two checks
 * in a row goes back to pending: emails, sign-in and single sign-on stop using
 * an address that may now belong to someone else, and its admins are told.
 */
export async function recheckDomains(now = new Date()): Promise<{ checked: number; unverified: string[] }> {
  const out = { checked: 0, unverified: [] as string[] };
  if (!config.customDomains || config.domainRecheckHours <= 0) return out;
  const due = new Date(now.getTime() - config.domainRecheckHours * 3_600_000);
  const tenants = await controlDb.tenant.findMany({
    where: { customDomainStatus: 'VERIFIED', customDomain: { not: null }, OR: [{ customDomainCheckedAt: null }, { customDomainCheckedAt: { lte: due } }] },
    select: { id: true, name: true, slug: true, customDomain: true, customDomainToken: true, customDomainFailures: true },
  });
  for (const t of tenants) {
    const domain = t.customDomain!;
    let ok: boolean;
    try {
      ok = (await lookupTxt(verifyRecordName(domain))).includes(verifyRecordValue(t.customDomainToken ?? '')) || (await pointsHere(domain));
    } catch {
      // DNS couldn't be asked: try again next time, without counting it
      await controlDb.tenant.update({ where: { id: t.id }, data: { customDomainCheckedAt: now } });
      continue;
    }
    out.checked++;
    if (ok) {
      await controlDb.tenant.update({ where: { id: t.id }, data: { customDomainCheckedAt: now, customDomainFailures: 0, customDomainError: null } });
      continue;
    }
    const failures = t.customDomainFailures + 1;
    const error = `${domain} no longer points to the platform, and its TXT record is gone.`;
    if (failures < 2) {
      await controlDb.tenant.update({ where: { id: t.id }, data: { customDomainCheckedAt: now, customDomainFailures: failures, customDomainError: error } });
      continue;
    }
    // Only if nothing changed it meanwhile (an admin removing or re-adding it)
    const moved = await controlDb.tenant.updateMany({
      where: { id: t.id, customDomain: domain, customDomainStatus: 'VERIFIED' },
      data: { customDomainStatus: 'PENDING', customDomainVerifiedAt: null, customDomainCheckedAt: now, customDomainFailures: failures, customDomainError: error },
    });
    if (!moved.count) continue;
    out.unverified.push(domain);
    await recordAudit({ actor: { type: 'SYSTEM' }, tenantId: t.id }, 'custom_domain.unverified', {
      resource: { type: 'custom_domain', label: domain }, details: { reason: error },
    }).catch(() => {});
    const link = `${await appOriginForTenant(t.id)}/settings`;
    await emailAdmins(t.id, (to) => customDomainLostEmail(to, t.name, domain, link)).catch(() => {});
  }
  return out;
}

/** runTenantLifecycle on one server at a time */
export async function runTenantLifecycleOnce(): Promise<LifecycleResult | null> {
  const c = new pg.Client({ connectionString: config.databaseUrl });
  await c.connect();
  try {
    if (!(await c.query("SELECT pg_try_advisory_lock(hashtext('tenant-lifecycle')) AS ok")).rows[0].ok) return null;
    try {
      return await runTenantLifecycle();
    } finally {
      await c.query("SELECT pg_advisory_unlock(hashtext('tenant-lifecycle'))").catch(() => {});
    }
  } finally {
    await c.end().catch(() => {});
  }
}

let timer: NodeJS.Timeout | undefined;

export function startTenantLifecycle(log: (msg: string, err?: unknown) => void) {
  if (timer || config.tenantLifecycleIntervalMs <= 0) return;
  const run = () =>
    runTenantLifecycleOnce()
      .then((r) => r?.failed.forEach((slug) => log(`Tenant lifecycle step failed for ${slug}`)))
      .catch((err) => log('Tenant lifecycle check failed', err));
  setTimeout(run, 30_000).unref();
  timer = setInterval(run, config.tenantLifecycleIntervalMs);
  timer.unref();
}

export function stopTenantLifecycle() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
