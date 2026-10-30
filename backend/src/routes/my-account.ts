/**
 * Your own sign-in details (/bff/my-account, signed in; tenant users and
 * platform staff alike): change your password, or your email address.
 *
 * An email change is confirmed from the NEW address (a link that works for
 * EMAIL_CHANGE_TTL_HOURS; routes/account.ts finishes it) and announced to the
 * old one, so a session someone else got hold of can't quietly move the
 * account to their address. Both need your current password.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SessionOwner } from '../lib/auth-planes.js';
import { AppError } from '../middleware/error-handler.js';
import { AUTHENTICATED } from '../middleware/authorize.js';
import { controlDb } from '../lib/prisma.js';
import { dbForTenant } from '../lib/tenant-db.js';
import { audit } from '../lib/audit.js';
import { logActivity } from '../lib/activity.js';
import { sendMail } from '../lib/mailer.js';
import { appOriginForTenant } from '../lib/domains.js';
import { emailChangeConfirmEmail, emailChangeRequestedEmail, passwordChangedEmail } from '../lib/email-templates.js';
import { EMAIL_CHANGE_TTL_HOURS, cancelUserTokens, issueUserToken, pendingEmailChange } from '../lib/user-tokens.js';
import { signedInCodeRateLimit } from '../lib/rate-limits.js';
import { checkPasswordPolicy, hashPassword, verifyPassword, type PasswordPolicy } from '../utils/auth.js';

const PLATFORM_POLICY: PasswordPolicy = 'STRONG';
const PLATFORM_LABEL = 'Platform Administration';

const ownerOfRequest = (request: FastifyRequest): SessionOwner =>
  request.user.tenantId && request.tenant ? { tenantId: request.user.tenantId, tenantSlug: request.tenant.slug } : 'platform';

/** The signed-in person's account, on whichever plane it lives */
async function accountOf(owner: SessionOwner, userId: string) {
  const select = { id: true, email: true, name: true, passwordHash: true } as const;
  const user = owner === 'platform'
    ? await controlDb.platformUser.findUnique({ where: { id: userId }, select })
    : await (await dbForTenant(owner.tenantId)).user.findFirst({ where: { id: userId, tenantId: owner.tenantId }, select });
  if (!user) throw new AppError('Account not found', 404);
  return user;
}

async function policyOf(owner: SessionOwner): Promise<PasswordPolicy> {
  if (owner === 'platform') return PLATFORM_POLICY;
  const cfg = await (await dbForTenant(owner.tenantId)).authConfig.findUnique({ where: { tenantId: owner.tenantId }, select: { passwordPolicy: true } });
  return (cfg?.passwordPolicy as PasswordPolicy | undefined) ?? 'STANDARD';
}

const labelOf = async (owner: SessionOwner) =>
  owner === 'platform' ? PLATFORM_LABEL : ((await controlDb.tenant.findUnique({ where: { id: owner.tenantId }, select: { name: true } }))?.name ?? 'your organization');

async function requirePassword(owner: SessionOwner, userId: string, password: string | undefined) {
  const user = await accountOf(owner, userId);
  if (!user.passwordHash) {
    throw new AppError('Your account signs in without a password (single sign-on or email codes). Ask an administrator to change your email.', 409, true, 'NO_PASSWORD');
  }
  if (!password || !(await verifyPassword(password, user.passwordHash))) {
    throw new AppError('That password is not right', 400, true, 'WRONG_PASSWORD');
  }
  return user;
}

/** Whether another account on the same plane already has this address */
export async function emailTaken(owner: SessionOwner, email: string, exceptUserId: string): Promise<boolean> {
  const other = owner === 'platform'
    ? await controlDb.platformUser.findUnique({ where: { email }, select: { id: true } })
    : await (await dbForTenant(owner.tenantId)).user.findFirst({ where: { tenantId: owner.tenantId, email }, select: { id: true } });
  return !!other && other.id !== exceptUserId;
}

/**
 * Start an email change: a link to the new address, a heads-up to the old.
 * Also used by administrators correcting someone's address (createdById).
 */
