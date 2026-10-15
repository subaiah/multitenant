/**
 * Two-factor sign-in (lib/mfa.ts, lib/sign-in.ts).
 *
 * mfaRoutes (/bff/auth/mfa, no session yet): the step after a correct
 * password or emailed code. The previous step returned an MFA token; it is
 * exchanged here, with a code, for a session.
 *   POST /verify          { mfaToken, code }  authenticator or recovery code
 *   POST /enroll/start    { mfaToken }        when two-factor is required and not set up
 *   POST /enroll/confirm  { enrollToken, code }
 *
 * Managing your own two-factor once signed in: routes/two-factor.ts.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { RateLimitOptions } from '@fastify/rate-limit';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import type { SessionOwner } from '../lib/auth-planes.js';
import { AppError } from '../middleware/error-handler.js';
import { newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp } from '../lib/mfa.js';
import {
  consumeMfaCode, getMfaState, ownerOf, readMfaToken, recordSignIn, saveMfaState, signMfaToken,
  signedInUser, startSession, type MfaClaims,
} from '../lib/sign-in.js';
import { logActivity } from '../lib/activity.js';

export const codeSchema = z.string().trim().min(6).max(20);

/** Who an MFA token is for, read without verifying: only used to key the rate limit. */
function tokenSubject(token: unknown): string {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString());
    return `${payload.tenantId ?? 'platform'}:${payload.userId ?? ''}`;
  } catch {
    return 'invalid';
  }
}

/** Codes are 6 digits: keep guesses per account very low, however many MFA tokens are fetched. */
export const mfaRateLimit = (route: string): RateLimitOptions => ({
  max: 5,
  timeWindow: '15 minutes',
  hook: 'preHandler',
  keyGenerator: (request: FastifyRequest) => {
    const body = (request.body ?? {}) as { mfaToken?: unknown; enrollToken?: unknown };
    return `mfa:${route}:${tokenSubject(body.mfaToken ?? body.enrollToken)}`;
  },
});

async function issuerFor(owner: SessionOwner): Promise<string> {
  if (owner === 'platform') return 'Platform';
  const tenant = await controlDb.tenant.findUnique({ where: { id: owner.tenantId }, select: { name: true } });
  return tenant?.name ?? owner.tenantSlug;
}

/** A new secret for `claims`' user, and a token that carries it until a code from it is confirmed. */
export async function enrollment(claims: Omit<MfaClaims, 'step' | 'pendingSecret'>, email: string) {
  const secret = newTotpSecret();
  const issuer = await issuerFor(ownerOf(claims));
  return {
    secret,
    otpauthUrl: otpauthUrl(secret, email, issuer),
    enrollToken: await signMfaToken({ ...claims, step: 'enroll', pendingSecret: secret }, 15),
  };
}

/** Save a confirmed authenticator: the secret, a fresh set of recovery codes (returned once). */
export async function finishEnrollment(owner: SessionOwner, userId: string, secret: string, code: string) {
  const step = verifyTotp(secret, code, null);
  if (step === null) throw new AppError('That code is not right. Check the time on your device and try again.', 400, true, 'MFA_INVALID');
  const { codes, hashes } = newRecoveryCodes();
  await saveMfaState(owner, userId, { secret, enabledAt: new Date(), lastStep: step, recoveryHashes: hashes });
  return codes;
}

export const mfaRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/verify', {
    config: { rateLimit: mfaRateLimit('verify') },
    schema: { tags: ['bff-auth'], summary: 'Finish signing in with a two-factor code' },
  }, async (request, reply) => {
    const body = z.object({ mfaToken: z.string(), code: codeSchema }).parse(request.body);
    const claims = await readMfaToken(body.mfaToken);
    if (claims.step !== 'verify') throw new AppError('This sign-in has expired. Please start again.', 401, true, 'MFA_EXPIRED');
    const owner = ownerOf(claims);
    const state = await getMfaState(owner, claims.userId);
    if (!state?.enabled) throw new AppError('This sign-in has expired. Please start again.', 401, true, 'MFA_EXPIRED');

    const used = await consumeMfaCode(owner, claims.userId, state, body.code);
    if (!used) {
      await logActivity({ tenantId: owner === 'platform' ? null : owner.tenantId, userId: claims.userId, action: 'two-factor code rejected', target: 'system', type: 'AUTH' });
      throw new AppError('That code is not right', 401, true, 'MFA_INVALID');
    }
    await startSession(fastify, request, reply, owner, { id: claims.userId, userType: claims.userType });
    await recordSignIn(owner, claims.userId, used === 'recovery' ? 'logged in with a recovery code' : 'logged in with two-factor');
    const remaining = used === 'recovery' ? state.recoveryHashes.length - 1 : undefined;
    return { message: 'Login successful', ...(await signedInUser(owner, claims.userId)), recoveryCodesLeft: remaining };
  });

  fastify.post('/enroll/start', {
    config: { rateLimit: mfaRateLimit('enroll-start') },
    schema: { tags: ['bff-auth'], summary: 'Set up an authenticator app while signing in' },
  }, async (request) => {
    const body = z.object({ mfaToken: z.string() }).parse(request.body);
    const claims = await readMfaToken(body.mfaToken);
    if (claims.step !== 'enroll') throw new AppError('This sign-in has expired. Please start again.', 401, true, 'MFA_EXPIRED');
    const state = await getMfaState(ownerOf(claims), claims.userId);
    if (!state || state.enabled) throw new AppError('This sign-in has expired. Please start again.', 401, true, 'MFA_EXPIRED');
    const { pendingSecret: _p, step: _s, ...base } = claims;
    return enrollment(base, state.email);
  });

  fastify.post('/enroll/confirm', {
    config: { rateLimit: mfaRateLimit('enroll-confirm') },
    schema: { tags: ['bff-auth'], summary: 'Confirm the authenticator app and sign in' },
  }, async (request, reply) => {
    const body = z.object({ enrollToken: z.string(), code: codeSchema }).parse(request.body);
    const claims = await readMfaToken(body.enrollToken);
    if (claims.step !== 'enroll' || !claims.pendingSecret) throw new AppError('This sign-in has expired. Please start again.', 401, true, 'MFA_EXPIRED');
    const owner = ownerOf(claims);
    const state = await getMfaState(owner, claims.userId);
    // Already set up (e.g. in another tab): sign in with a code instead
    if (!state || state.enabled) throw new AppError('This sign-in has expired. Please start again.', 401, true, 'MFA_EXPIRED');

    const recoveryCodes = await finishEnrollment(owner, claims.userId, claims.pendingSecret, body.code);
    await logActivity({ tenantId: owner === 'platform' ? null : owner.tenantId, userId: claims.userId, action: 'set up two-factor', target: 'system', type: 'AUTH' });
    await startSession(fastify, request, reply, owner, { id: claims.userId, userType: claims.userType });
    await recordSignIn(owner, claims.userId, 'logged in with two-factor');
    return { message: 'Login successful', ...(await signedInUser(owner, claims.userId)), recoveryCodes };
  });
};
