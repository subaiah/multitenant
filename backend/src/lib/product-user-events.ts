/**
 * User events for external products (docs/PRODUCT_INTEGRATION.md): telling a
 * product when people in an organization that has it are added, changed,
 * deactivated, reactivated or removed, or when the product's permissions
 * they hold change, so it can revoke access without waiting for them to sign
 * in again.
 *
 * - Only for products that ask for them (manifest provisioning.userEvents, or
 *   the Lifecycle events panel), with a callback address, and only for
 *   organizations that have the product turned on now.
 * - What changed is found by comparing each person with what the product was
 *   last told (product_member_states), not by interpreting each change: a
 *   role edited or deleted, a group deactivated, an assignment that expired
 *   all come out right. Email and name are kept as keyed hashes only.
 * - When: after any change to people, groups, roles or delegations in the
 *   organization's audit log (just that person when the entry names one,
 *   otherwise everyone), gathered for a moment so a burst is one pass; and
 *   every hour, which also catches what changes with time (expiring
 *   assignments and delegations).
 * - The first pass for an organization (just turned on, or user events just
 *   asked for) records everyone without sending anything: the product reads
 *   the members through API v1 when it sets the organization up.
 * - Sent like lifecycle events (lib/product-lifecycle.ts): the same outbox,
 *   signed, in order per product and organization.
 */
import { createHmac } from 'node:crypto';
import { controlDb } from './prisma.js';
import { dbForTenant } from './tenant-db.js';
import { onAudit, PLATFORM_CHAIN, type AuditContent } from './audit.js';
import { accountIdFor } from './oidc/accounts.js';
import { kickLifecycleEvents, queueProductEvent } from './product-lifecycle.js';
import { getEnhancedUserPermissions } from '../utils/authorization.js';
import { permissionMatches } from '../utils/permissions.js';
import { config } from '../config/env.js';

export const USER_EVENTS = ['user.added', 'user.updated', 'user.deactivated', 'user.reactivated', 'user.removed', 'user.permissions_changed'] as const;
export type UserEvent = (typeof USER_EVENTS)[number];

const ACTIVE_STATES = ['ENABLED', 'TRIAL'];
const keyedHash = (value: string) => createHmac('sha256', `product-member-state:${config.jwtSecret}`).update(value).digest('base64url');

let log: (msg: string, err?: unknown) => void = (msg, err) => console.error(msg, err);

/** The products that should hear about people in this organization now */
async function listeningProducts(tenantId: string) {
  const now = new Date();
  return controlDb.applicationRegistry.findMany({
    where: {
      userEvents: true,
      status: 'ACTIVE',
      provisioningCallbackUrl: { not: null },
      tenantApplications: { some: { tenantId, state: { in: ACTIVE_STATES }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] } },
    },
    select: { id: true, key: true, permissions: { select: { name: true } } },
  });
}

interface Person { id: string; email: string; name: string | null; userType: string; status: string }

/**
 * Compare people in an organization with what each listening product was
 * last told, queue the events, and record the new state. `userIds`: only
 * these people (null: everyone). Returns how many events were queued.
 */
