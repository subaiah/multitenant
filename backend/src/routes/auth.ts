import { FastifyPluginAsync } from 'fastify';
import { controlDb } from '../lib/prisma.js';
import { dbForTenant } from '../lib/tenant-db.js';
import { verifySession } from '../lib/sessions.js';
import { tenantForSignIn } from '../lib/auth-planes.js';
import { AppError } from '../middleware/error-handler.js';
import { isPlatformSlug } from '../lib/platform.js';
import { verifyPassword, hashPassword } from '../utils/auth.js';

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
        closedAt: true,
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
      throw new AppError(tenant.closedAt ? 'This organization was closed' : 'Organization is suspended', 403);
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

  // Signing in (password, emailed code, two-factor, single sign-on) is in
  // bff-auth.ts, which sets session cookies under the tenant's session rules.
  // The token-returning sign-in routes that used to be here bypassed those
  // rules and two-factor, so they're gone.

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
      ? await (await dbForTenant(session.tenantId)).user.findFirst({ where: { id: session.id, tenantId: session.tenantId }, select: { passwordHash: true } })
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
      await (await dbForTenant(session.tenantId)).user.updateMany({ where: { id: session.id, tenantId: session.tenantId }, data: { passwordHash } });
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
