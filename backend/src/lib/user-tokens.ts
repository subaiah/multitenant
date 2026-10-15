import crypto from 'node:crypto';
import { controlDb } from './prisma.js';
import { dbForTenant } from './tenant-db.js';
import { PLATFORM_SLUG } from './platform.js';

/**
 * Single-use tokens sent by email (invitations, password resets).
 *
 * The raw token only ever exists in the emailed link; the database stores a
 * SHA-256 hash, so a database leak doesn't expose usable links. The token
 * starts with the tenant's slug (`acme.<random>`, or `platform.<random>`), so
 * the link can be routed to the right plane and tenant database without a
 * cross-tenant lookup.
 */
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export const INVITE_TTL_DAYS = 7;
export const RESET_TTL_MINUTES = 60;

export type UserTokenType = 'INVITE' | 'PASSWORD_RESET';
export type TokenOwner = { tenantId: string; tenantSlug: string } | 'platform';

/** Issue a new token, invalidating any earlier unused token of the same type for this user. */
export async function issueUserToken(owner: TokenOwner, userId: string, type: UserTokenType, ttlMs: number, createdById?: string): Promise<string> {
  const prefix = owner === 'platform' ? PLATFORM_SLUG : owner.tenantSlug;
  const token = `${prefix}.${crypto.randomBytes(32).toString('base64url')}`;
  const record = { userId, type, tokenHash: hash(token), expiresAt: new Date(Date.now() + ttlMs), createdById };
  if (owner === 'platform') {
    await controlDb.$transaction([
      controlDb.platformUserToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } }),
      controlDb.platformUserToken.create({ data: record }),
    ]);
  } else {
    const db = dbForTenant(owner.tenantId);
    await db.$transaction([
      db.userToken.updateMany({ where: { tenantId: owner.tenantId, userId, type, usedAt: null }, data: { usedAt: new Date() } }),
      db.userToken.create({ data: { ...record, tenantId: owner.tenantId } }),
    ]);
  }
  return token;
}

export interface ValidUserToken {
  id: string;
  userId: string;
  /** null for platform users */
  tenant: { id: string; name: string; slug: string; passwordPolicy: string } | null;
  user: { email: string; name: string | null; status: string };
}

/** Look up a valid (unused, unexpired) token without consuming it. */
export async function findValidUserToken(token: string, type: UserTokenType): Promise<ValidUserToken | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const slug = token.slice(0, dot);
  const where = { tokenHash: hash(token), type, usedAt: null, expiresAt: { gt: new Date() } };
  const userSelect = { email: true, name: true, status: true } as const;

  if (slug === PLATFORM_SLUG) {
    const t = await controlDb.platformUserToken.findFirst({ where, include: { user: { select: userSelect } } });
    return t ? { id: t.id, userId: t.userId, tenant: null, user: t.user } : null;
  }

  const tenant = await controlDb.tenant.findUnique({ where: { slug }, select: { id: true, name: true, slug: true, status: true } });
  if (!tenant || tenant.status === 'SUSPENDED') return null;
  const db = dbForTenant(tenant.id);
  const t = await db.userToken.findFirst({ where: { ...where, tenantId: tenant.id }, include: { user: { select: userSelect } } });
  if (!t) return null;
  const authConfig = await db.authConfig.findUnique({ where: { tenantId: tenant.id }, select: { passwordPolicy: true } });
  return {
    id: t.id,
    userId: t.userId,
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, passwordPolicy: authConfig?.passwordPolicy ?? 'STANDARD' },
    user: t.user,
  };
}

/** Mark a token used. Returns false if it was already used (e.g. a concurrent request won). */
export async function consumeUserToken(t: ValidUserToken): Promise<boolean> {
  const data = { usedAt: new Date() };
  const { count } = t.tenant
    ? await dbForTenant(t.tenant.id).userToken.updateMany({ where: { id: t.id, tenantId: t.tenant.id, usedAt: null }, data })
    : await controlDb.platformUserToken.updateMany({ where: { id: t.id, usedAt: null }, data });
  return count === 1;
}
