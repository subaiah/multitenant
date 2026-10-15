/**
 * Managing your own two-factor sign-in (/bff/two-factor, signed in), and the
 * admin reset used by the Users pages. The sign-in steps are in routes/mfa.ts.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SessionOwner } from '../lib/auth-planes.js';
import { AppError } from '../middleware/error-handler.js';
import { AUTHENTICATED } from '../middleware/authorize.js';
import { newRecoveryCodes } from '../lib/mfa.js';
import { consumeMfaCode, getMfaState, mfaRequired, readMfaToken, saveMfaState } from '../lib/sign-in.js';
import { logActivity } from '../lib/activity.js';
import { codeSchema, enrollment, finishEnrollment, mfaRateLimit } from './mfa.js';

/** The signed-in caller as a session owner. */
function ownerOfRequest(request: FastifyRequest): SessionOwner {
  const { tenantId } = request.user;
  return tenantId && request.tenant ? { tenantId, tenantSlug: request.tenant.slug } : 'platform';
}

const claimsOfRequest = (request: FastifyRequest) => {
  const owner = ownerOfRequest(request);
  return {
    userId: request.user.userId,
    userType: request.user.userType,
    ...(owner !== 'platform' && { tenantId: owner.tenantId, tenantSlug: owner.tenantSlug }),
  };
};

export const twoFactorRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', { config: { permission: AUTHENTICATED } }, async (request) => {
    const owner = ownerOfRequest(request);
    const state = await getMfaState(owner, request.user.userId);
    if (!state) throw new AppError('Account not found', 404);
    return {
      enabled: state.enabled,
      required: await mfaRequired(owner),
      recoveryCodesLeft: state.enabled ? state.recoveryHashes.length : 0,
    };
  });

  fastify.post('/enroll/start', { config: { permission: AUTHENTICATED } }, async (request) => {
    const owner = ownerOfRequest(request);
    const state = await getMfaState(owner, request.user.userId);
    if (!state) throw new AppError('Account not found', 404);
    if (state.enabled) throw new AppError('Two-factor is already set up. Turn it off first to use a new device.', 409);
    return enrollment(claimsOfRequest(request), state.email);
  });

  fastify.post('/enroll/confirm', {
    config: { permission: AUTHENTICATED, rateLimit: mfaRateLimit('settings-confirm') },
  }, async (request) => {
    const body = z.object({ enrollToken: z.string(), code: codeSchema }).parse(request.body);
    const claims = await readMfaToken(body.enrollToken);
    const owner = ownerOfRequest(request);
    if (claims.userId !== request.user.userId || claims.tenantId !== (owner === 'platform' ? undefined : owner.tenantId) || !claims.pendingSecret) {
      throw new AppError('This setup has expired. Please start again.', 400, true, 'MFA_EXPIRED');
    }
    const state = await getMfaState(owner, request.user.userId);
    if (!state || state.enabled) throw new AppError('Two-factor is already set up', 409);
    const recoveryCodes = await finishEnrollment(owner, request.user.userId, claims.pendingSecret, body.code);
    await logActivity({ tenantId: owner === 'platform' ? null : owner.tenantId, userId: request.user.userId, action: 'set up two-factor', target: 'system', type: 'AUTH' });
    return { enabled: true, recoveryCodes };
  });

  /** Turning it off, and new recovery codes, both need a current code. */
  async function checkCode(request: FastifyRequest) {
    const body = z.object({ code: codeSchema }).parse(request.body);
    const owner = ownerOfRequest(request);
    const state = await getMfaState(owner, request.user.userId);
    if (!state?.enabled) throw new AppError('Two-factor is not set up', 409);
    if (!(await consumeMfaCode(owner, request.user.userId, state, body.code))) {
      throw new AppError('That code is not right', 400, true, 'MFA_INVALID');
    }
    return owner;
  }

  fastify.post('/disable', {
    config: { permission: AUTHENTICATED, rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request) => {
    const owner = ownerOfRequest(request);
    if (await mfaRequired(owner)) {
      throw new AppError('Two-factor is required for your organization and cannot be turned off', 403);
    }
    await checkCode(request);
    await saveMfaState(owner, request.user.userId, { secret: null, enabledAt: null, lastStep: null, recoveryHashes: [] });
    await logActivity({ tenantId: owner === 'platform' ? null : owner.tenantId, userId: request.user.userId, action: 'turned off two-factor', target: 'system', type: 'AUTH' });
    return { enabled: false };
  });

  fastify.post('/recovery-codes', {
    config: { permission: AUTHENTICATED, rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request) => {
    const owner = await checkCode(request);
    const { codes, hashes } = newRecoveryCodes();
    await saveMfaState(owner, request.user.userId, { recoveryHashes: hashes });
    await logActivity({ tenantId: owner === 'platform' ? null : owner.tenantId, userId: request.user.userId, action: 'made new recovery codes', target: 'system', type: 'AUTH' });
    return { recoveryCodes: codes };
  });
};

/** Clear a user's two-factor so they set it up again at their next sign-in (admin reset). */
export async function resetTwoFactor(owner: SessionOwner, userId: string) {
  await saveMfaState(owner, userId, { secret: null, enabledAt: null, lastStep: null, recoveryHashes: [] });
}
