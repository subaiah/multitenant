/**
 * Sessions and the steps of signing in, for both planes (tenant users in the
 * tenant's database, platform users in the control plane).
 *
 * Session rules (per tenant in Authentication settings; platform users from
 * PLATFORM_SESSION_* settings):
 * - Idle timeout: signed out after this many minutes without a request.
 *   Requests keep the session alive (lastSeenAt, updated at most once a
 *   minute); access tokens never outlive the idle timeout, and a refresh is
 *   refused once the session has been idle too long.
 * - Maximum session length: sign in again after this many hours however
 *   active, counted from sign-in across every token rotation.
 *
 * Two-factor (lib/mfa.ts): after the password or emailed code is accepted, a
 * user with an authenticator gets a short-lived "MFA token" instead of a
 * session, and trades it plus a code for the session. If the tenant requires
 * two-factor and the user has none yet, the MFA token lets them enroll first.
 * Single sign-on skips this: the identity provider does its own.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config/env.js';
import { controlDb } from './prisma.js';
import { dbForTenant } from './tenant-db.js';
import { decryptSecret, secretContext } from './secrets.js';
import { issueRefreshToken, type SessionOwner, type StoredRefreshToken } from './auth-planes.js';
import { AppError } from '../middleware/error-handler.js';
import { logActivity } from './activity.js';
import { useRecoveryCode, verifyTotp } from './mfa.js';

export function parseExpiryToMs(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error('Invalid expiry format');
  const value = parseInt(match[1]);
  return value * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd'];
}

// ---------------------------------------------------------------------------
// Session rules
// ---------------------------------------------------------------------------

export interface SessionPolicy {
  idleMs: number;
  maxMs: number;
}

export async function sessionPolicy(owner: SessionOwner): Promise<SessionPolicy> {
  if (owner === 'platform') {
    return { idleMs: config.platformSessionIdleMinutes * 60_000, maxMs: config.platformSessionMaxHours * 3_600_000 };
  }
  const auth = await (await dbForTenant(owner.tenantId)).authConfig.findUnique({
    where: { tenantId: owner.tenantId },
    select: { sessionTimeout: true, maxSessionHours: true },
  });
  return { idleMs: (auth?.sessionTimeout ?? 60) * 60_000, maxMs: (auth?.maxSessionHours ?? 12) * 3_600_000 };
}

const cookieOptions = () => ({ httpOnly: true, secure: config.nodeEnv === 'production', sameSite: 'lax' as const, path: '/' });

/**
 * Start a session (or continue one on refresh, passing `carry`): an access
 * token and a refresh token, both httpOnly cookies. Neither outlives the
 * session's rules.
 */
export async function startSession(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  owner: SessionOwner,
  user: { id: string; userType: string },
  carry?: { familyId: string; sessionStartedAt: Date },
) {
  const policy = await sessionPolicy(owner);
  const startedAt = carry?.sessionStartedAt ?? new Date();
  const sessionEndsInMs = startedAt.getTime() + policy.maxMs - Date.now();
  const accessMs = Math.max(1000, Math.min(parseExpiryToMs(config.accessTokenExpiry), policy.idleMs, sessionEndsInMs));
  const refreshMs = Math.max(1000, Math.min(parseExpiryToMs(config.refreshTokenExpiry), sessionEndsInMs));
  const familyId = carry?.familyId ?? crypto.randomBytes(32).toString('hex');

  const accessToken = fastify.jwt.sign(
    { userId: user.id, tenantId: owner === 'platform' ? undefined : owner.tenantId, userType: user.userType as never, type: 'access', sid: familyId },
    { expiresIn: Math.floor(accessMs / 1000) },
  );
  const refreshToken = await issueRefreshToken(
    owner,
    user.id,
    new Date(Date.now() + refreshMs),
    { userAgent: request.headers['user-agent'], ipAddress: request.ip },
    familyId,
    startedAt,
  );
  reply.setCookie('access_token', accessToken, { ...cookieOptions(), maxAge: Math.floor(accessMs / 1000) });
  reply.setCookie('refresh_token', refreshToken, { ...cookieOptions(), maxAge: Math.floor(refreshMs / 1000) });
}

/** Throws (401, with a code the sign-in page explains) if a stored session may not be refreshed. */
export async function assertRefreshAllowed(stored: StoredRefreshToken): Promise<void> {
  const policy = await sessionPolicy(stored.owner);
  const now = Date.now();
  if (now - stored.sessionStartedAt.getTime() > policy.maxMs) {
    throw new AppError('Your session reached its maximum length. Please sign in again.', 401, true, 'SESSION_MAX');
  }
  if (now - stored.lastSeenAt.getTime() > policy.idleMs) {
    throw new AppError('You were signed out after a period of inactivity. Please sign in again.', 401, true, 'SESSION_IDLE');
  }
}

