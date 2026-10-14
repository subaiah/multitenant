import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';

const updateAuthConfigSchema = z.object({
  mfaEnabled: z.boolean().optional(),
  sessionTimeout: z.number().min(5).max(1440).optional(),
  passwordPolicy: z.enum(['STANDARD', 'STRONG', 'VERY_STRONG']).optional(),
  ssoOnly: z.boolean().optional(),
});

const createAuthProviderSchema = z.object({
  provider: z.enum(['ENTRA', 'GOOGLE', 'GITHUB', 'OKTA', 'AUTH0', 'CUSTOM_OIDC']),
  enabled: z.boolean().default(false),
  clientId: z.string().optional(),
  tenantId: z.string().optional(),
  domain: z.string().optional(),
  scopes: z.array(z.string()).default(['openid', 'profile', 'email']),
  autoProvision: z.boolean().default(false),
});

const updateAuthProviderSchema = z.object({
  enabled: z.boolean().optional(),
  clientId: z.string().optional(),
  tenantId: z.string().optional(),
  domain: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  autoProvision: z.boolean().optional(),
});

export const authConfigRoutes: FastifyPluginAsync = async (fastify) => {
  // Get auth config for current tenant
  fastify.get('/', {
    schema: {
      tags: ['auth-config'],
      summary: 'Get authentication configuration for current tenant',
    },
  }, async (request, reply) => {
    const config = await prisma.authConfig.findUnique({
      where: { tenantId: request.tenant.id },
      include: {
        providers: true,
      },
    });

    if (!config) {
      throw new AppError('Authentication configuration not found', 404);
    }

    return config;
  });

  // Update auth config
  fastify.patch('/', {
    schema: {
      tags: ['auth-config'],
      summary: 'Update authentication configuration',
      body: {
        type: 'object',
        properties: {
          mfaEnabled: { type: 'boolean' },
          sessionTimeout: { type: 'number', minimum: 5, maximum: 1440 },
          passwordPolicy: { type: 'string', enum: ['STANDARD', 'STRONG', 'VERY_STRONG'] },
          ssoOnly: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    if (request.user.role !== 'ADMIN') {
      throw new AppError('Admin access required', 403);
    }

    const data = updateAuthConfigSchema.parse(request.body);

    const config = await prisma.authConfig.update({
      where: { tenantId: request.tenant.id },
      data,
    });

    await prisma.activity.create({
      data: {
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'updated authentication configuration',
        target: 'auth',
        type: 'CONFIG',
        metadata: data,
      },
    });

    return config;
  });

  // List auth providers
  fastify.get('/providers', {
    schema: {
      tags: ['auth-config'],
      summary: 'List authentication providers for current tenant',
    },
  }, async (request, reply) => {
    const config = await prisma.authConfig.findUnique({
      where: { tenantId: request.tenant.id },
      include: {
        providers: true,
      },
    });

    return config?.providers || [];
  });

  // Add auth provider
  fastify.post('/providers', {
    schema: {
      tags: ['auth-config'],
      summary: 'Add authentication provider',
      body: {
        type: 'object',
        required: ['provider'],
        properties: {
          provider: { type: 'string', enum: ['ENTRA', 'GOOGLE', 'GITHUB', 'OKTA', 'AUTH0', 'CUSTOM_OIDC'] },
          enabled: { type: 'boolean', default: false },
          clientId: { type: 'string' },
          tenantId: { type: 'string' },
          domain: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' } },
          autoProvision: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    if (request.user.role !== 'ADMIN') {
      throw new AppError('Admin access required', 403);
    }

    const data = createAuthProviderSchema.parse(request.body);

    const config = await prisma.authConfig.findUnique({
      where: { tenantId: request.tenant.id },
    });

    if (!config) {
      throw new AppError('Authentication configuration not found', 404);
    }

    // Check if provider already exists
    const existing = await prisma.authProvider.findFirst({
      where: {
        authConfigId: config.id,
        provider: data.provider,
      },
    });

    if (existing) {
      throw new AppError('Provider already exists', 409);
    }

    const provider = await prisma.authProvider.create({
      data: {
        ...data,
        authConfigId: config.id,
      },
    });

    await prisma.activity.create({
      data: {
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'added authentication provider',
        target: data.provider,
        type: 'AUTH',
      },
    });

    return reply.status(201).send(provider);
  });

  // Update auth provider
  fastify.patch('/providers/:id', {
    schema: {
      tags: ['auth-config'],
      summary: 'Update authentication provider',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          clientId: { type: 'string' },
          tenantId: { type: 'string' },
          domain: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' } },
          autoProvision: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    if (request.user.role !== 'ADMIN') {
      throw new AppError('Admin access required', 403);
    }

    const { id } = request.params;
    const data = updateAuthProviderSchema.parse(request.body);

    const provider = await prisma.authProvider.update({
      where: { id },
      data,
    });

    await prisma.activity.create({
      data: {
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'updated authentication provider',
        target: provider.provider,
        type: 'AUTH',
        metadata: data,
      },
    });

    return provider;
  });

  // Delete auth provider
  fastify.delete('/providers/:id', {
    schema: {
      tags: ['auth-config'],
      summary: 'Delete authentication provider',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    if (request.user.role !== 'ADMIN') {
      throw new AppError('Admin access required', 403);
    }

    const { id } = request.params;

    await prisma.authProvider.delete({
      where: { id },
    });

    return reply.status(204).send();
  });

  // Get available providers info
  fastify.get('/available-providers', {
    schema: {
      tags: ['auth-config'],
      summary: 'Get available authentication providers',
    },
  }, async (request, reply) => {
    return [
      {
        id: 'ENTRA',
        name: 'Microsoft Entra ID',
        description: 'Azure Active Directory / Microsoft 365 SSO',
        features: ['SAML 2.0', 'OIDC', 'SCIM Provisioning', 'Conditional Access'],
      },
      {
        id: 'GOOGLE',
        name: 'Google Workspace',
        description: 'Google Workspace / Gmail SSO',
        features: ['OAuth 2.0', 'OIDC', 'Google Groups Sync'],
      },
      {
        id: 'GITHUB',
        name: 'GitHub',
        description: 'GitHub Organizations SSO',
        features: ['OAuth 2.0', 'Team Sync', 'Organization SSO'],
      },
      {
        id: 'OKTA',
        name: 'Okta',
        description: 'Okta Universal Directory SSO',
        features: ['SAML 2.0', 'OIDC', 'SCIM', 'Lifecycle Management'],
      },
      {
        id: 'AUTH0',
        name: 'Auth0',
        description: 'Auth0 Identity Platform',
        features: ['SAML', 'OIDC', 'Social Connections', 'MFA'],
      },
      {
        id: 'CUSTOM_OIDC',
        name: 'Custom OIDC',
        description: 'Custom OpenID Connect provider',
        features: ['OIDC', 'Custom Claims', 'Flexible Scopes'],
      },
    ];
  });
};