export async function reconcileMembers(tenantId: string, userIds: string[] | null = null): Promise<number> {
  const products = await listeningProducts(tenantId);
  // Products no longer listening here forget what they were told (a fresh start if they listen again)
  await controlDb.productMemberState.deleteMany({ where: { tenantId, applicationId: { notIn: products.map((p) => p.id) } } });
  if (!products.length) return 0;

  const tenant = await controlDb.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, slug: true, name: true, status: true, provisioningStatus: true, databaseConfig: { select: { updatedAt: true } } },
  });
  if (!tenant || tenant.provisioningStatus !== 'READY') return 0;

  // A product with nothing recorded here yet starts with everyone, silently
  const recorded = new Set((await controlDb.productMemberState.groupBy({ by: ['applicationId'], where: { tenantId, applicationId: { in: products.map((p) => p.id) } } })).map((r) => r.applicationId));
  const scope = products.some((p) => !recorded.has(p.id)) ? null : userIds;

  const db = await dbForTenant(tenantId, tenant.databaseConfig?.updatedAt);
  const people: Person[] = await db.user.findMany({
    where: { tenantId, ...(scope && { id: { in: scope } }) },
    select: { id: true, email: true, name: true, userType: true, status: true },
  });
  // Everything each active person holds, worked out once for all products
  const held = new Map<string, string[]>();
  for (const p of people) {
    if (p.status === 'ACTIVE') held.set(p.id, (await getEnhancedUserPermissions(p.id, tenantId, p.userType)).permissions);
  }

  let queued = 0;
  for (const product of products) {
    const names = product.permissions.map((x) => x.name).sort();
    const silent = !recorded.has(product.id);
    queued += await controlDb.$transaction(async (tx) => {
      // One pass at a time per product and organization
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-state:${product.id}:${tenantId}`}))::text`;
      const before = new Map((await tx.productMemberState.findMany({
        where: { applicationId: product.id, tenantId, ...(scope && { userId: { in: scope } }) },
      })).map((s) => [s.userId, s]));
      const organization = { id: tenant.id, slug: tenant.slug, name: tenant.name, suspended: tenant.status === 'SUSPENDED' };
      let n = 0;
      const send = async (type: UserEvent, data: Record<string, unknown>) => {
        if (silent) return;
        await queueProductEvent(tx, { applicationId: product.id, applicationKey: product.key, tenantId, type, data: { organization, ...data } });
        n++;
      };

      for (const p of people) {
        const permissions = p.status === 'ACTIVE' ? names.filter((x) => permissionMatches(held.get(p.id) ?? [], x)) : [];
        const state = { status: p.status, userType: p.userType, emailHash: keyedHash(p.email.toLowerCase()), nameHash: keyedHash(p.name ?? ''), permissions };
        const user = { id: p.id, subject: accountIdFor(tenantId, p.id), email: p.email, name: p.name ?? p.email, userType: p.userType, status: p.status };
        const old = before.get(p.id);
        before.delete(p.id);
        if (!old) {
          await send('user.added', { user, permissions });
        } else {
          const changes = [
            old.emailHash !== state.emailHash && 'email',
            old.nameHash !== state.nameHash && 'name',
            old.userType !== state.userType && 'userType',
          ].filter((c): c is string => !!c);
          const statusChanged = old.status !== state.status;
          if (statusChanged && state.status === 'INACTIVE') {
            if (changes.length) await send('user.updated', { user, changes });
            await send('user.deactivated', { user });
          } else if (statusChanged && old.status === 'INACTIVE' && state.status === 'ACTIVE') {
            if (changes.length) await send('user.updated', { user, changes });
            await send('user.reactivated', { user, permissions });
          } else {
            if (statusChanged) changes.push('status');
            if (changes.length) await send('user.updated', { user, changes });
            const was = new Set(old.permissions);
            const added = permissions.filter((x) => !was.has(x));
            const removed = old.permissions.filter((x) => !permissions.includes(x));
            if (added.length || removed.length) await send('user.permissions_changed', { user, permissions, added, removed });
          }
          if (!changes.length && !statusChanged && old.permissions.join(' ') === permissions.join(' ')) continue;
        }
        await tx.productMemberState.upsert({
          where: { applicationId_tenantId_userId: { applicationId: product.id, tenantId, userId: p.id } },
          create: { applicationId: product.id, tenantId, userId: p.id, ...state },
          update: state,
        });
      }
      // Recorded but gone: removed
      for (const [userId] of before) {
        await send('user.removed', { user: { id: userId, subject: accountIdFor(tenantId, userId) } });
        await tx.productMemberState.delete({ where: { applicationId_tenantId_userId: { applicationId: product.id, tenantId, userId } } });
      }
      return n;
    }, { timeout: 60_000 });
  }
  if (queued) kickLifecycleEvents();
  return queued;
}

// ---------------------------------------------------------------------------
// When to compare: after changes in the audit log, and every hour
// ---------------------------------------------------------------------------

const GATHER_MS = 300;
const pending = new Map<string, Set<string> | null>();
let gatherTimer: NodeJS.Timeout | undefined;
let running: Promise<void> | null = null;

