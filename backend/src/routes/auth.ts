import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { dbForTenant } from '../lib/tenant-db.js';
import { slugToken, tenantForSignIn, tokenSlug } from '../lib/auth-planes.js';
import { verifySession } from '../lib/sessions.js';
import { AppError } from '../middleware/error-handler.js';
import { isPlatformSlug } from '../lib/platform.js';
import { loginRateLimit, otpRequestRateLimit, otpVerifyRateLimit } from '../lib/rate-limits.js';
import crypto from 'crypto';
import { generateOtp, verifyPassword, hashPassword, getOtpExpiration } from '../utils/auth.js';
import { config } from '../config/env.js';
import { sendMail } from '../lib/mailer.js';
import { otpEmail } from '../lib/email-templates.js';
import { logActivity } from '../lib/activity.js';

// Validation schemas
const loginSchema = z.object({
  email: z.string().email(),
  tenantId: z.string().uuid(),
  password: z.string().min(1),
});

const oauthInitiateSchema = z.object({
  provider: z.enum(['ENTRA', 'GOOGLE', 'GITHUB', 'OKTA', 'AUTH0', 'CUSTOM_OIDC']),
  redirectUri: z.string().url(),
});

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Get tenant by slug (for tenant-specific login pages)
  fastify.get('/tenant/:slug', {
    schema: {
      tags: ['auth'],
      summary: 'Get tenant by slug for login page',
      params: {
        type: 'object',
        required: ['slug'],
        properties: {
          slug: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };

    // The platform portal has no tenant row; describe it so the login page can render
    if (isPlatformSlug(slug)) {
      return {
        id: null,
        name: 'Platform Administration',
        slug,
        status: 'ACTIVE',
        loginTitle: 'Platform Administration',
        loginSubtitle: 'Sign in with your platform account',
        authConfig: { ssoOnly: false, otpEnabled: false, providers: [] },
      };
    }

    const { tenant, db } = await tenantForSignIn(slug);
    const authConfig = await db.authConfig.findUnique({
      where: { tenantId: tenant.id },
      select: {
        ssoOnly: true,
        otpEnabled: true,
        providers: { where: { enabled: true }, select: { id: true, provider: true } },
      },
    });

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      logoUrl: tenant.logoUrl,
      primaryColor: tenant.primaryColor,
      loginTitle: tenant.loginTitle,
      loginSubtitle: tenant.loginSubtitle,
      status: tenant.status,
      authConfig,
    };
  });

  // Verify organization exists and return portal info
  fastify.get('/verify-organization/:slug', {
    schema: {
      tags: ['auth'],
      summary: 'Verify organization exists and get portal info',
      params: {
        type: 'object',
        required: ['slug'],
        properties: {
          slug: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };

    // Check if it's a special platform slug
    if (isPlatformSlug(slug)) {
      return {
        exists: true,
        portal: 'PLATFORM',
        slug,
      };
    }

    // Check if tenant exists
    const tenant = await controlDb.tenant.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        status: true,
      },
    });

    if (!tenant) {
      return {
        exists: false,
        portal: null,
        slug,
      };
    }

    if (tenant.status === 'SUSPENDED') {
      throw new AppError('Organization is suspended', 403);
    }

    return {
      exists: true,
      portal: 'TENANT',
      slug: tenant.slug,
    };
  });

  // Get available providers for a tenant (for login page)
  fastify.get('/tenant/:slug/providers', {
    schema: {
      tags: ['auth'],
      summary: 'Get available authentication providers for tenant',
      params: {
        type: 'object',
        required: ['slug'],
        properties: {
          slug: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };

    const { tenant, db } = await tenantForSignIn(slug);
    const authConfig = await db.authConfig.findUnique({
      where: { tenantId: tenant.id },
      select: { ssoOnly: true, providers: { where: { enabled: true }, select: { id: true, provider: true } } },
    });

    return {
      tenantId: tenant.id,
      ssoOnly: authConfig?.ssoOnly || false,
      providers: authConfig?.providers || [],
    };
  });

  // Initiate OAuth flow
  fastify.post('/oauth/initiate', {
    schema: {
      tags: ['auth'],
      summary: 'Initiate OAuth flow for a provider',
      body: {
        type: 'object',
        required: ['tenantSlug', 'provider', 'redirectUri'],
        properties: {
          tenantSlug: { type: 'string' },
          provider: { type: 'string', enum: ['ENTRA', 'GOOGLE', 'GITHUB', 'OKTA', 'AUTH0', 'CUSTOM_OIDC'] },
          redirectUri: { type: 'string', format: 'uri' },
        },
      },
    },
  }, async (request, reply) => {
    const { tenantSlug, provider, redirectUri } = request.body as {
      tenantSlug: string;
      provider: string;
      redirectUri: string;
    };

    const { tenant, db } = await tenantForSignIn(tenantSlug);
    const authConfig = await db.authConfig.findUnique({
      where: { tenantId: tenant.id },
      include: { providers: { where: { provider: provider as any, enabled: true } } },
    });

    if (!authConfig) {
      throw new AppError('Authentication not configured for this tenant', 400);
    }

    const authProvider = authConfig.providers[0];
    if (!authProvider) {
      throw new AppError('Provider not enabled for this tenant', 400);
    }

    // State for CSRF protection; starts with the slug so the callback finds the tenant's database
    const state = slugToken(tenant.slug, 32);

    await db.oAuthSession.create({
      data: {
        state,
        providerId: authProvider.id,
        tenantId: tenant.id,
        redirectUri,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      },
    });

    // Build authorization URL based on provider
    let authorizeUrl = '';
    const params = new URLSearchParams({
      client_id: authProvider.clientId || '',
      redirect_uri: `${process.env.APP_URL || 'http://localhost:5173'}/auth/callback`,
      response_type: 'code',
      scope: authProvider.scopes.join(' '),
      state,
    });

    switch (authProvider.provider) {
      case 'ENTRA':
        authorizeUrl = `https://login.microsoftonline.com/${authProvider.idpTenantId || 'common'}/oauth2/v2.0/authorize?${params}`;
        break;
      case 'GOOGLE':
        params.append('access_type', 'offline');
        params.append('prompt', 'consent');
        authorizeUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
        break;
      case 'GITHUB':
        authorizeUrl = `https://github.com/login/oauth/authorize?${params}`;
        break;
      case 'OKTA':
        authorizeUrl = `https://${authProvider.domain}/oauth2/v1/authorize?${params}`;
        break;
      case 'AUTH0':
        authorizeUrl = `https://${authProvider.domain}/authorize?${params}`;
        break;
      case 'CUSTOM_OIDC':
        authorizeUrl = `${authProvider.authorizeUrl}?${params}`;
        break;
    }

    return {
      authorizationUrl: authorizeUrl,
      state,
    };
  });

  // OAuth callback handler
  fastify.get('/oauth/callback', {
    schema: {
      tags: ['auth'],
      summary: 'OAuth callback handler',
      querystring: {
        type: 'object',
        required: ['code', 'state'],
        properties: {
          code: { type: 'string' },
          state: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { code, state } = request.query as { code: string; state: string };

    // Validate OAuth session (in the database of the tenant the state names)
    const slug = tokenSlug(state);
    const stateTenant = slug ? await controlDb.tenant.findUnique({ where: { slug } }) : null;
    if (!stateTenant || stateTenant.status === 'SUSPENDED') {
      throw new AppError('Invalid or expired OAuth session', 400);
    }
    const db = dbForTenant(stateTenant.id);
    const oauthSession = await db.oAuthSession.findFirst({
      where: { state, tenantId: stateTenant.id },
    });

    if (!oauthSession) {
      throw new AppError('Invalid or expired OAuth session', 400);
    }

    if (oauthSession.expiresAt < new Date()) {
      await db.oAuthSession.delete({ where: { id: oauthSession.id } });
      throw new AppError('OAuth session expired', 400);
    }

    // OAuthSession has no Prisma relation to AuthProvider, so load it explicitly
    const authProvider = await db.authProvider.findFirst({
      where: { id: oauthSession.providerId, tenantId: stateTenant.id },
    });

    if (!authProvider) {
      throw new AppError('Invalid or expired OAuth session', 400);
    }
    const tenant = stateTenant;

    // Exchange code for tokens (provider-specific)
    let userInfo: { email: string; name?: string; providerUserId: string };

    try {
      // This is a simplified version - in production, you'd make actual HTTP requests
      // to the provider's token and userinfo endpoints
      
      // For demo purposes, we'll simulate the user info
      userInfo = {
        email: `user@${tenant.slug}.com`,
        name: 'OAuth User',
        providerUserId: `provider-${Date.now()}`,
      };

      // In production, you would:
      // 1. Exchange code for access token
      // 2. Use access token to get user info
      // 3. Extract email and name from user info
    } catch (error) {
      throw new AppError('Failed to authenticate with provider', 400);
    }

    // Find or create user
    let user = await db.user.findFirst({
      where: {
        tenantId: tenant.id,
        email: userInfo.email,
      },
    });

    if (!user) {
      // Auto-provision if enabled
      if (!authProvider.autoProvision) {
        throw new AppError('User not found and auto-provisioning is disabled', 404);
      }

      user = await db.user.create({
        data: {
          tenantId: tenant.id,
          email: userInfo.email,
          name: userInfo.name,
          userType: 'TENANT_USER',
          status: 'ACTIVE',
        },
      });
    }

    if (user.status !== 'ACTIVE') {
      throw new AppError('User account is not active', 403);
    }

    // Update last login
    await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Delete OAuth session
    await db.oAuthSession.delete({ where: { id: oauthSession.id } });

    // Generate JWT token
    const token = fastify.jwt.sign({
      userId: user.id,
      tenantId: tenant.id,
      userType: user.userType,
      provider: authProvider.provider,
    });

    // Log activity
    await logActivity({
        tenantId: tenant.id,
        userId: user.id,
        action: 'logged in via OAuth',
        target: authProvider.provider,
        type: 'AUTH',
      });

    // Redirect to frontend with token
    const redirectUrl = new URL(oauthSession.redirectUri);
    redirectUrl.searchParams.set('token', token);
    redirectUrl.searchParams.set('tenantId', tenant.id);

    return reply.redirect(redirectUrl.toString());
  });

  // Login (email/password - fallback when SSO is not required)
  fastify.post('/login', {
    config: { rateLimit: loginRateLimit('auth') },
    schema: {
      tags: ['auth'],
      summary: 'User login with email/password',
      body: {
        type: 'object',
        required: ['email', 'tenantId', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          tenantId: { type: 'string', format: 'uuid' },
          password: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { email, tenantId, password } = loginSchema.parse(request.body);

    const tenantRow = await controlDb.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, status: true } });
    const db = dbForTenant(tenantId);

    // Check if tenant requires SSO only
    const authConfig = await db.authConfig.findUnique({
      where: { tenantId },
    });

    if (authConfig?.ssoOnly) {
      throw new AppError('This tenant requires SSO authentication', 403);
    }

    // Find user
    const found = tenantRow
      ? await db.user.findUnique({ where: { tenantId_email: { tenantId, email } } })
      : null;
    const user = found && { ...found, tenant: tenantRow };

    // Verify the password before revealing anything else about the account
    if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      throw new AppError('Invalid credentials', 401);
    }

    if (user.status !== 'ACTIVE') {
      throw new AppError('User account is not active', 403);
    }

    if (!user.tenant) {
      throw new AppError('Invalid credentials', 401);
    }

    if (user.tenant.status === 'SUSPENDED') {
      throw new AppError('Tenant is suspended', 403);
    }

    // Update last login
    await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Generate JWT token
    const token = fastify.jwt.sign({
      userId: user.id,
      tenantId: user.tenant.id,
      userType: user.userType,
      provider: 'PASSWORD',
    });

    // Log activity
    await logActivity({
        tenantId: user.tenant.id,
        userId: user.id,
        action: 'logged in',
        target: 'system',
        type: 'AUTH',
      });

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        userType: user.userType,
      },
      tenant: {
        id: user.tenant.id,
        name: user.tenant.name,
      },
    };
  });

  // Request OTP for passwordless login
  fastify.post('/otp/request', {
    config: { rateLimit: otpRequestRateLimit('auth') },
    schema: {
      tags: ['auth'],
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
  }, async (request, reply) => {
    const { email, tenantSlug } = request.body as { email: string; tenantSlug: string };

    const { tenant, db } = await tenantForSignIn(tenantSlug);
    const authConfig = await db.authConfig.findUnique({ where: { tenantId: tenant.id } });

    // Check if OTP is enabled
    if (!authConfig?.otpEnabled) {
      throw new AppError('OTP authentication is not enabled for this tenant', 400);
    }

    // Check if user exists
    const user = await db.user.findFirst({
      where: {
        tenantId: tenant.id,
        email,
      },
    });

    if (!user) {
      // Don't reveal if user exists or not for security
      // But for development, we can be more explicit
      if (config.devExposeOtp) {
        throw new AppError('User not found', 404);
      }
      // In production, return success anyway to prevent email enumeration
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
        otp: code, // Only in development!
        expiresAt,
      };
    }


    return {
      message: 'If an active account exists for this email, a sign-in code has been sent',
      expiresAt,
    };
  });

  // Verify OTP and login
  fastify.post('/otp/verify', {
    config: { rateLimit: otpVerifyRateLimit('auth') },
    schema: {
      tags: ['auth'],
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
    const { email, tenantSlug, code } = request.body as {
      email: string;
      tenantSlug: string;
      code: string;
    };

    const { tenant, db } = await tenantForSignIn(tenantSlug);
    const authConfig = await db.authConfig.findUnique({ where: { tenantId: tenant.id } });

    // Find OTP
    const otpRecord = await db.otpCode.findFirst({
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
      await db.otpCode.delete({ where: { id: otpRecord.id } });
      throw new AppError('OTP has expired', 401);
    }

    // Mark OTP as verified
    await db.otpCode.update({
      where: { id: otpRecord.id },
      data: { verified: true },
    });

    // Find user
    const found = await db.user.findFirst({
      where: {
        tenantId: tenant.id,
        email,
      },
    });

    const user = found && { ...found, tenant };

    if (!user) {
      throw new AppError('User not found', 404);
    }

    if (user.status !== 'ACTIVE') {
      throw new AppError('User account is not active', 403);
    }

    if (!user.tenant) {
      throw new AppError('Invalid credentials', 401);
    }

    if (user.tenant.status === 'SUSPENDED') {
      throw new AppError('Tenant is suspended', 403);
    }

    // Update last login
    await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Generate JWT token
    const token = fastify.jwt.sign({
      userId: user.id,
      tenantId: user.tenant.id,
      userType: user.userType,
      provider: 'OTP',
    });

    // Log activity
    await logActivity({
        tenantId: user.tenant.id,
        userId: user.id,
        action: 'logged in via OTP',
        target: 'system',
        type: 'AUTH',
      });

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        userType: user.userType,
      },
      tenant: {
        id: user.tenant.id,
        name: user.tenant.name,
      },
    };
  });

  // Password-based login
  fastify.post('/password-login', {
    config: { rateLimit: loginRateLimit('auth-password') },
    schema: {
      tags: ['auth'],
      summary: 'Login with email and password',
      body: {
        type: 'object',
        required: ['email', 'password', 'tenantSlug'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string' },
          tenantSlug: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { email, password, tenantSlug } = request.body as {
      email: string;
      password: string;
      tenantSlug: string;
    };

    const { tenant, db } = await tenantForSignIn(tenantSlug);
    const authConfig = await db.authConfig.findUnique({ where: { tenantId: tenant.id } });

    // Check if SSO only
    if (authConfig?.ssoOnly) {
      throw new AppError('This tenant requires SSO authentication', 403);
    }

    // Find user
    const found = await db.user.findFirst({
      where: {
        tenantId: tenant.id,
        email,
      },
    });

    const user = found && { ...found, tenant };

    if (!user) {
      throw new AppError('Invalid credentials', 401);
    }

    if (!user.passwordHash) {
      throw new AppError('Password not set for this user. Please use SSO or set a password first.', 400);
    }

    // Verify password
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      throw new AppError('Invalid credentials', 401);
    }

    if (user.status !== 'ACTIVE') {
      throw new AppError('User account is not active', 403);
    }

    if (!user.tenant) {
      throw new AppError('Invalid credentials', 401);
    }

    if (user.tenant.status === 'SUSPENDED') {
      throw new AppError('Tenant is suspended', 403);
    }

    // Update last login
    await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Generate JWT token
    const token = fastify.jwt.sign({
      userId: user.id,
      tenantId: user.tenant.id,
      userType: user.userType,
      provider: 'PASSWORD',
    });

    // Log activity
    await logActivity({
        tenantId: user.tenant.id,
        userId: user.id,
        action: 'logged in with password',
        target: 'system',
        type: 'AUTH',
      });

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        userType: user.userType,
      },
      tenant: {
        id: user.tenant.id,
        name: user.tenant.name,
      },
    };
  });

  // Set password for user
  fastify.post('/set-password', {
    schema: {
      tags: ['auth'],
      summary: 'Set password for user',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['password'],
        properties: {
          password: { type: 'string', minLength: 8 },
          currentPassword: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const session = await verifySession(request);

    const { password, currentPassword } = request.body as { password: string; currentPassword?: string };

    // Changing an existing password requires the current one, so a stolen
    // session token can't be turned into a permanent account takeover.
    const existing = session.tenantId
      ? await dbForTenant(session.tenantId).user.findFirst({ where: { id: session.id, tenantId: session.tenantId }, select: { passwordHash: true } })
      : await controlDb.platformUser.findUnique({ where: { id: session.id }, select: { passwordHash: true } });
    if (!existing) {
      throw new AppError('User not found', 404);
    }
    if (existing.passwordHash) {
      if (!currentPassword || !(await verifyPassword(currentPassword, existing.passwordHash))) {
        throw new AppError('Current password is incorrect', 401);
      }
    }

    const passwordHash = await hashPassword(password);
    if (session.tenantId) {
      await dbForTenant(session.tenantId).user.updateMany({ where: { id: session.id, tenantId: session.tenantId }, data: { passwordHash } });
    } else {
      await controlDb.platformUser.update({ where: { id: session.id }, data: { passwordHash } });
    }

    return { message: 'Password set successfully' };
  });

  // Verify token
  fastify.get('/verify', {
    schema: {
      tags: ['auth'],
      summary: 'Verify JWT token',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    await verifySession(request);
    return { valid: true, user: request.user };
  });

  // Get user permissions (enhanced)
  fastify.get('/permissions', {
    schema: {
      tags: ['auth'],
      summary: 'Get current user permissions with metadata',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            permissions: {
              type: 'array',
              items: { type: 'string' },
            },
            sources: {
              type: 'object',
              properties: {
                userType: { type: 'string' },
                directRoles: { type: 'array', items: { type: 'string' } },
                groupRoles: { type: 'array', items: { type: 'string' } },
                delegations: { type: 'array', items: { type: 'string' } },
              },
            },
            effectivePermissions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  permission: { type: 'string' },
                  sources: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    // Current type and tenant from the database, not the token
    const user = await verifySession(request);
    const { getEnhancedUserPermissions } = await import('../utils/authorization.js');
    return getEnhancedUserPermissions(user.id, user.tenantId ?? undefined, user.userType);
  });
};
