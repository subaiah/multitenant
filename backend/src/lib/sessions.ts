import type { FastifyRequest } from 'fastify';
import { controlDb } from './prisma.js';
import { dbForTenant, type TenantDb } from './tenant-db.js';
import { AppError } from '../middleware/error-handler.js';
import { USER_TYPE_HIERARCHY } from '../utils/authorization.js';

/**
 * End every session a user has: refresh tokens are revoked (no new access
 * tokens) and access tokens already issued stop working on their next
 * request (authenticate compares their `iat` with sessionsValidAfter).
 *
 * Returns Prisma operations so callers can run them inside their own
 * transaction: `prisma.$transaction([...update, ...endAllSessions(id)])`.
 */
export function endAllSessions(db: TenantDb, userId: string, at = new Date()) {
  return [
    db.user.update({ where: { id: userId }, data: { sessionsValidAfter: at } }),
    db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: at } }),
  ];
}

/** endAllSessions for a platform user (control plane). */
export function endAllPlatformSessions(userId: string, at = new Date()) {
  return [
    controlDb.platformUser.update({ where: { id: userId }, data: { sessionsValidAfter: at } }),
    controlDb.platformRefreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: at } }),
  ];
}

/**
 * The account behind a token: a tenant user (token carries tenantId) in that
 * tenant's database, or a platform user in the control plane.
 */
export async function findSessionAccount(token: { userId: string; tenantId?: string }) {
  const select = { id: true, status: true, userType: true, sessionsValidAfter: true } as const;
  if (token.tenantId) {
    const user = await dbForTenant(token.tenantId).user.findFirst({ where: { id: token.userId, tenantId: token.tenantId }, select });
    return user ? { ...user, tenantId: token.tenantId as string | null } : null;
  }
  const user = await controlDb.platformUser.findUnique({ where: { id: token.userId }, select });
  return user ? { ...user, tenantId: null as string | null } : null;
}

export type SessionUser = { id: string; status: string; userType: string; tenantId: string | null };

/** Why a verified token can't be used any more, or null if it's fine. */
export function sessionProblem(
  token: { userId?: string; userType?: string; tenantId?: string; iat?: number; iatMs?: number },
  user: (SessionUser & { sessionsValidAfter: Date | null }) | null,
): string | null {
  if (!user) return 'Account not found';
  if (user.status !== 'ACTIVE') return 'Your account is not active';
  if ((token.tenantId ?? null) !== user.tenantId) return 'Session is no longer valid';
  // iatMs is stamped at signing (server.ts); older tokens only have whole-second iat,
  // which is treated as the start of that second (so they err towards being refused)
  const issuedAt = token.iatMs ?? (token.iat ?? 0) * 1000;
  if (user.sessionsValidAfter && issuedAt < user.sessionsValidAfter.getTime()) {
    return 'Your session has ended. Please sign in again.';
  }
  if (!(user.userType in USER_TYPE_HIERARCHY)) return 'Session is no longer valid';
  return null;
}

/**
 * Verify the access token (cookie or Authorization header) and check the
 * account is still allowed in: active, same tenant, not signed out
 * everywhere since the token was issued. The user type is taken from the
 * database, so a demotion applies on the next request rather than when the
 * token expires. Throws 401 otherwise.
 */
export async function verifySession(request: FastifyRequest): Promise<SessionUser> {
  try {
    await request.jwtVerify();
  } catch {
    throw new AppError('Not authenticated', 401);
  }
  const token = request.user as { userId?: string; userType?: string; tenantId?: string; iat?: number; iatMs?: number; type?: string };
  if (!token.userId) throw new AppError('Not authenticated', 401);
  const user = await findSessionAccount({ userId: token.userId, tenantId: token.tenantId });
  const problem = sessionProblem(token, user);
  if (problem) throw new AppError(problem, 401);
  request.user.userType = user!.userType as typeof request.user.userType;
  return user!;
}
