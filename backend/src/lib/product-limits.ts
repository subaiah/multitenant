/**
 * What each plan allows in an application (docs/hub/HUB_GAPS.md G6).
 *
 * - The application declares its limits in the manifest (v2 limits): an
 *   integer (a number, or null for no limit where the limit allows that) or
 *   a boolean, each with a default.
 * - Platform staff set a value per plan (Applications page); a plan without
 *   one gets the default.
 * - An organization's limits follow its plan. They're sent with
 *   organization.entitled and organization.entitlement_changed (data.limits),
 *   and readable on the organization (GET …/organizations/{id}).
 * - When they change (the organization changes plan, staff change a value,
 *   a new manifest), each organization that has the application on is sent
 *   organization.entitlement_changed with the new limits. What was last sent
 *   is kept as a hash on the entitlement, so nothing is sent twice and an
 *   hourly pass catches anything missed.
 * - The application enforces them; the platform only says what they are.
 */
import { createHash } from 'node:crypto';
import { controlDb } from './prisma.js';
import type { TenantPlan } from '../generated/control/client.js';

export type LimitValue = number | boolean | null;
type LimitTx = Pick<typeof controlDb, 'productLimit' | 'tenant'>;

const valueOf = (json: unknown): LimitValue => {
  const v = (json as { v?: unknown } | null)?.v;
  return typeof v === 'number' || typeof v === 'boolean' ? v : null;
};

/** An application's limits for a plan: { key: value } */
export async function limitsForPlan(tx: Pick<typeof controlDb, 'productLimit'>, applicationId: string, plan: TenantPlan): Promise<Record<string, LimitValue>> {
  const rows = await tx.productLimit.findMany({
    where: { applicationId, retiredAt: null },
    include: { planValues: { where: { planCode: plan } } },
    orderBy: { position: 'asc' },
  });
  return Object.fromEntries(rows.map((l) => [l.key, l.planValues[0] ? valueOf(l.planValues[0].value) : valueOf(l.defaultValue)]));
}

/** An organization's limits in an application (null: the organization doesn't exist) */
export async function limitsFor(tx: LimitTx, applicationId: string, tenantId: string): Promise<Record<string, LimitValue> | null> {
  const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  return t ? limitsForPlan(tx, applicationId, t.plan) : null;
}

export const limitsHash = (limits: Record<string, LimitValue>) => createHash('sha256').update(JSON.stringify(Object.entries(limits).sort(([a], [b]) => (a < b ? -1 : 1)))).digest('base64url');

let log: (msg: string, err?: unknown) => void = (msg, err) => console.error(msg, err);

/**
 * Tell organizations whose limits changed since they were last told (those
 * that have the application on): organization.entitlement_changed. Narrow it
 * to one organization or one application. Returns how many were told.
 */
export async function reconcileLimits(filter: { tenantId?: string; applicationId?: string } = {}): Promise<number> {
  const now = new Date();
  const rows = await controlDb.tenantApplication.findMany({
    where: {
      ...(filter.tenantId && { tenantId: filter.tenantId }),
      ...(filter.applicationId && { applicationId: filter.applicationId }),
      state: { in: ['ENABLED', 'TRIAL'] }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }],
      application: { status: 'ACTIVE', limits: { some: {} } },
    },
  });
  const { queueLifecycleEvent, kickLifecycleEvents } = await import('./product-lifecycle.js');
  let told = 0;
  for (const e of rows) {
    try {
      const sent = await controlDb.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`limits:${e.applicationId}:${e.tenantId}`}))::text`;
        const fresh = await tx.tenantApplication.findUnique({ where: { id: e.id } });
        if (!fresh) return false;
        const limits = await limitsFor(tx, e.applicationId, e.tenantId);
        if (!limits) return false;
        const hash = limitsHash(limits);
        if (fresh.limitsStateHash === hash) return false;
        // Told (if it has a callback), and recorded either way so it isn't worked out again
        const queued = await queueLifecycleEvent(tx, 'organization.entitlement_changed', fresh, { changed: ['limits'] });
        await tx.tenantApplication.update({ where: { id: e.id }, data: { limitsStateHash: hash } });
        return queued;
      });
      if (sent) told++;
    } catch (err) {
      log(`Telling ${e.applicationId} about ${e.tenantId}'s new limits failed`, err);
    }
  }
  if (told) kickLifecycleEvents();
  return told;
}

/** Soon, without holding up the request that changed something */
export function scheduleLimitsCheck(filter: { tenantId?: string; applicationId?: string }) {
  setImmediate(() => void reconcileLimits(filter).catch((err) => log('Checking limits failed', err)));
}

let timer: NodeJS.Timeout | undefined;
export function startLimitsSweep(logger: (msg: string, err?: unknown) => void) {
  log = logger;
  if (timer) return;
  timer = setInterval(() => void reconcileLimits().catch((err) => log('Checking limits failed', err)), 60 * 60_000);
  timer.unref();
}
export function stopLimitsSweep() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
