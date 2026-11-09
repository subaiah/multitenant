/**
 * What an external product may read through API v1 as itself
 * (routes/product-v1.ts; docs/PRODUCT_INTEGRATION.md): the organizations that
 * have it, their people and groups, and its own lifecycle events.
 *
 * - A product only sees organizations with an entitlement to it, in any
 *   state, so it can reconcile what it was told by events. Everything is
 *   decided from the current entitlements on each call, never from the token.
 * - People and groups are readable only while the organization has the
 *   product turned on (ENABLED or TRIAL, within its dates) and its data
 *   exists, whether or not the product has finished setting it up: setup
 *   usually needs them.
 * - For each person, only this product's own permissions are given (the ones
 *   it declares that the person holds), as in the `permissions` claim at
 *   sign-in (lib/oidc/accounts.ts).
 */
import type { Prisma } from '../generated/control/client.js';
import { controlDb } from './prisma.js';
import { dbForTenant } from './tenant-db.js';
import { accountIdFor } from './oidc/accounts.js';
import { getEnhancedUserPermissions } from '../utils/authorization.js';
import { permissionMatches } from '../utils/permissions.js';
import { AppError } from '../middleware/error-handler.js';

const ACTIVE_STATES = ['ENABLED', 'TRIAL'];

type EntitlementRow = Prisma.TenantApplicationGetPayload<{ include: { tenant: { select: { id: true; slug: true; name: true; status: true; provisioningStatus: true } } } }>;

const entitlementInclude = { tenant: { select: { id: true, slug: true, name: true, status: true, provisioningStatus: true } } } as const;

const isActiveNow = (e: Pick<EntitlementRow, 'state' | 'validFrom' | 'validTo'>, now = new Date()) =>
  ACTIVE_STATES.includes(e.state) && e.validFrom <= now && (!e.validTo || e.validTo > now);

/** An organization as a product sees it */
function organizationView(e: EntitlementRow, now = new Date()) {
  const active = isActiveNow(e, now);
  const suspended = e.tenant.status === 'SUSPENDED';
  const setupDone = e.provisioningStatus === 'READY' || e.provisioningStatus === 'NOT_REQUIRED';
  return {
    id: e.tenant.id,
    slug: e.tenant.slug,
    name: e.tenant.name,
    suspended,
    entitlement: { state: e.state, validFrom: e.validFrom.toISOString(), validTo: e.validTo?.toISOString() ?? null, active },
    setup: {
      status: e.provisioningStatus,
      error: e.provisioningError,
      completedAt: e.provisionedAt?.toISOString() ?? null,
      operation: e.provisioningOperationId ? { id: e.provisioningOperationId, generation: e.provisioningGeneration } : null,
    },
    /** Whether its people can sign in to the product now */
    available: active && !suspended && setupDone && e.tenant.provisioningStatus === 'READY',
    createdAt: e.createdAt.toISOString(),
  };
}

export type OrganizationFilter = { active?: boolean; setupStatus?: string; search?: string };

/** The organizations with an entitlement to the product, oldest entitlement first */
export async function listProductOrganizations(applicationId: string, filter: OrganizationFilter, page: { skip: number; limit: number }) {
  const now = new Date();
  const activeWhere: Prisma.TenantApplicationWhereInput = { state: { in: ACTIVE_STATES }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] };
  const where: Prisma.TenantApplicationWhereInput = {
    applicationId,
    ...(filter.setupStatus && { provisioningStatus: filter.setupStatus as EntitlementRow['provisioningStatus'] }),
    ...(filter.search && { tenant: { OR: [{ name: { contains: filter.search, mode: 'insensitive' } }, { slug: { contains: filter.search, mode: 'insensitive' } }] } }),
    ...(filter.active === true && activeWhere),
    ...(filter.active === false && { NOT: activeWhere }),
  };
  const [rows, total] = await Promise.all([
    controlDb.tenantApplication.findMany({ where, include: entitlementInclude, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: page.skip, take: page.limit }),
    controlDb.tenantApplication.count({ where }),
  ]);
  return { organizations: rows.map((r) => organizationView(r, now)), total };
}

async function entitlementOf(applicationId: string, tenantId: string) {
  // Not a UUID: not found (and no database error)
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) return null;
  return controlDb.tenantApplication.findUnique({ where: { tenantId_applicationId: { tenantId, applicationId } }, include: entitlementInclude });
}

/** One organization; 404 unless it has an entitlement to the product */
export async function getProductOrganization(applicationId: string, tenantId: string) {
  const e = await entitlementOf(applicationId, tenantId);
  if (!e) throw new AppError('No organization with that id has this product', 404, true, 'NOT_FOUND');
  return organizationView(e);
}

/** The organization's data, if the product may read its people now */
export async function readableOrganization(applicationId: string, tenantId: string) {
  const e = await entitlementOf(applicationId, tenantId);
  if (!e) throw new AppError('No organization with that id has this product', 404, true, 'NOT_FOUND');
  if (!isActiveNow(e)) throw new AppError('This organization doesn’t have the product turned on now', 403, true, 'NOT_ENTITLED');
  if (e.tenant.provisioningStatus !== 'READY') throw new AppError('This organization is still being created', 409, true, 'ORGANIZATION_NOT_READY');
  const cfg = await controlDb.databaseConfig.findUnique({ where: { tenantId }, select: { updatedAt: true } });
  return dbForTenant(tenantId, cfg?.updatedAt);
}

