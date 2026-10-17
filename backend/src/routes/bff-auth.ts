import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { dbForTenant } from '../lib/tenant-db.js';
import {
  activeSessions, findRefreshToken, revokeRefreshToken, revokeRefreshTokenValue, tenantForSignIn,
  type SessionOwner,
} from '../lib/auth-planes.js';
import { AppError } from '../middleware/error-handler.js';
import { loginRateLimit, otpRequestRateLimit, otpVerifyRateLimit } from '../lib/rate-limits.js';
import { config } from '../config/env.js';
import { sendMail } from '../lib/mailer.js';
import { otpEmail } from '../lib/email-templates.js';
import { verifyPassword } from '../utils/auth.js';
import { isPlatformSlug } from '../lib/platform.js';
import { endAllPlatformSessions, endAllSessions, verifySession } from '../lib/sessions.js';
import { assertRefreshAllowed, completeSignIn, recordSignIn, recordSignInFailure, startSession, type SignInResult } from '../lib/sign-in.js';
import { audit } from '../lib/audit.js';
import { mfaRoutes } from './mfa.js';
import { finishSso, SsoError, ssoRedirectUriFor, startSso, userForIdentity } from '../lib/sso.js';
import { appOriginFor, assertSignInHost } from '../lib/domains.js';
import { tokenSlug } from '../lib/auth-planes.js';
import { logActivity } from '../lib/activity.js';

// Validation schemas
const loginSchema = z.object({
  email: z.string().email(),
  tenantSlug: z.string(),
  password: z.string().min(1),
});

const otpRequestSchema = z.object({
  email: z.string().email(),
  tenantSlug: z.string(),
});

const otpVerifySchema = z.object({
  email: z.string().email(),
  tenantSlug: z.string(),
  code: z.string().length(6),
});

/** What a sign-in step returns when two-factor comes next (no session yet). */
const mfaNext = (r: NonNullable<SignInResult>) => ({
  message: r.mfa === 'verify' ? 'Enter the code from your authenticator app' : 'Set up two-factor sign-in to continue',
  mfa: r.mfa,
  mfaToken: r.mfaToken,
});

/** Back to the sign-in page with a message (SSO happens in full-page redirects, not API calls). */
function ssoErrorRedirect(appOrigin: string, slug: string, err: unknown): string {
  const code = err instanceof SsoError ? err.code : err instanceof AppError && err.code ? err.code : err instanceof AppError && err.statusCode === 404 ? 'SSO_UNAVAILABLE' : 'SSO_FAILED';
  const message = err instanceof SsoError || err instanceof AppError ? err.message : 'Single sign-on failed';
  const params = new URLSearchParams({ sso_error: code, message });
  return `${appOrigin}/${slug ? `${encodeURIComponent(slug)}/` : ''}login?${params}`;
}

const portalOf = (userType: string) => (userType.startsWith('PLATFORM_') ? 'PLATFORM' : 'TENANT');

