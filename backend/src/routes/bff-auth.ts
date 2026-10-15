import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { loginRateLimit, otpRequestRateLimit, otpVerifyRateLimit } from '../lib/rate-limits.js';
import { config } from '../config/env.js';
import { sendMail } from '../lib/mailer.js';
import { otpEmail } from '../lib/email-templates.js';
import { verifyPassword } from '../utils/auth.js';
import { isPlatformSlug } from '../lib/platform.js';
import crypto from 'crypto';

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

// Helper function to generate secure random token
function generateSecureToken(): string {
  return crypto.randomBytes(64).toString('hex');
}

// Helper function to parse expiry string to milliseconds
function parseExpiryToMs(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error('Invalid expiry format');
  
  const value = parseInt(match[1]);
  const unit = match[2];
  
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: throw new Error('Invalid expiry unit');
  }
}

export const bffAuthRoutes: FastifyPluginAsync = async (fastify) => {
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
    const platformLogin = isPlatformSlug(tenantSlug);

    // Platform users have no tenant; tenant users log in through their tenant's slug
    const tenant = platformLogin
      ? null
      : await prisma.tenant.findUnique({
          where: { slug: tenantSlug },
          include: { authConfig: true },
        });

    if (!platformLogin) {
      if (!tenant) {
        throw new AppError('Tenant not found', 404);
      }
      if (tenant.status === 'SUSPENDED') {
        throw new AppError('Tenant is suspended', 403);
      }
    }

    const user = await prisma.user.findFirst({
      where: tenant
        ? { tenantId: tenant.id, email }
        : { tenantId: null, email, userType: { in: ['PLATFORM_ADMIN', 'PLATFORM_USER'] } },
    });

    // Password is required. Verify it before revealing anything else about the account.
    if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      throw new AppError('Invalid credentials', 401);
    }

    if (tenant) {
      if (user.tenantId !== tenant.id) {
        throw new AppError('Invalid credentials', 401);
      }
      if (tenant.authConfig?.ssoOnly) {
        throw new AppError('SSO authentication required', 403);
      }
    }

    if (user.status !== 'ACTIVE') {
      throw new AppError('User account is not active', 403);
    }

    const tenantId = user.tenantId ?? undefined;

    // Generate access token (short-lived)
    const accessToken = fastify.jwt.sign({
      userId: user.id,
      tenantId,
      userType: user.userType,
      type: 'access',
    }, {
      expiresIn: config.accessTokenExpiry,
    });

    // Generate refresh token (longer-lived)
    const refreshTokenValue = generateSecureToken();
    const familyId = generateSecureToken();
    const refreshExpiryMs = parseExpiryToMs(config.refreshTokenExpiry);
    const refreshExpiresAt = new Date(Date.now() + refreshExpiryMs);

    // Store refresh token in database
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tenantId: tenantId ?? null,
        token: refreshTokenValue,
        familyId,
        expiresAt: refreshExpiresAt,
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
      },
    });

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId: user.id,
        action: 'logged in via BFF',
        target: 'system',
        type: 'AUTH',
      },
    });

    // Set httpOnly cookies
    const isProduction = config.nodeEnv === 'production';
    
    reply.setCookie('access_token', accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: parseExpiryToMs(config.accessTokenExpiry) / 1000,
    });

    reply.setCookie('refresh_token', refreshTokenValue, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: refreshExpiryMs / 1000,
    });

    // Determine portal based on user type
    const portal = user.userType.startsWith('PLATFORM_') ? 'PLATFORM' : 'TENANT';

    return {
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        userType: user.userType,
        portal,
      },
      tenant: tenant ? {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
      } : null,
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

    // Find tenant
    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      include: { authConfig: true },
    });

    if (!tenant) {
      throw new AppError('Tenant not found', 404);
    }

    if (tenant.status === 'SUSPENDED') {
      throw new AppError('Tenant is suspended', 403);
    }

    // Check if OTP is enabled
    if (!tenant.authConfig?.otpEnabled) {
      throw new AppError('OTP authentication is not enabled for this tenant', 400);
    }

    // Find user
    const user = await prisma.user.findFirst({
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

    if (user.tenantId !== tenant.id) {
      throw new AppError('User is not associated with this tenant', 403);
    }

    // Only active accounts can sign in; answer the same way as for unknown emails
    if (user.status !== 'ACTIVE') {
      return { message: 'If an active account exists for this email, a sign-in code has been sent' };
    }

    // Delete any existing OTPs for this email
    await prisma.otpCode.deleteMany({
      where: {
        tenantId: tenant.id,
        email,
      },
    });

    // Generate OTP
    const { generateOtp, getOtpExpiration } = await import('../utils/auth.js');
    const code = generateOtp();
    const expiresAt = getOtpExpiration(tenant.authConfig.otpExpiry);

    // Store OTP
    await prisma.otpCode.create({
      data: {
        tenantId: tenant.id,
        email,
        code,
        expiresAt,
      },
    });

    await sendMail(otpEmail(email, code, tenant.name, tenant.authConfig.otpExpiry));

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

    // Find tenant
    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
    });

    if (!tenant) {
      throw new AppError('Tenant not found', 404);
    }

    // Find OTP
    const otpRecord = await prisma.otpCode.findFirst({
      where: {
        tenantId: tenant.id,
        email,
        code,
        verified: false,
      },
    });

    if (!otpRecord) {
      throw new AppError('Invalid OTP', 401);
    }

    // Check if OTP has expired
    if (new Date() > otpRecord.expiresAt) {
      await prisma.otpCode.delete({ where: { id: otpRecord.id } });
      throw new AppError('OTP has expired', 401);
    }

    // Mark OTP as verified
    await prisma.otpCode.update({
      where: { id: otpRecord.id },
      data: { verified: true },
    });

    // Find user
    const user = await prisma.user.findFirst({
      where: {
        tenantId: tenant.id,
        email,
      },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const tenantId = user.tenantId;
    if (!tenantId || tenantId !== tenant.id) {
      throw new AppError('User is not associated with this tenant', 403);
    }

    if (user.status !== 'ACTIVE') {
      throw new AppError('User account is not active', 403);
    }

    if (tenant.status === 'SUSPENDED') {
      throw new AppError('Tenant is suspended', 403);
    }

    // Generate access token
    const accessToken = fastify.jwt.sign({
      userId: user.id,
      tenantId,
      userType: user.userType,
      type: 'access',
    }, {
      expiresIn: config.accessTokenExpiry,
    });

    // Generate refresh token
    const refreshTokenValue = generateSecureToken();
    const familyId = generateSecureToken();
    const refreshExpiryMs = parseExpiryToMs(config.refreshTokenExpiry);
    const refreshExpiresAt = new Date(Date.now() + refreshExpiryMs);

    // Store refresh token
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tenantId: tenantId ?? null,
        token: refreshTokenValue,
        familyId,
        expiresAt: refreshExpiresAt,
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
      },
    });

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId: user.id,
        action: 'logged in via OTP',
        target: 'system',
        type: 'AUTH',
      },
    });

    // Set httpOnly cookies
    const isProduction = config.nodeEnv === 'production';
    
    reply.setCookie('access_token', accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: parseExpiryToMs(config.accessTokenExpiry) / 1000,
    });

    reply.setCookie('refresh_token', refreshTokenValue, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: refreshExpiryMs / 1000,
    });

    // Determine portal based on user type
    const portal = user.userType.startsWith('PLATFORM_') ? 'PLATFORM' : 'TENANT';

    return {
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        userType: user.userType,
        portal,
      },
      tenant: tenant ? {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
      } : null,
    };
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

    // Find refresh token in database
    const storedToken = await prisma.refreshToken.findUnique({
      where: { token: refreshTokenValue },
    });

    if (!storedToken) {
      throw new AppError('Invalid refresh token', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: storedToken.userId },
      select: {
        id: true,
        tenantId: true,
        userType: true,
        status: true,
      },
    });

    if (!user || user.tenantId !== storedToken.tenantId) {
      throw new AppError('Invalid refresh token', 401);
    }

    // Check if token is revoked
    if (storedToken.revokedAt) {
      // Token reuse detected - revoke entire family
      await prisma.refreshToken.updateMany({
        where: { familyId: storedToken.familyId },
        data: { revokedAt: new Date() },
      });

      throw new AppError('Token reuse detected - all sessions revoked', 401);
    }

    // Check if token is expired
    if (storedToken.expiresAt < new Date()) {
      throw new AppError('Refresh token expired', 401);
    }

    // Check if user is still active
    if (user.status !== 'ACTIVE') {
      throw new AppError('User account is not active', 403);
    }

    // Rotate refresh token (issue new one, revoke old one)
    const newRefreshTokenValue = generateSecureToken();
    const refreshExpiryMs = parseExpiryToMs(config.refreshTokenExpiry);
    const refreshExpiresAt = new Date(Date.now() + refreshExpiryMs);

    // Revoke old token
    await prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revokedAt: new Date() },
    });

    // Create new refresh token with same family
    await prisma.refreshToken.create({
      data: {
        userId: storedToken.userId,
        tenantId: storedToken.tenantId,
        token: newRefreshTokenValue,
        familyId: storedToken.familyId,
        expiresAt: refreshExpiresAt,
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
      },
    });

    // Generate new access token
    const newAccessToken = fastify.jwt.sign({
      userId: user.id,
      tenantId: storedToken.tenantId ?? undefined,
      userType: user.userType,
      type: 'access',
    }, {
      expiresIn: config.accessTokenExpiry,
    });

    // Set new cookies
    const isProduction = config.nodeEnv === 'production';
    
    reply.setCookie('access_token', newAccessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: parseExpiryToMs(config.accessTokenExpiry) / 1000,
    });

    reply.setCookie('refresh_token', newRefreshTokenValue, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: refreshExpiryMs / 1000,
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
      // Revoke refresh token
      await prisma.refreshToken.updateMany({
        where: { token: refreshTokenValue },
        data: { revokedAt: new Date() },
      });
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
    const accessToken = request.cookies.access_token;

    if (!accessToken) {
      throw new AppError('Not authenticated', 401);
    }

    try {
      const decoded = fastify.jwt.verify(accessToken) as any;

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: {
          id: true,
          email: true,
          name: true,
          userType: true,
          tenantId: true,
          tenant: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
      });

      if (!user) {
        throw new AppError('User not found', 404);
      }

      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          userType: user.userType,
          portal: user.userType.startsWith('PLATFORM_') ? 'PLATFORM' : 'TENANT',
        },
        tenant: user.tenant,
      };
    } catch (error) {
      throw new AppError('Invalid or expired token', 401);
    }
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
    const accessToken = request.cookies.access_token;

    if (!accessToken) {
      throw new AppError('Not authenticated', 401);
    }

    try {
      const decoded = fastify.jwt.verify(accessToken) as any;

      // Revoke all refresh tokens for this user
      await prisma.refreshToken.updateMany({
        where: { userId: decoded.userId },
        data: { revokedAt: new Date() },
      });

      // Clear cookies
      reply.clearCookie('access_token', { path: '/' });
      reply.clearCookie('refresh_token', { path: '/' });

      // Log activity
      await prisma.activity.create({
        data: {
          tenantId: decoded.tenantId,
          userId: decoded.userId,
          action: 'revoked all sessions',
          target: 'system',
          type: 'AUTH',
        },
      });

      return {
        message: 'All sessions revoked successfully',
      };
    } catch (error) {
      throw new AppError('Invalid or expired token', 401);
    }
  });

  // Get active sessions for current user
  fastify.get('/sessions', {
    schema: {
      tags: ['bff-auth'],
      summary: 'Get active sessions for current user',
    },
  }, async (request) => {
    const accessToken = request.cookies.access_token;

    if (!accessToken) {
      throw new AppError('Not authenticated', 401);
    }

    try {
      const decoded = fastify.jwt.verify(accessToken) as any;

      const sessions = await prisma.refreshToken.findMany({
        where: {
          userId: decoded.userId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          userAgent: true,
          ipAddress: true,
          createdAt: true,
          expiresAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      return {
        sessions: sessions.map(session => ({
          id: session.id,
          userAgent: session.userAgent,
          ipAddress: session.ipAddress,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          isCurrent: false, // Will be set by frontend based on current session
        })),
      };
    } catch (error) {
      throw new AppError('Invalid or expired token', 401);
    }
  });
};