const now = () => new Date();
const inForce = () => ({ validFrom: { lte: now() }, OR: [{ validTo: null }, { validTo: { gt: now() } }] });

export type MemberFilter = { status?: 'ACTIVE' | 'INACTIVE' | 'PENDING'; groupId?: string; updatedSince?: Date; search?: string };

/** Run fn over items, a few at a time */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/** The organization's people, oldest first, with their groups, roles and this product's permissions */
export async function listProductMembers(applicationId: string, tenantId: string, filter: MemberFilter, page: { skip: number; limit: number }) {
  const db = await readableOrganization(applicationId, tenantId);
  const where = {
    tenantId,
    ...(filter.status && { status: filter.status }),
    ...(filter.updatedSince && { updatedAt: { gte: filter.updatedSince } }),
    ...(filter.groupId && { groupMemberships: { some: { groupId: filter.groupId, ...inForce() } } }),
    ...(filter.search && { OR: [{ email: { contains: filter.search, mode: 'insensitive' as const } }, { name: { contains: filter.search, mode: 'insensitive' as const } }] }),
  };
  const [users, total, declared] = await Promise.all([
    db.user.findMany({
      where,
      select: {
        id: true, email: true, name: true, userType: true, status: true, lastLoginAt: true, createdAt: true, updatedAt: true,
        groupMemberships: { where: { ...inForce(), group: { status: 'ACTIVE' } }, select: { group: { select: { id: true, name: true } } }, orderBy: { group: { name: 'asc' } } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: page.skip,
      take: page.limit,
    }),
    db.user.count({ where }),
    controlDb.permission.findMany({ where: { applicationId }, select: { name: true }, orderBy: { name: 'asc' } }),
  ]);
  // Sorted here, not by the database, so the order doesn't depend on its collation
  const names = declared.map((p) => p.name).sort();
  const members = await mapLimited(users, 8, async (u) => {
    // Only people who can sign in hold anything
    let roles: string[] = [];
    let permissions: string[] = [];
    if (u.status === 'ACTIVE') {
      const data = await getEnhancedUserPermissions(u.id, tenantId, u.userType);
      roles = [...new Set([...data.sources.directRoles, ...data.sources.groupRoles])].sort();
      permissions = names.filter((p) => permissionMatches(data.permissions, p));
    }
    return {
      id: u.id,
      subject: accountIdFor(tenantId, u.id),
      email: u.email,
      name: u.name ?? u.email,
      userType: u.userType,
      status: u.status,
      groups: u.groupMemberships.map((m) => m.group),
      roles,
      permissions,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
      updatedAt: u.updatedAt.toISOString(),
    };
  });
  return { members, total };
}

/** The organization's groups, by name, with how many people are in each now */
export async function listProductGroups(applicationId: string, tenantId: string, filter: { status?: 'ACTIVE' | 'INACTIVE' }, page: { skip: number; limit: number }) {
  const db = await readableOrganization(applicationId, tenantId);
  const where = { tenantId, ...(filter.status && { status: filter.status }) };
  const [groups, total] = await Promise.all([
    db.group.findMany({
      where,
      select: { id: true, name: true, description: true, status: true, createdAt: true, updatedAt: true, _count: { select: { members: { where: inForce() } } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: page.skip,
      take: page.limit,
    }),
    db.group.count({ where }),
  ]);
  return {
    groups: groups.map((g) => ({
      id: g.id, name: g.name, description: g.description, status: g.status, memberCount: g._count.members,
      createdAt: g.createdAt.toISOString(), updatedAt: g.updatedAt.toISOString(),
    })),
    total,
  };
}

export type EventFilter = { after?: number; organizationId?: string; type?: string };

/**
 * The product's lifecycle events, oldest first, from a cursor (the previous
 * page's nextAfter). The cursor is an opaque position: only compare it with
 * itself.
 */
export async function listProductEvents(applicationId: string, filter: EventFilter, limit: number) {
  const rows = await controlDb.productEvent.findMany({
    where: {
      applicationId,
      ...(filter.after !== undefined && { seq: { gt: filter.after } }),
      ...(filter.organizationId && { tenantId: filter.organizationId }),
      ...(filter.type && { type: filter.type }),
    },
    orderBy: { seq: 'asc' },
    take: limit + 1,
  });
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    data: page.map((e) => ({
      id: e.publicId,
      type: e.type,
      organizationId: e.tenantId,
      operation: e.operationId ? { id: e.operationId, generation: e.generation } : null,
      delivery: {
        status: e.status,
        attempts: e.attempts,
        lastStatus: e.lastStatus,
        lastError: e.lastError,
        deliveredAt: e.deliveredAt?.toISOString() ?? null,
      },
      createdAt: e.createdAt.toISOString(),
      /** The event exactly as it was (or will be) sent */
      payload: e.payload,
    })),
    // Where to continue from, also on the last page (poll with it for new events)
    nextAfter: page.length ? page[page.length - 1].seq : (filter.after ?? 0),
    hasMore: more,
  };
}