export const bffAuthRoutes: FastifyPluginAsync = async (fastify) => {
  // Two-factor steps of signing in (/bff/auth/mfa/...)
  await fastify.register(mfaRoutes, { prefix: '/mfa' });

  // Login endpoint - sets httpOnly cookies
  fastify.post('/login', {
    config: { rateLimit: loginRateLimit('bff') },
    schema: {
      tags: ['bff-auth'],
      summary: 'Login and set secure cookies',
      body: {
        type: 'object',
        required: ['email', 'tenantSlug', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          tenantSlug: { type: 'string' },
          password: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { email, tenantSlug, password } = loginSchema.parse(request.body);
    await assertSignInHost(request, tenantSlug);

    // Platform users sign in on a platform slug and live in the control plane;
    // tenant users through their tenant's slug, in its database
    if (isPlatformSlug(tenantSlug)) {
      const user = await controlDb.platformUser.findUnique({ where: { email } });
      if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
        await recordSignInFailure(request, 'platform', { email, userId: user?.id, method: 'password', reason: user ? 'wrong password' : 'no such account' });
        throw new AppError('Invalid credentials', 401);
      }
      if (user.status !== 'ACTIVE') {
        await recordSignInFailure(request, 'platform', { email, userId: user.id, method: 'password', reason: 'account not active' });
        throw new AppError('User account is not active', 403);
      }
      const next = await completeSignIn(fastify, request, reply, 'platform', user);
      if (next) return mfaNext(next);
      await recordSignIn(request, 'platform', user.id, 'logged in via BFF', 'password');
      return {
        message: 'Login successful',
        user: { id: user.id, email: user.email, name: user.name, userType: user.userType, portal: 'PLATFORM' },
        tenant: null,
      };
    }

    const { tenant, db } = await tenantForSignIn(tenantSlug);
    const user = await db.user.findFirst({ where: { tenantId: tenant.id, email } });

    const owner = { tenantId: tenant.id, tenantSlug: tenant.slug };
    const refuse = (reason: string) => recordSignInFailure(request, owner, { email, userId: user?.id, method: 'password', reason });

    // Password is required. Verify it before revealing anything else about the account.
    if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      await refuse(user ? 'wrong password' : 'no such account');
      throw new AppError('Invalid credentials', 401);
    }
    const authConfig = await db.authConfig.findUnique({ where: { tenantId: tenant.id } });
    if (authConfig?.ssoOnly) {
      await refuse('single sign-on only');
      throw new AppError('SSO authentication required', 403);
    }
    if (user.status !== 'ACTIVE') {
      await refuse('account not active');
      throw new AppError('User account is not active', 403);
    }

    const next = await completeSignIn(fastify, request, reply, owner, user);
    if (next) return mfaNext(next);
    await recordSignIn(request, owner, user.id, 'logged in via BFF', 'password');

    return {
      message: 'Login successful',
      user: { id: user.id, email: user.email, name: user.name, userType: user.userType, portal: portalOf(user.userType) },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    };
  });

  // Request OTP endpoint
  fastify.post('/otp/request', {
    config: { rateLimit: otpRequestRateLimit('bff') },
    schema: {
      tags: ['bff-auth'],
      summary: 'Request OTP for passwordless login',
      body: {
        type: 'object',
        required: ['email', 'tenantSlug'],
        properties: {
          email: { type: 'string', format: 'email' },
          tenantSlug: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { email, tenantSlug } = otpRequestSchema.parse(request.body);
    await assertSignInHost(request, tenantSlug);

    if (isPlatformSlug(tenantSlug)) {
      throw new AppError('OTP authentication is not available for platform accounts', 400);
    }
    const { tenant, db } = await tenantForSignIn(tenantSlug);
    const authConfig = await db.authConfig.findUnique({ where: { tenantId: tenant.id } });

    // Check if OTP is enabled
    if (!authConfig?.otpEnabled) {
      throw new AppError('OTP authentication is not enabled for this tenant', 400);
    }

    // Find user
    const user = await db.user.findFirst({
      where: {
        tenantId: tenant.id,
        email,
      },
    });

    if (!user) {
      if (config.devExposeOtp) {
        throw new AppError('User not found', 404);
      }
      return { message: 'If an active account exists for this email, a sign-in code has been sent' };
    }

    // Only active accounts can sign in; answer the same way as for unknown emails
    if (user.status !== 'ACTIVE') {
      return { message: 'If an active account exists for this email, a sign-in code has been sent' };
    }

    // Delete any existing OTPs for this email
    await db.otpCode.deleteMany({
      where: {
        tenantId: tenant.id,
        email,
      },
    });

    // Generate OTP
    const { generateOtp, getOtpExpiration } = await import('../utils/auth.js');
    const code = generateOtp();
    const expiresAt = getOtpExpiration(authConfig.otpExpiry);

    // Store OTP
    await db.otpCode.create({
      data: {
        tenantId: tenant.id,
        email,
        code,
        expiresAt,
      },
    });

    await sendMail(otpEmail(email, code, tenant.name, authConfig.otpExpiry));

    // In development, return the OTP for testing
    if (config.devExposeOtp) {
      return {
        message: 'OTP generated successfully',
        otp: code,
        expiresAt,
      };
    }

    return {
      message: 'If an active account exists for this email, a sign-in code has been sent',
      expiresAt,
    };
  });

  // Verify OTP endpoint
  fastify.post('/otp/verify', {
    config: { rateLimit: otpVerifyRateLimit('bff') },
    schema: {
      tags: ['bff-auth'],
      summary: 'Verify OTP and login',
      body: {
        type: 'object',
        required: ['email', 'tenantSlug', 'code'],
        properties: {
          email: { type: 'string', format: 'email' },
          tenantSlug: { type: 'string' },
          code: { type: 'string', minLength: 6, maxLength: 6 },
        },
      },
    },
  }, async (request, reply) => {
    const { email, tenantSlug, code } = otpVerifySchema.parse(request.body);
    await assertSignInHost(request, tenantSlug);
    if (isPlatformSlug(tenantSlug)) {
      throw new AppError('Invalid OTP', 401);
    }
    const { tenant, db } = await tenantForSignIn(tenantSlug);
    const owner = { tenantId: tenant.id, tenantSlug: tenant.slug };

    const otpRecord = await db.otpCode.findFirst({
      where: { tenantId: tenant.id, email, code, verified: false },
    });
    if (!otpRecord) {
      await recordSignInFailure(request, owner, { email, method: 'email-code', reason: 'wrong code' });
      throw new AppError('Invalid OTP', 401);
    }
    if (new Date() > otpRecord.expiresAt) {
      await db.otpCode.delete({ where: { id: otpRecord.id } });
      await recordSignInFailure(request, owner, { email, method: 'email-code', reason: 'code expired' });
      throw new AppError('OTP has expired', 401);
    }
    await db.otpCode.update({ where: { id: otpRecord.id }, data: { verified: true } });

    const user = await db.user.findFirst({ where: { tenantId: tenant.id, email } });
    if (!user) {
      throw new AppError('User not found', 404);
    }
    if (user.status !== 'ACTIVE') {
      await recordSignInFailure(request, owner, { email, userId: user.id, method: 'email-code', reason: 'account not active' });
      throw new AppError('User account is not active', 403);
    }

    const next = await completeSignIn(fastify, request, reply, owner, user);
    if (next) return mfaNext(next);
    await recordSignIn(request, owner, user.id, 'logged in via OTP', 'email-code');

    return {
      message: 'Login successful',
      user: { id: user.id, email: user.email, name: user.name, userType: user.userType, portal: portalOf(user.userType) },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    };
  });

  // Single sign-on (lib/sso.ts). The browser is sent here, then to the
  // identity provider, which sends it back to /sso/callback; that starts the
  // session and returns the browser to the sign-in page, which goes on in.
  fastify.get('/sso/start', {
    schema: {
      tags: ['bff-auth'],
      summary: 'Start signing in with an identity provider (browser redirect)',
      querystring: {
        type: 'object',
        required: ['tenantSlug', 'providerId'],
        properties: { tenantSlug: { type: 'string' }, providerId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { tenantSlug, providerId } = request.query as { tenantSlug: string; providerId: string };
    try {
      await assertSignInHost(request, tenantSlug);
      // Back to the address the browser started on (a custom domain has its own callback)
      return reply.redirect((await startSso(tenantSlug, providerId, await ssoRedirectUriFor(request))).href);
    } catch (err) {
      request.log.warn({ err }, 'Single sign-on could not start');
      return reply.redirect(ssoErrorRedirect(await appOriginFor(request), tenantSlug, err));
    }
  });

  fastify.get('/sso/callback', {
    schema: { tags: ['bff-auth'], summary: 'Where identity providers return the browser' },
  }, async (request, reply) => {
    const url = new URL(request.url, await ssoRedirectUriFor(request));
    const appOrigin = await appOriginFor(request);
    let slug = tokenSlug(url.searchParams.get('state') ?? '') ?? '';
    try {
      const done = await finishSso(url);
      slug = done.slug;
      const ssoOwner = { tenantId: done.tenant.id, tenantSlug: done.tenant.slug };
      const { user, how } = await userForIdentity(done.db, done.tenant.id, done.provider, done.identity).catch(async (err) => {
        await recordSignInFailure(request, ssoOwner, { email: done.identity.email ?? '', method: 'sso', reason: (err as Error).message });
        throw err;
      });
      if (user.status === 'INACTIVE') {
        await recordSignInFailure(request, ssoOwner, { email: user.email, userId: user.id, method: 'sso', reason: 'account not active' });
        throw new SsoError('Your account is not active', 'SSO_INACTIVE');
      }
      if (how === 'created') {
        await audit(request, 'user.created_by_sso', {
          resource: { type: 'user', id: user.id, label: user.email },
          details: { provider: done.provider.provider, userType: user.userType },
        }, { actor: { type: 'USER', id: user.id, email: user.email }, tenantId: done.tenant.id });
      }
      // Signing in through the organization's provider accepts an invitation
      if (user.status === 'PENDING') {
        await done.db.user.updateMany({ where: { id: user.id, tenantId: done.tenant.id }, data: { status: 'ACTIVE' } });
      }
      const owner = { tenantId: done.tenant.id, tenantSlug: done.tenant.slug };
      // Two-factor at sign-in is the identity provider's job here
      await startSession(fastify, request, reply, owner, user);
      await recordSignIn(request, owner, user.id, `logged in with ${done.provider.provider}${how === 'created' ? ' (new account)' : ''}`, 'sso');
      return reply.redirect(`${appOrigin}/${encodeURIComponent(done.tenant.slug)}/login`);
    } catch (err) {
      request.log.warn({ err }, 'Single sign-on failed');
      return reply.redirect(ssoErrorRedirect(appOrigin, slug, err));
    }
  });

  // Refresh token endpoint
  fastify.post('/refresh', {
    schema: {
      tags: ['bff-auth'],
      summary: 'Refresh access token using refresh token',
    },
  }, async (request, reply) => {
    const refreshTokenValue = request.cookies.refresh_token;

    if (!refreshTokenValue) {
      throw new AppError('Refresh token not found', 401);
    }

    const storedToken = await findRefreshToken(refreshTokenValue);
    if (!storedToken || !storedToken.user) {
      throw new AppError('Invalid refresh token', 401);
    }

    // Token reuse: someone presented a rotated-out token. Revoke the whole family.
    if (storedToken.revokedAt) {
      await revokeRefreshToken(storedToken, 'family');
      throw new AppError('Token reuse detected - all sessions revoked', 401);
    }
    if (storedToken.expiresAt < new Date()) {
      throw new AppError('Refresh token expired', 401);
    }
    if (storedToken.user.status !== 'ACTIVE') {
      throw new AppError('User account is not active', 403);
    }
    // Idle too long, or past the maximum session length: the session is over
    try {
      await assertRefreshAllowed(storedToken);
    } catch (err) {
      await revokeRefreshToken(storedToken, 'family');
      reply.clearCookie('access_token', { path: '/' });
      reply.clearCookie('refresh_token', { path: '/' });
      throw err;
    }

    // Rotate: revoke the old token, issue a new one in the same family
    await revokeRefreshToken(storedToken);
    await startSession(fastify, request, reply, storedToken.owner, storedToken.user, {
      familyId: storedToken.familyId,
      sessionStartedAt: storedToken.sessionStartedAt,
    });

    return {
      message: 'Token refreshed successfully',
    };
  });

  // Logout endpoint
  fastify.post('/logout', {
    schema: {
      tags: ['bff-auth'],
      summary: 'Logout and clear cookies',
    },
  }, async (request, reply) => {
    const refreshTokenValue = request.cookies.refresh_token;

    if (refreshTokenValue) {
      await revokeRefreshTokenValue(refreshTokenValue);
    }

    // Clear cookies
    reply.clearCookie('access_token', { path: '/' });
    reply.clearCookie('refresh_token', { path: '/' });

    return {
      message: 'Logout successful',
    };
  });

  // Get current user endpoint
  fastify.get('/me', {
    schema: {
      tags: ['bff-auth'],
      summary: 'Get current authenticated user',
    },
  }, async (request) => {
    const session = await verifySession(request);
    const select = { id: true, email: true, name: true, userType: true } as const;
    const [user, tenant] = session.tenantId
      ? await Promise.all([
          (await dbForTenant(session.tenantId)).user.findFirst({ where: { id: session.id, tenantId: session.tenantId }, select }),
          controlDb.tenant.findUnique({ where: { id: session.tenantId }, select: { id: true, name: true, slug: true, primaryColor: true, logoUrl: true, status: true, trialEndsAt: true } }),
        ])
      : [await controlDb.platformUser.findUnique({ where: { id: session.id }, select }), null];
    if (!user) {
      throw new AppError('Not authenticated', 401);
    }
    return {
      user: { ...user, portal: portalOf(user.userType) },
      tenant,
      // Which optional parts of the app to show (lib/preview.ts)
      features: { preview: config.previewFeatures },
    };
  });

  // Check authentication status
  fastify.get('/status', {
    schema: {
      tags: ['bff-auth'],
      summary: 'Check authentication status',
    },
  }, async (request) => {
    const accessToken = request.cookies.access_token;
    const refreshToken = request.cookies.refresh_token;

    return {
      isAuthenticated: !!accessToken,
      hasRefreshToken: !!refreshToken,
    };
  });

  // Revoke all sessions for current user
  fastify.post('/revoke-all', {
    schema: {
      tags: ['bff-auth'],
      summary: 'Revoke all active sessions for current user',
    },
  }, async (request, reply) => {
    const user = await verifySession(request);

    // Ends every session, including access tokens already handed out
    if (user.tenantId) {
      const db = await dbForTenant(user.tenantId);
      await db.$transaction(endAllSessions(db, user.id));
    } else {
      await controlDb.$transaction(endAllPlatformSessions(user.id));
    }

    reply.clearCookie('access_token', { path: '/' });
    reply.clearCookie('refresh_token', { path: '/' });

    await logActivity({ tenantId: user.tenantId, userId: user.id, action: 'revoked all sessions', target: 'system', type: 'AUTH' });
    await audit(request, user.tenantId ? 'auth.signed_out_everywhere' : 'platform.auth.signed_out_everywhere', {}, {
      actor: { type: user.tenantId ? 'USER' : 'PLATFORM', id: user.id },
      tenantId: user.tenantId ?? null,
    });

    return { message: 'All sessions revoked successfully' };
  });

  // Get active sessions for current user
  fastify.get('/sessions', {
    schema: {
      tags: ['bff-auth'],
      summary: 'Get active sessions for current user',
    },
  }, async (request) => {
    const user = await verifySession(request);
    const sessions = await activeSessions(user);
    return {
      sessions: sessions.map((session) => ({
        ...session,
        isCurrent: false, // Will be set by frontend based on current session
      })),
    };
  });
};
