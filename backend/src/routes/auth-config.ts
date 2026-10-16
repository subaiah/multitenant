import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler.js';
import { hasMinimumUserType } from '../utils/authorization.js';
import { logActivity } from '../lib/activity.js';
import { audit, diff } from '../lib/audit.js';
import { ssoRedirectUri } from '../lib/sso.js';

const updateAuthConfigSchema = z.object({
  mfaEnabled: z.boolean().optional(),
  /** Idle minutes before a session ends */
  sessionTimeout: z.number().int().min(5).max(1440).optional(),
  /** Hours after signing in when a session ends, however active */
  maxSessionHours: z.number().int().min(1).max(720).optional(),
  passwordPolicy: z.enum(['STANDARD', 'STRONG', 'VERY_STRONG']).optional(),
  ssoOnly: z.boolean().optional(),
  otpEnabled: z.boolean().optional(),
  otpExpiry: z.number().int().min(1).max(60).optional(),
});

const createAuthProviderSchema = z.object({
  provider: z.enum(['ENTRA', 'GOOGLE', 'GITHUB', 'OKTA', 'AUTH0', 'CUSTOM_OIDC']),
  enabled: z.boolean().default(false),
  clientId: z.string().optional(),
  clientSecret: z.string().min(1).optional(), // write-only: never returned
  directoryId: z.string().optional(), // the identity provider's own tenant/directory id (e.g. Entra)
  domain: z.string().optional(),
  scopes: z.array(z.string()).default(['openid', 'profile', 'email']),
  autoProvision: z.boolean().default(false),
});

const updateAuthProviderSchema = z.object({
  enabled: z.boolean().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().min(1).optional(), // write-only: never returned
  directoryId: z.string().optional(), // the identity provider's own tenant/directory id (e.g. Entra)
  domain: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  autoProvision: z.boolean().optional(),
});

