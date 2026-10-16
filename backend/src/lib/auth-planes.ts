/**
 * Sign-in across the two planes. Tenant users, their sign-in settings and
 * refresh tokens live in the tenant's database; platform users and theirs in
 * the control plane.
 *
 * Opaque values handed to the browser (refresh tokens, OAuth state) start
 * with the owner's slug (`acme.<random>`, `platform.<random>`), the same as
 * emailed tokens, so they can be routed to the right database without
 * searching every tenant.
 */
import crypto from 'node:crypto';
import { controlDb } from './prisma.js';
import { dbForTenant, type TenantDb } from './tenant-db.js';
import { PLATFORM_SLUG, isPlatformSlug } from './platform.js';
import { AppError } from '../middleware/error-handler.js';

export type ControlTenant = NonNullable<Awaited<ReturnType<typeof controlDb.tenant.findUnique>>>;

export interface TenantContext {
  tenant: ControlTenant;
  db: TenantDb;
}

/** The tenant for a sign-in slug, with its database. 404s unknown and 403s suspended tenants. */
export async function tenantForSignIn(slug: string): Promise<TenantContext> {
  const tenant = await controlDb.tenant.findUnique({ where: { slug } });
  if (!tenant) throw new AppError('Tenant not found', 404);
  if (tenant.status === 'SUSPENDED') throw new AppError('Tenant is suspended', 403);
  if (tenant.provisioningStatus !== 'READY') throw new AppError('This organization is still being set up. Try again in a moment.', 409);
  return { tenant, db: await dbForTenant(tenant.id) };
}

/** `<slug>.<random>` */
export function slugToken(slug: string, bytes = 48): string {
  return `${slug}.${crypto.randomBytes(bytes).toString('base64url')}`;
}

/** The slug a slugToken starts with, or null. */
export function tokenSlug(value: string): string | null {
  const dot = value.indexOf('.');
  return dot > 0 ? value.slice(0, dot) : null;
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

export type SessionOwner = { tenantId: string; tenantSlug: string } | 'platform';

export interface SessionMeta {
  userAgent?: string;
  ipAddress?: string;
}

/** Store a new refresh token and return its value (for the cookie). */
export async function issueRefreshToken(
  owner: SessionOwner,
  userId: string,
  expiresAt: Date,
  meta: SessionMeta,
  familyId: string = crypto.randomBytes(32).toString('hex'),
  /** When the session began (kept across rotations, for the maximum session length) */
  sessionStartedAt: Date = new Date(),
): Promise<string> {
  const token = slugToken(owner === 'platform' ? PLATFORM_SLUG : owner.tenantSlug);
  const data = {
    userId, token, familyId, expiresAt, userAgent: meta.userAgent, ipAddress: meta.ipAddress,
    sessionStartedAt, lastSeenAt: new Date(),
  };
  if (owner === 'platform') {
    await controlDb.platformRefreshToken.create({ data });
  } else {
    await (await dbForTenant(owner.tenantId)).refreshToken.create({ data: { ...data, tenantId: owner.tenantId } });
  }
  return token;
}

export interface StoredRefreshToken {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  sessionStartedAt: Date;
  lastSeenAt: Date;
  owner: SessionOwner;
  /** The account it belongs to, or null if it no longer exists */
  user: { id: string; userType: string; status: string } | null;
}

/** Look a refresh token up in the plane its prefix names. */
export async function findRefreshToken(value: string): Promise<StoredRefreshToken | null> {
  const slug = tokenSlug(value);
  if (!slug) return null;
  const userSelect = { id: true, userType: true, status: true } as const;

  if (isPlatformSlug(slug)) {
    const t = await controlDb.platformRefreshToken.findUnique({ where: { token: value } });
    if (!t) return null;
    const user = await controlDb.platformUser.findUnique({ where: { id: t.userId }, select: userSelect });
    return { ...pick(t), owner: 'platform', user };
  }

  const tenant = await controlDb.tenant.findUnique({ where: { slug }, select: { id: true, slug: true, status: true, provisioningStatus: true } });
  if (!tenant || tenant.status === 'SUSPENDED' || tenant.provisioningStatus !== 'READY') return null;
  const db = await dbForTenant(tenant.id);
  const t = await db.refreshToken.findFirst({ where: { token: value, tenantId: tenant.id } });
  if (!t) return null;
  const user = await db.user.findFirst({ where: { id: t.userId, tenantId: tenant.id }, select: userSelect });
  return { ...pick(t), owner: { tenantId: tenant.id, tenantSlug: tenant.slug }, user };
}

function pick(t: { id: string; userId: string; familyId: string; expiresAt: Date; revokedAt: Date | null; sessionStartedAt: Date; lastSeenAt: Date }) {
  return {
    id: t.id, userId: t.userId, familyId: t.familyId, expiresAt: t.expiresAt, revokedAt: t.revokedAt,
    sessionStartedAt: t.sessionStartedAt, lastSeenAt: t.lastSeenAt,
  };
}

/** Revoke one token (by row) or its whole family (reuse detected). */
export async function revokeRefreshToken(t: StoredRefreshToken, scope: 'token' | 'family' = 'token') {
  const where = scope === 'token' ? { id: t.id } : { familyId: t.familyId };
  const data = { revokedAt: new Date() };
  if (t.owner === 'platform') {
    await controlDb.platformRefreshToken.updateMany({ where, data });
  } else {
    await (await dbForTenant(t.owner.tenantId)).refreshToken.updateMany({ where: { ...where, tenantId: t.owner.tenantId }, data });
  }
}

/** Revoke a token by its cookie value, if it exists (sign-out). */
export async function revokeRefreshTokenValue(value: string) {
  const t = await findRefreshToken(value);
  if (t && !t.revokedAt) await revokeRefreshToken(t);
}

/** A user's active sessions (unrevoked, unexpired refresh tokens). */
export async function activeSessions(user: { id: string; tenantId: string | null }) {
  const where = { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } };
  const select = { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true } as const;
  const orderBy = { createdAt: 'desc' } as const;
  return user.tenantId
    ? (await dbForTenant(user.tenantId)).refreshToken.findMany({ where: { ...where, tenantId: user.tenantId }, select, orderBy })
    : controlDb.platformRefreshToken.findMany({ where, select, orderBy });
}
