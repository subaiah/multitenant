import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { dbForTenant } from '../lib/tenant-db.js';
import { logActivity } from '../lib/activity.js';
import { endAllPlatformSessions, endAllSessions } from '../lib/sessions.js';
import { config } from '../config/env.js';
import { AppError } from '../middleware/error-handler.js';
import { sendMail } from '../lib/mailer.js';
import { passwordResetEmail } from '../lib/email-templates.js';
import { RESET_TTL_MINUTES, consumeUserToken, findValidUserToken, issueUserToken, type ValidUserToken } from '../lib/user-tokens.js';
import { otpRequestRateLimit } from '../lib/rate-limits.js';
import { PLATFORM_SLUG, isPlatformSlug } from '../lib/platform.js';
import { checkPasswordPolicy, hashPassword, type PasswordPolicy } from '../utils/auth.js';

/**
 * Public account flows (no session): accepting invitations and resetting
 * passwords. Tokens arrive by email and are single-use.
 */
const acceptSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(1).max(200),
  name: z.string().min(2).max(100).optional(),
});
const forgotSchema = z.object({ email: z.string().email(), tenantSlug: z.string().min(1) });
const resetSchema = z.object({ token: z.string().min(10), password: z.string().min(1).max(200) });

const PLATFORM_POLICY: PasswordPolicy = 'STRONG';
const GENERIC_FORGOT = 'If an account exists for this email, we have sent a link to reset the password.';

const policyFor = (t: ValidUserToken): PasswordPolicy => (t.tenant ? (t.tenant.passwordPolicy as PasswordPolicy) : PLATFORM_POLICY);
const slugFor = (t: ValidUserToken) => t.tenant?.slug ?? PLATFORM_SLUG;

export const accountRoutes: FastifyPluginAsync = async (fastify) => {
  // What the accept-invitation page shows
  fastify.get('/invitations/:token', {
    schema: { tags: ['account'], summary: 'Look up an invitation', params: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } },
  }, async (request) => {
    const { token } = request.params as { token: string };
    const invite = await findValidUserToken(token, 'INVITE');
    if (!invite || invite.user.status !== 'PENDING') {
      throw new AppError('This invitation is invalid or has expired. Ask your administrator to send a new one.', 404);
    }
    return {
      email: invite.user.email,
      name: invite.user.name,
      tenant: invite.tenant ? { name: invite.tenant.name, slug: invite.tenant.slug } : null,
      passwordPolicy: policyFor(invite),
    };
  });

  fastify.post('/invitations/accept', {
    schema: {
      tags: ['account'],
      summary: 'Accept an invitation and set a password',
      body: {
        type: 'object',
        required: ['token', 'password'],
        properties: { token: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { token, password, name } = acceptSchema.parse(request.body);
    const invite = await findValidUserToken(token, 'INVITE');
    if (!invite || invite.user.status !== 'PENDING') {
      throw new AppError('This invitation is invalid or has expired. Ask your administrator to send a new one.', 404);
    }
    const problem = checkPasswordPolicy(password, policyFor(invite));
    if (problem) throw new AppError(problem, 400);
    if (!(await consumeUserToken(invite))) {
      throw new AppError('This invitation has already been used.', 409);
    }

    const data = { passwordHash: await hashPassword(password), status: 'ACTIVE' as const, ...(name && { name }) };
    if (invite.tenant) {
      await (await dbForTenant(invite.tenant.id)).user.update({ where: { id: invite.userId }, data });
      await logActivity({ tenantId: invite.tenant.id, userId: invite.userId, action: 'accepted invitation', target: invite.user.email, type: 'USER' });
    } else {
      await controlDb.platformUser.update({ where: { id: invite.userId }, data });
    }
    return { message: 'Your account is ready. Sign in with your new password.', tenantSlug: slugFor(invite), email: invite.user.email };
  });

  // Always answers the same way, so it can't be used to discover accounts
  fastify.post('/password/forgot', {
    config: { rateLimit: otpRequestRateLimit('forgot-password') },
    schema: {
      tags: ['account'],
      summary: 'Email a password reset link',
      body: { type: 'object', required: ['email', 'tenantSlug'], properties: { email: { type: 'string' }, tenantSlug: { type: 'string' } } },
    },
  }, async (request) => {
    const { email, tenantSlug } = forgotSchema.parse(request.body);
    const platform = isPlatformSlug(tenantSlug);
    const tenant = platform ? null : await controlDb.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!platform && (!tenant || tenant.status === 'SUSPENDED' || tenant.provisioningStatus !== 'READY')) return { message: GENERIC_FORGOT };

    const user = tenant
      ? await (await dbForTenant(tenant.id)).user.findFirst({ where: { tenantId: tenant.id, email } })
      : await controlDb.platformUser.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE') return { message: GENERIC_FORGOT };

    const owner = tenant ? { tenantId: tenant.id, tenantSlug: tenant.slug } : ('platform' as const);
    const token = await issueUserToken(owner, user.id, 'PASSWORD_RESET', RESET_TTL_MINUTES * 60 * 1000);
    const link = `${config.frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await sendMail(passwordResetEmail(user.email, link, tenant?.name ?? 'Platform Administration', RESET_TTL_MINUTES));
    return { message: GENERIC_FORGOT };
  });

  fastify.get('/password/reset/:token', {
    schema: { tags: ['account'], summary: 'Check a password reset link', params: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } },
  }, async (request) => {
    const { token } = request.params as { token: string };
    const reset = await findValidUserToken(token, 'PASSWORD_RESET');
    if (!reset) throw new AppError('This reset link is invalid or has expired. Request a new one.', 404);
    return { email: reset.user.email, tenantSlug: slugFor(reset), passwordPolicy: policyFor(reset) };
  });

  fastify.post('/password/reset', {
    schema: {
      tags: ['account'],
      summary: 'Set a new password with a reset link',
      body: { type: 'object', required: ['token', 'password'], properties: { token: { type: 'string' }, password: { type: 'string' } } },
    },
  }, async (request) => {
    const { token, password } = resetSchema.parse(request.body);
    const reset = await findValidUserToken(token, 'PASSWORD_RESET');
    if (!reset || reset.user.status !== 'ACTIVE') {
      throw new AppError('This reset link is invalid or has expired. Request a new one.', 404);
    }
    const problem = checkPasswordPolicy(password, policyFor(reset));
    if (problem) throw new AppError(problem, 400);
    if (!(await consumeUserToken(reset))) {
      throw new AppError('This reset link has already been used.', 409);
    }

    const passwordHash = await hashPassword(password);
    if (reset.tenant) {
      const db = await dbForTenant(reset.tenant.id);
      await db.$transaction([
        db.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
        ...endAllSessions(db, reset.userId),
      ]);
      await logActivity({ tenantId: reset.tenant.id, userId: reset.userId, action: 'reset password', target: reset.user.email, type: 'AUTH' });
    } else {
      await controlDb.$transaction([
        controlDb.platformUser.update({ where: { id: reset.userId }, data: { passwordHash } }),
        ...endAllPlatformSessions(reset.userId),
      ]);
    }
    return { message: 'Your password has been changed. Sign in with your new password.', tenantSlug: slugFor(reset), email: reset.user.email };
  });
};