/** Compare soon (people: these ids; null: everyone), gathering what comes in meanwhile */
export function scheduleReconcile(tenantId: string, userIds: string[] | null) {
  const current = pending.get(tenantId);
  if (userIds === null || current === null) pending.set(tenantId, null);
  else pending.set(tenantId, new Set([...(current ?? []), ...userIds]));
  if (!gatherTimer) {
    gatherTimer = setTimeout(() => void flushReconciles(), GATHER_MS);
    gatherTimer.unref?.();
  }
}

/** Run what's waiting now (and wait for a pass in progress) */
export async function flushReconciles(): Promise<void> {
  if (gatherTimer) clearTimeout(gatherTimer);
  gatherTimer = undefined;
  if (running) await running;
  const batch = [...pending.entries()];
  pending.clear();
  if (!batch.length) return;
  running = (async () => {
    for (const [tenantId, ids] of batch) {
      await reconcileMembers(tenantId, ids ? [...ids] : null).catch((err) => log(`Comparing people for products failed (${tenantId})`, err));
    }
  })();
  await running;
  running = null;
}

/** Which people an audit entry may have changed for products: ids, everyone (null), or nobody (undefined) */
export function affectedBy(entry: Pick<AuditContent, 'event' | 'outcome' | 'resourceType' | 'resourceId' | 'details'>): string[] | null | undefined {
  if (entry.outcome !== 'SUCCESS') return undefined;
  const d = (entry.details ?? {}) as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === 'string' && v ? [v] : null);
  const e = entry.event;
  if (e.startsWith('user.') || e === 'account.email_changed' || e === 'auth.invitation_accepted') return entry.resourceType === 'user' ? id(entry.resourceId) : null;
  if (e === 'group.member_added' || e === 'group.member_removed') return id(d.userId);
  if (e === 'role.assigned' || e === 'role.unassigned') return d.principalType === 'USER' ? id(d.principalId) : null;
  if (e === 'delegation.created' || e === 'delegation.revoked') return id(d.delegateId);
  if (e.startsWith('role.') || e.startsWith('group.') || e.startsWith('entitlement.')) return null;
  return undefined;
}

onAudit(({ chain, entry }) => {
  if (chain === PLATFORM_CHAIN) return;
  const people = affectedBy(entry);
  if (people !== undefined) scheduleReconcile(chain, people);
});

/**
 * After a product starts or stops asking for user events: record everyone in
 * its organizations now (silently), so the next change is told; or forget.
 */
export async function userEventsChanged(applicationId: string, before: boolean, after: boolean): Promise<void> {
  if (before === after) return;
  if (!after) {
    await controlDb.productMemberState.deleteMany({ where: { applicationId } });
    return;
  }
  const now = new Date();
  const rows = await controlDb.tenantApplication.findMany({
    where: { applicationId, state: { in: ACTIVE_STATES }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
    select: { tenantId: true },
  });
  for (const r of rows) scheduleReconcile(r.tenantId, null);
}

let sweepTimer: NodeJS.Timeout | undefined;
const SWEEP_MS = 60 * 60_000;

/** Every organization with a listening product, everyone (what changed with time) */
export async function sweepMembers(): Promise<number> {
  const now = new Date();
  const rows = await controlDb.tenantApplication.findMany({
    where: {
      state: { in: ACTIVE_STATES }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }],
      application: { userEvents: true, status: 'ACTIVE', provisioningCallbackUrl: { not: null } },
    },
    select: { tenantId: true },
    distinct: ['tenantId'],
  });
  // Also those that stopped listening, so their records go
  const stale = await controlDb.productMemberState.findMany({ select: { tenantId: true }, distinct: ['tenantId'] });
  const tenants = new Set([...rows.map((r) => r.tenantId), ...stale.map((r) => r.tenantId)]);
  let queued = 0;
  for (const t of tenants) queued += await reconcileMembers(t).catch((err) => (log(`Comparing people for products failed (${t})`, err), 0));
  return queued;
}

export function startUserEventSweep(logger: (msg: string, err?: unknown) => void) {
  log = logger;
  if (sweepTimer) return;
  sweepTimer = setInterval(() => void sweepMembers().catch((err) => log('Comparing people for products failed', err)), SWEEP_MS);
  sweepTimer.unref();
}
export function stopUserEventSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
}