export const authConfigRoutes: FastifyPluginAsync = async (fastify) => {
  // Get auth config for current tenant
  fastify.get('/', {
    config: { permission: 'auth:read' },
    schema: {
      tags: ['auth-config'],
      summary: 'Get authentication configuration for current tenant',
    },
  }, async (request, reply) => {
    const config = await request.db.authConfig.findUnique({
      where: { tenantId: request.tenant.id },
      include: {
        // Never return OAuth client secrets to the browser
        providers: { omit: { clientSecret: true } },
      },
    });

    if (!config) {
      throw new AppError('Authentication configuration not found', 404);
    }

    // The address to register with identity providers
    return { ...config, ssoRedirectUri: ssoRedirectUri() };
  });

  // Update auth config
  fastify.patch('/', {
    config: { permission: 'auth:manage' },
    schema: {
      tags: ['auth-config'],
      summary: 'Update authentication configuration',
      body: {
        type: 'object',
        properties: {
          mfaEnabled: { type: 'boolean' },
          sessionTimeout: { type: 'integer', minimum: 5, maximum: 1440 },
          maxSessionHours: { type: 'integer', minimum: 1, maximum: 720 },
          passwordPolicy: { type: 'string', enum: ['STANDARD', 'STRONG', 'VERY_STRONG'] },
          ssoOnly: { type: 'boolean' },
          otpEnabled: { type: 'boolean' },
          otpExpiry: { type: 'integer', minimum: 1, maximum: 60 },
        },
      },
    },
  }, async (request, reply) => {

    const data = updateAuthConfigSchema.parse(request.body);

    const before = await request.db.authConfig.findUnique({ where: { tenantId: request.tenant.id } });
    const config = await request.db.authConfig.update({
      where: { tenantId: request.tenant.id },
      data,
    });

    await logActivity({
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'updated authentication configuration',
        target: 'auth',
        type: 'CONFIG',
        metadata: data,
      });
    await audit(request, 'auth_config.updated', { resource: { type: 'auth_config', label: 'Sign-in settings' }, changes: diff(before, data) });

    return config;
  });

  // List auth providers
  fastify.get('/providers', {
    config: { permission: 'auth:read' },
    schema: {
      tags: ['auth-config'],
      summary: 'List authentication providers for current tenant',
    },
  }, async (request, reply) => {
    const config = await request.db.authConfig.findUnique({
      where: { tenantId: request.tenant.id },
      include: {
        // Never return OAuth client secrets to the browser
        providers: { omit: { clientSecret: true } },
      },
    });

    return config?.providers || [];
  });

  // Add auth provider
  fastify.post('/providers', {
    config: { permission: 'auth:manage' },
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
          clientSecret: { type: 'string' },
          directoryId: { type: 'string' },
          domain: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' } },
          autoProvision: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {

    const data = createAuthProviderSchema.parse(request.body);

    const config = await request.db.authConfig.findUnique({
      where: { tenantId: request.tenant.id },
    });

    if (!config) {
      throw new AppError('Authentication configuration not found', 404);
    }

    // Check if provider already exists
    const existing = await request.db.authProvider.findFirst({
      where: {
        authConfigId: config.id,
        provider: data.provider,
      },
    });

    if (existing) {
      throw new AppError('Provider already exists', 409);
    }

    const { directoryId, ...fields } = data;
    const provider = await request.db.authProvider.create({
      data: {
        ...fields,
        idpTenantId: directoryId,
        tenantId: request.tenant.id,
        authConfigId: config.id,
      },
      omit: { clientSecret: true },
    });

    await logActivity({
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'added authentication provider',
        target: data.provider,
        type: 'AUTH',
      });
    await audit(request, 'auth_provider.added', { resource: { type: 'auth_provider', id: provider.id, label: provider.provider }, details: { ...data, clientSecret: data.clientSecret ? '[set]' : undefined } });

    return reply.status(201).send(provider);
  });

  // Update auth provider
  fastify.patch('/providers/:id', {
    config: { permission: 'auth:manage' },
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
          clientSecret: { type: 'string' },
          directoryId: { type: 'string' },
          domain: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' } },
          autoProvision: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {

    const { id } = request.params as { id: string };
    const data = updateAuthProviderSchema.parse(request.body);

    // Scoped to the caller's tenant: another tenant's provider is a 404
    const { directoryId, ...fields } = data;
    const before = await request.db.authProvider.findFirst({ where: { id, tenantId: request.tenant.id }, omit: { clientSecret: true } });
    const provider = await request.db.authProvider.update({
      where: { id, tenantId: request.tenant.id },
      data: { ...fields, ...(directoryId !== undefined && { idpTenantId: directoryId }) },
      omit: { clientSecret: true },
    });

    await logActivity({
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'updated authentication provider',
        target: provider.provider,
        type: 'AUTH',
        metadata: { ...data, clientSecret: data.clientSecret ? '[redacted]' : undefined }, // never log secrets
      });
    await audit(request, 'auth_provider.updated', {
      resource: { type: 'auth_provider', id: provider.id, label: provider.provider },
      changes: {
        ...diff(before, { ...fields, ...(directoryId !== undefined && { idpTenantId: directoryId }) }, ['enabled', 'clientId', 'idpTenantId', 'domain', 'scopes', 'autoProvision']),
        ...(data.clientSecret && { clientSecret: ['[redacted]', '[changed]'] }),
      },
    });

    return provider;
  });

  // Delete auth provider
  fastify.delete('/providers/:id', {
    config: { permission: 'auth:manage' },
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

    const { id } = request.params as { id: string };

    const removed = await request.db.authProvider.delete({
      where: { id, authConfig: { tenantId: request.tenant.id } },
      select: { id: true, provider: true, clientId: true },
    });
    await audit(request, 'auth_provider.removed', { resource: { type: 'auth_provider', id: removed.id, label: removed.provider }, details: { clientId: removed.clientId } });

    return reply.status(204).send();
  });

  // Get available providers info
  fastify.get('/available-providers', {
    config: { permission: 'auth:read' },
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