const lastTouched = new Map<string, number>();

/** Record activity on a session, at most once a minute per session. */
export async function touchSession(token: { sid?: string; userId?: string; tenantId?: string }): Promise<void> {
  if (!token.sid || !token.userId) return;
  const now = Date.now();
  if ((lastTouched.get(token.sid) ?? 0) > now - 60_000) return;
  lastTouched.set(token.sid, now);
  if (lastTouched.size > 50_000) lastTouched.clear();
  const where = { familyId: token.sid, userId: token.userId, revokedAt: null };
  const data = { lastSeenAt: new Date(now) };
  if (token.tenantId) {
    await (await dbForTenant(token.tenantId)).refreshToken.updateMany({ where: { ...where, tenantId: token.tenantId }, data });
  } else {
    await controlDb.platformRefreshToken.updateMany({ where, data });
  }
}

// ---------------------------------------------------------------------------
// Two-factor
// ---------------------------------------------------------------------------

export interface MfaState {
  email: string;
  enabled: boolean;
  secret: string | null;
  lastStep: number | null;
  recoveryHashes: string[];
}

export async function mfaRequired(owner: SessionOwner): Promise<boolean> {
  if (owner === 'platform') return config.platformMfaRequired;
  const auth = await (await dbForTenant(owner.tenantId)).authConfig.findUnique({ where: { tenantId: owner.tenantId }, select: { mfaEnabled: true } });
  return Boolean(auth?.mfaEnabled);
}

export async function getMfaState(owner: SessionOwner, userId: string): Promise<MfaState | null> {
  if (owner === 'platform') {
    const u = await controlDb.platformUser.findUnique({ where: { id: userId } });
    if (!u) return null;
    return {
      email: u.email,
      enabled: Boolean(u.mfaEnabledAt && u.platformTotpSecret),
      secret: u.platformTotpSecret ? decryptSecret(u.platformTotpSecret, secretContext('platformTotpSecret')) : null,
      lastStep: u.mfaLastStep,
      recoveryHashes: u.mfaRecoveryCodes,
    };
  }
  const u = await (await dbForTenant(owner.tenantId)).user.findFirst({ where: { id: userId, tenantId: owner.tenantId } });
  if (!u) return null;
  return {
    email: u.email,
    enabled: Boolean(u.mfaEnabledAt && u.totpSecret),
    secret: u.totpSecret ? decryptSecret(u.totpSecret, secretContext('totpSecret')) : null,
    lastStep: u.mfaLastStep,
    recoveryHashes: u.mfaRecoveryCodes,
  };
}

export async function saveMfaState(
  owner: SessionOwner,
  userId: string,
  change: { secret?: string | null; enabledAt?: Date | null; lastStep?: number | null; recoveryHashes?: string[] },
): Promise<void> {
  const common = {
    ...(change.enabledAt !== undefined && { mfaEnabledAt: change.enabledAt }),
    ...(change.lastStep !== undefined && { mfaLastStep: change.lastStep }),
    ...(change.recoveryHashes !== undefined && { mfaRecoveryCodes: change.recoveryHashes }),
  };
  if (owner === 'platform') {
    await controlDb.platformUser.update({
      where: { id: userId },
      data: { ...common, ...(change.secret !== undefined && { platformTotpSecret: change.secret }) },
    });
  } else {
    await (await dbForTenant(owner.tenantId)).user.updateMany({
      where: { id: userId, tenantId: owner.tenantId },
      data: { ...common, ...(change.secret !== undefined && { totpSecret: change.secret }) },
    });
  }
}

// A separate key from session tokens, so an MFA token can never pass as one
const mfaKey = () => crypto.createHash('sha256').update(`${config.jwtSecret}:mfa-challenge`).digest();

export interface MfaClaims {
  userId: string;
  userType: string;
  tenantId?: string;
  tenantSlug?: string;
  /** verify: has an authenticator; enroll: must set one up first */
  step: 'verify' | 'enroll';
  /** During enrollment: the new secret, until a code from it is confirmed */
  pendingSecret?: string;
}