export async function requestEmailChange(owner: SessionOwner, user: { id: string; email: string }, newEmail: string, createdById?: string) {
  const token = await issueUserToken(owner, user.id, 'EMAIL_CHANGE', EMAIL_CHANGE_TTL_HOURS * 3_600_000, createdById, newEmail);
  const origin = await appOriginForTenant(owner === 'platform' ? undefined : owner.tenantId);
  const label = await labelOf(owner);
  await sendMail(emailChangeConfirmEmail(newEmail, `${origin}/confirm-email?token=${encodeURIComponent(token)}`, label, EMAIL_CHANGE_TTL_HOURS));
  await sendMail(emailChangeRequestedEmail(user.email, newEmail, label)).catch(() => {});
}

export const newEmailSchema = z.string().trim().toLowerCase().email().max(200);

export const myAccountRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    config: { permission: AUTHENTICATED },
    schema: { tags: ['my-account'], summary: 'Your sign-in details: email, whether you have a password, a pending email change' },
  }, async (request) => {
    const owner = ownerOfRequest(request);
    const user = await accountOf(owner, request.user.userId);
    return {
      email: user.email,
      hasPassword: !!user.passwordHash,
      passwordPolicy: await policyOf(owner),
      pendingEmail: await pendingEmailChange(owner, user.id),
    };
  });

  fastify.post('/password', {
    config: { permission: AUTHENTICATED, rateLimit: signedInCodeRateLimit('password-change') },
    schema: { tags: ['my-account'], summary: 'Change your password (signs out your other sessions)' },
  }, async (request) => {
    const { currentPassword, newPassword } = z.object({ currentPassword: z.string().max(200), newPassword: z.string().min(1).max(200) }).parse(request.body);
    const owner = ownerOfRequest(request);
    const user = await requirePassword(owner, request.user.userId, currentPassword);
    const problem = checkPasswordPolicy(newPassword, await policyOf(owner));
    if (problem) throw new AppError(problem, 400);
    if (await verifyPassword(newPassword, user.passwordHash!)) throw new AppError('Choose a password different from the current one', 400);

    const passwordHash = await hashPassword(newPassword);
    // Other sessions end (their refresh tokens are revoked; their short-lived
    // access tokens run out within minutes); this one carries on
    const others = { userId: user.id, revokedAt: null, NOT: { familyId: request.user.sid ?? '' } };
    if (owner === 'platform') {
      await controlDb.$transaction([
        controlDb.platformUser.update({ where: { id: user.id }, data: { passwordHash } }),
        controlDb.platformRefreshToken.updateMany({ where: others, data: { revokedAt: new Date() } }),
      ]);
    } else {
      const db = await dbForTenant(owner.tenantId);
      await db.$transaction([
        db.user.update({ where: { id: user.id }, data: { passwordHash } }),
        db.refreshToken.updateMany({ where: { ...others, tenantId: owner.tenantId }, data: { revokedAt: new Date() } }),
      ]);
    }
    await logActivity({ tenantId: owner === 'platform' ? null : owner.tenantId, userId: user.id, action: 'changed password', target: user.email, type: 'AUTH' });
    await audit(request, owner === 'platform' ? 'platform.account.password_changed' : 'account.password_changed');
    await sendMail(passwordChangedEmail(user.email, await labelOf(owner))).catch(() => {});
    return { changed: true };
  });

  fastify.post('/email', {
    config: { permission: AUTHENTICATED, rateLimit: signedInCodeRateLimit('email-change') },
    schema: { tags: ['my-account'], summary: 'Change your email: a confirmation link goes to the new address' },
  }, async (request) => {
    const body = z.object({ newEmail: newEmailSchema, password: z.string().max(200).optional() }).parse(request.body);
    const owner = ownerOfRequest(request);
    const user = await requirePassword(owner, request.user.userId, body.password);
    if (body.newEmail === user.email.toLowerCase()) throw new AppError('That is already your email address', 400);
    if (await emailTaken(owner, body.newEmail, user.id)) throw new AppError('Another account already uses that email address', 409, true, 'EMAIL_TAKEN');

    await requestEmailChange(owner, user, body.newEmail);
    await audit(request, owner === 'platform' ? 'platform.account.email_change_requested' : 'account.email_change_requested', { details: { from: user.email, to: body.newEmail } });
    return { pendingEmail: await pendingEmailChange(owner, user.id) };
  });

  fastify.delete('/email', {
    config: { permission: AUTHENTICATED },
    schema: { tags: ['my-account'], summary: 'Cancel a pending email change' },
  }, async (request) => {
    await cancelUserTokens(ownerOfRequest(request), request.user.userId, 'EMAIL_CHANGE');
    return { pendingEmail: null };
  });
};
