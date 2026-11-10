/**
 * User events for external products (docs/PRODUCT_INTEGRATION.md): telling a
 * product when people in an organization that has it are added, changed,
 * deactivated, reactivated or removed, or when the product's permissions
 * they hold change (everywhere, or in part of the organization), so it can
 * revoke access without waiting for them to sign in again; also when they
 * join or leave the organization's own organizations and units, and when
 * those change (units.changed: read them again). docs/hub/HUB_GAPS.md G7.
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
import { getEnhancedUserPermissions, type EnhancedPermissionData } from '../utils/authorization.js';
import { applicationAccess, scopedKey, type ScopedPermission } from './application-access.js';
import { memberOf } from './product-data.js';
import { config } from '../config/env.js';

export const USER_EVENTS = ['user.added', 'user.updated', 'user.deactivated', 'user.reactivated', 'user.removed', 'user.permissions_changed', 'user.units_changed', 'units.changed'] as const;
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

interface Person { id: string; email: string; name: string | null; userType: string; status: string; orgMemberships: { organizationId: string | null; orgUnitId: string | null }[] }

type MemberOf = ReturnType<typeof memberOf>;
const unitKeys = (m: MemberOf) => [...m.organizations.map((id) => `ORGANIZATION:${id}`), ...m.units.map((id) => `ORG_UNIT:${id}`)].sort();
const fromUnitKeys = (keys: string[]): MemberOf => ({
  organizations: keys.filter((k) => k.startsWith('ORGANIZATION:')).map((k) => k.slice(13)),
  units: keys.filter((k) => k.startsWith('ORG_UNIT:')).map((k) => k.slice(9)),
});
const fromScopedKey = (k: string): ScopedPermission => {
  const at = k.lastIndexOf('@');
  const colon = k.indexOf(':', at);
  return { permission: k.slice(0, at), scopeType: k.slice(at + 1, colon) as ScopedPermission['scopeType'], scopeId: k.slice(colon + 1) };
};
const minus = (a: string[], b: string[]) => { const s = new Set(b); return a.filter((x) => !s.has(x)); };

/** A hash of the organization's own organizations and units: when it changes, listening products are told units.changed */
async function unitsHash(db: Awaited<ReturnType<typeof dbForTenant>>, tenantId: string) {
  const [orgs, units] = await Promise.all([
    db.organization.findMany({ where: { tenantId }, select: { id: true, name: true, status: true }, orderBy: { id: 'asc' } }),
    db.orgUnit.findMany({ where: { tenantId }, select: { id: true, organizationId: true, parentUnitId: true, unitType: true, name: true }, orderBy: { id: 'asc' } }),
  ]);
  return { hash: keyedHash(JSON.stringify([orgs, units])), organizations: orgs.length, units: units.length };
}

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
    select: { id: true, email: true, name: true, userType: true, status: true, orgMemberships: { select: { organizationId: true, orgUnitId: true } } },
  });
  // Everything each active person holds, worked out once for all products
  const held = new Map<string, Pick<EnhancedPermissionData, 'permissions' | 'scoped'>>();
  for (const p of people) {
    if (p.status === 'ACTIVE') held.set(p.id, await getEnhancedUserPermissions(p.id, tenantId, p.userType));
  }
  const structure = await unitsHash(db, tenantId);

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

      // The organization's own organizations and units changed: re-read them (GET .../org-units)
      const entitlement = await tx.tenantApplication.findUnique({ where: { tenantId_applicationId: { tenantId, applicationId: product.id } }, select: { unitsStateHash: true } });
      if (entitlement && entitlement.unitsStateHash !== structure.hash) {
        if (entitlement.unitsStateHash !== null) await send('units.changed', { organizations: structure.organizations, units: structure.units });
        await tx.tenantApplication.update({ where: { tenantId_applicationId: { tenantId, applicationId: product.id } }, data: { unitsStateHash: structure.hash } });
      }

      for (const p of people) {
        const access = p.status === 'ACTIVE' ? applicationAccess(held.get(p.id)!, names) : { permissions: [], scopedPermissions: [] };
        const { permissions, scopedPermissions } = access;
        const member = memberOf(p.orgMemberships);
        const state = {
          status: p.status, userType: p.userType, emailHash: keyedHash(p.email.toLowerCase()), nameHash: keyedHash(p.name ?? ''), permissions,
          scopedPermissions: scopedPermissions.map(scopedKey), units: unitKeys(member), unitsRecorded: true,
        };
        const user = { id: p.id, subject: accountIdFor(tenantId, p.id), email: p.email, name: p.name ?? p.email, userType: p.userType, status: p.status };
        const old = before.get(p.id);
        before.delete(p.id);
        if (!old) {
          await send('user.added', { user, permissions, scopedPermissions, memberOf: member });
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
            await send('user.reactivated', { user, permissions, scopedPermissions, memberOf: member });
          } else {
            if (statusChanged) changes.push('status');
            if (changes.length) await send('user.updated', { user, changes });
            const added = minus(permissions, old.permissions);
            const removed = minus(old.permissions, permissions);
            // Rows from before scoped permissions and units were tracked: record those silently
            const scopedAdded = old.unitsRecorded ? minus(state.scopedPermissions, old.scopedPermissions) : [];
            const scopedRemoved = old.unitsRecorded ? minus(old.scopedPermissions, state.scopedPermissions) : [];
            if (added.length || removed.length || scopedAdded.length || scopedRemoved.length) {
              await send('user.permissions_changed', {
                user, permissions, added, removed,
                scopedPermissions, scopedAdded: scopedAdded.map(fromScopedKey), scopedRemoved: scopedRemoved.map(fromScopedKey),
              });
            }
            const unitsAdded = old.unitsRecorded ? minus(state.units, old.units) : [];
            const unitsRemoved = old.unitsRecorded ? minus(old.units, state.units) : [];
            if (unitsAdded.length || unitsRemoved.length) {
              await send('user.units_changed', { user, memberOf: member, added: fromUnitKeys(unitsAdded), removed: fromUnitKeys(unitsRemoved) });
            }
          }
          const same = (a: string[], b: string[]) => a.join(' ') === b.join(' ');
          if (!changes.length && !statusChanged && old.unitsRecorded && same(old.permissions, permissions) && same(old.scopedPermissions, state.scopedPermissions) && same(old.units, state.units)) continue;
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
  // The organization's own organizations and units (G7): who is in them, and the tree itself
  if (e === 'organization.member_added' || e === 'organization.member_removed' || e === 'org_unit.member_added' || e === 'org_unit.member_removed') return id(d.userId);
  if (['organization.created', 'organization.updated', 'organization.deleted', 'org_unit.created', 'org_unit.updated', 'org_unit.deleted'].includes(e)) return null;
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
