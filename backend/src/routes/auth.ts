import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import crypto from 'crypto';

// Validation schemas
const loginSchema = z.object({
  email: z.string().email(),
  tenantId: z.string().uuid(),
});

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  tenantName: z.string().min(2),
  tenantSlug: z.string().min(2).regex(/^[a-z0-9-]+$/),
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

    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
        primaryColor: true,
        loginTitle: true,
        loginSubtitle: true,
        status: true,
        authConfig: {
          select: {
            ssoOnly: true,
            providers: {
              where: { enabled: true },
              select: {
                id: true,
                provider: true,
              },
            },
          },
        },
      },
    });

    if (!tenant) {
      throw new AppError('Tenant not found', 404);
    }

    if (tenant.status === 'SUSPENDED') {
      throw new AppError('Tenant is suspended', 403);
    }

    return tenant;
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

    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      select: {
        id: true,
        status: true,
        authConfig: {
          select: {
            ssoOnly: true,
            providers: {
              where: { enabled: true },
              select: {
                id: true,
                provider: true,
              },
            },
          },
        },
      },
    });

    if (!tenant) {
      throw new AppError('Tenant not found', 404);
    }

    if (tenant.status === 'SUSPENDED') {
      throw new AppError('Tenant is suspended', 403);
    }

    return {
      tenantId: tenant.id,
      ssoOnly: tenant.authConfig?.ssoOnly || false,
      providers: tenant.authConfig?.providers || [],
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

    // Find tenant
    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      include: {
        authConfig: {
          include: {
            providers: {
              where: {
                provider: provider as any,
                enabled: true,
              },
            },
          },
        },
      },
    });

    if (!tenant) {
      throw new AppError('Tenant not found', 404);
    }

    if (!tenant.authConfig) {
      throw new AppError('Authentication not configured for this tenant', 400);
    }

    const authProvider = tenant.authConfig.providers[0];
    if (!authProvider) {
      throw new AppError('Provider not enabled for this tenant', 400);
    }

    // Generate state for CSRF protection
    const state = crypto.randomBytes(32).toString('hex');

    // Store OAuth session
    await prisma.oAuthSession.create({
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
        authorizeUrl = `https://login.microsoftonline.com/${authProvider.tenantId || 'common'}/oauth2/v2.0/authorize?${params}`;
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

    // Validate OAuth session
    const oauthSession = await prisma.oAuthSession.findUnique({
      where: { state },
      include: {
        provider: {
          include: {
            authConfig: {
              include: {
                tenant: true,
              },
            },
          },
        },
      },
    });

    if (!oauthSession) {
      throw new AppError('Invalid or expired OAuth session', 400);
    }

    if (oauthSession.expiresAt < new Date()) {
      await prisma.oAuthSession.delete({ where: { id: oauthSession.id } });
      throw new AppError('OAuth session expired', 400);
    }

    const authProvider = oauthSession.provider;
    const tenant = authProvider.authConfig.tenant;

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
    let user = await prisma.user.findFirst({
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

      user = await prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: userInfo.email,
          name: userInfo.name,
          role: 'USER',
          status: 'ACTIVE',
        },
      });
    }

    if (user.status !== 'ACTIVE') {
      throw new AppError('User account is not active', 403);
    }

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Delete OAuth session
    await prisma.oAuthSession.delete({ where: { id: oauthSession.id } });

    // Generate JWT token
    const token = fastify.jwt.sign({
      userId: user.id,
      tenantId: tenant.id,
      role: user.role,
      provider: authProvider.provider,
    });

    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        action: 'logged in via OAuth',
        target: authProvider.provider,
        type: 'AUTH',
      },
    });

    // Redirect to frontend with token
    const redirectUrl = new URL(oauthSession.redirectUri);
    redirectUrl.searchParams.set('token', token);
    redirectUrl.searchParams.set('tenantId', tenant.id);

    return reply.redirect(redirectUrl.toString());
  });

  // Login (email/password - fallback when SSO is not required)
  fastify.post('/login', {
    schema: {
      tags: ['auth'],
      summary: 'User login with email/password',
      body: {
        type: 'object',
        required: ['email', 'tenantId'],
        properties: {
          email: { type: 'string', format: 'email' },
          tenantId: { type: 'string', format: 'uuid' },
          password: { type: 'string' }, // In production, hash passwords
        },
      },
    },
  }, async (request, reply) => {
    const { email, tenantId } = loginSchema.parse(request.body);

    // Check if tenant requires SSO only
    const authConfig = await prisma.authConfig.findUnique({
      where: { tenantId },
    });

    if (authConfig?.ssoOnly) {
      throw new AppError('This tenant requires SSO authentication', 403);
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: {
        tenantId_email: {
          tenantId,
          email,
        },
      },
      include: {
        tenant: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
      },
    });

    if (!user) {
      throw new AppError('Invalid credentials', 401);
    }

    if (user.status !== 'ACTIVE') {
      throw new AppError('User account is not active', 403);
    }

    if (user.tenant.status === 'SUSPENDED') {
      throw new AppError('Tenant is suspended', 403);
    }

    // In production, verify password hash here
    // For demo, we'll accept any password

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Generate JWT token
    const token = fastify.jwt.sign({
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
      provider: 'PASSWORD',
    });

    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'logged in',
        target: 'system',
        type: 'AUTH',
      },
    });

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      tenant: {
        id: user.tenant.id,
        name: user.tenant.name,
      },
    };
  });

  // Register (creates tenant and admin user)
  fastify.post('/register', {
    schema: {
      tags: ['auth'],
      summary: 'Register new tenant and admin user',
      body: {
        type: 'object',
        required: ['email', 'name', 'tenantName', 'tenantSlug'],
        properties: {
          email: { type: 'string', format: 'email' },
          name: { type: 'string', minLength: 2 },
          tenantName: { type: 'string', minLength: 2 },
          tenantSlug: { type: 'string', minLength: 2 },
        },
      },
    },
  }, async (request, reply) => {
    const { email, name, tenantName, tenantSlug } = registerSchema.parse(request.body);

    // Check if slug is taken
    const existingTenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
    });

    if (existingTenant) {
      throw new AppError('Tenant slug already exists', 409);
    }

    // Create tenant and user in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create tenant
      const tenant = await tx.tenant.create({
        data: {
          name: tenantName,
          slug: tenantSlug,
          plan: 'TRIAL',
          status: 'ACTIVE',
          primaryColor: '#3b82f6',
          loginTitle: `Welcome to ${tenantName}`,
          loginSubtitle: 'Sign in to your account',
        },
      });

      // Create admin user
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email,
          name,
          role: 'ADMIN',
          status: 'ACTIVE',
        },
      });

      // Create default database config
      await tx.databaseConfig.create({
        data: {
          tenantId: tenant.id,
          strategy: 'SHARED_TABLES',
          provider: 'POSTGRESQL',
          region: 'US East',
          storageLimit: '5 GB',
          maxConnections: 20,
        },
      });

      // Create default auth config
      await tx.authConfig.create({
        data: {
          tenantId: tenant.id,
          mfaEnabled: false,
          sessionTimeout: 60,
          passwordPolicy: 'STANDARD',
          ssoOnly: false,
        },
      });

      // Create default API config
      await tx.apiConfig.create({
        data: {
          tenantId: tenant.id,
          bffEnabled: false,
          apiGateway: 'CUSTOM',
          rateLimit: 1000,
          corsEnabled: true,
          allowedOrigins: [],
          authType: 'JWT',
          versioning: 'URL',
        },
      });

      return { tenant, user };
    });

    // Generate JWT token
    const token = fastify.jwt.sign({
      userId: result.user.id,
      tenantId: result.tenant.id,
      role: result.user.role,
      provider: 'PASSWORD',
    });

    return reply.status(201).send({
      token,
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        slug: result.tenant.slug,
      },
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        role: result.user.role,
      },
    });
  });

  // Verify token
  fastify.get('/verify', {
    schema: {
      tags: ['auth'],
      summary: 'Verify JWT token',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    try {
      await request.jwtVerify();
      return { valid: true, user: request.user };
    } catch (err) {
      throw new AppError('Invalid token', 401);
    }
  });
};