export async function signMfaToken(claims: MfaClaims, minutes = 10): Promise<string> {
  return new SignJWT({ ...claims, purpose: 'mfa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${minutes}m`)
    .sign(mfaKey());
}

export async function readMfaToken(token: string): Promise<MfaClaims> {
  try {
    const { payload } = await jwtVerify(token, mfaKey(), { algorithms: ['HS256'] });
    if (payload.purpose !== 'mfa') throw new Error('wrong purpose');
    return payload as unknown as MfaClaims;
  } catch {
    throw new AppError('This sign-in has expired. Please start again.', 401, true, 'MFA_EXPIRED');
  }
}

export const ownerOf = (claims: { tenantId?: string; tenantSlug?: string }): SessionOwner =>
  claims.tenantId && claims.tenantSlug ? { tenantId: claims.tenantId, tenantSlug: claims.tenantSlug } : 'platform';

export type SignInResult = { mfa: 'verify' | 'enroll'; mfaToken: string } | null;

/**
 * The last step of a password or emailed-code sign-in: start the session, or
 * (two-factor) hand back an MFA token for the next step instead.
 */
export async function completeSignIn(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  owner: SessionOwner,
  user: { id: string; userType: string },
): Promise<SignInResult> {
  const state = await getMfaState(owner, user.id);
  const base = {
    userId: user.id,
    userType: user.userType,
    ...(owner !== 'platform' && { tenantId: owner.tenantId, tenantSlug: owner.tenantSlug }),
  };
  if (state?.enabled) return { mfa: 'verify', mfaToken: await signMfaToken({ ...base, step: 'verify' }) };
  if (await mfaRequired(owner)) return { mfa: 'enroll', mfaToken: await signMfaToken({ ...base, step: 'enroll' }) };
  await startSession(fastify, request, reply, owner, user);
  return null;
}

/** After every step of a sign-in succeeded: record it. */
export async function recordSignIn(owner: SessionOwner, userId: string, how: string) {
  if (owner === 'platform') {
    await controlDb.platformUser.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  } else {
    await (await dbForTenant(owner.tenantId)).user.updateMany({ where: { id: userId, tenantId: owner.tenantId }, data: { lastLoginAt: new Date() } });
  }
  await logActivity({ tenantId: owner === 'platform' ? null : owner.tenantId, userId, action: how, target: 'system', type: 'AUTH' });
}

/** The signed-in user as the sign-in endpoints return it. */
export async function signedInUser(owner: SessionOwner, userId: string) {
  const select = { id: true, email: true, name: true, userType: true } as const;
  if (owner === 'platform') {
    const user = await controlDb.platformUser.findUniqueOrThrow({ where: { id: userId }, select });
    return { user: { ...user, portal: 'PLATFORM' as const }, tenant: null };
  }
  const [user, tenant] = await Promise.all([
    (await dbForTenant(owner.tenantId)).user.findFirstOrThrow({ where: { id: userId, tenantId: owner.tenantId }, select }),
    controlDb.tenant.findUniqueOrThrow({ where: { id: owner.tenantId }, select: { id: true, name: true, slug: true } }),
  ]);
  return { user: { ...user, portal: 'TENANT' as const }, tenant };
}

/**
 * Check a two-factor code (authenticator or recovery code) and use it up, so
 * it can't be used again, even by two requests at the same moment: the
 * update only applies while the step / recovery code is still unused.
 */
export async function consumeMfaCode(
  owner: SessionOwner,
  userId: string,
  state: MfaState,
  code: string,
): Promise<'totp' | 'recovery' | null> {
  if (!state.secret) return null;
  const step = verifyTotp(state.secret, code, state.lastStep);
  if (step !== null) {
    const stepFree = { OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] };
    const res = owner === 'platform'
      ? await controlDb.platformUser.updateMany({ where: { id: userId, ...stepFree }, data: { mfaLastStep: step } })
      : await (await dbForTenant(owner.tenantId)).user.updateMany({ where: { id: userId, tenantId: owner.tenantId, ...stepFree }, data: { mfaLastStep: step } });
    return res.count === 1 ? 'totp' : null;
  }
  const remaining = useRecoveryCode(state.recoveryHashes, code);
  if (!remaining) return null;
  const used = state.recoveryHashes.find((h) => !remaining.includes(h))!;
  const res = owner === 'platform'
    ? await controlDb.platformUser.updateMany({ where: { id: userId, mfaRecoveryCodes: { has: used } }, data: { mfaRecoveryCodes: remaining } })
    : await (await dbForTenant(owner.tenantId)).user.updateMany({ where: { id: userId, tenantId: owner.tenantId, mfaRecoveryCodes: { has: used } }, data: { mfaRecoveryCodes: remaining } });
  return res.count === 1 ? 'recovery' : null;
}
