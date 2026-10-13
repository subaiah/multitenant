import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';

// Validation schemas
const loginSchema = z.object({
  email: z.string().email(),
  tenantId: z.string().uuid(),
});

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  tenantId: z.string().uuid(),
  tenantName: z.string().min(2),
  tenantSlug: z.string().min(2).regex(/^[a-z0-9-]+$/),
});

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Login
  fastify.post('/login', {
    schema: {
      tags: ['auth'],
      summary: 'User login',
      body: {
        type: 'object',
        required: ['email', 'tenantId'],
        properties: {
          email: { type: 'string', format: 'email' },
          tenantId: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                email: { type: 'string' },
                name: { type: 'string', nullable: true },
                role: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { email, tenantId } = loginSchema.parse(request.body);

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
