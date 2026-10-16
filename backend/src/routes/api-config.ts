import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler.js';
import { hasMinimumUserType } from '../utils/authorization.js';
import { logActivity } from '../lib/activity.js';
import { audit, diff } from '../lib/audit.js';

const updateApiConfigSchema = z.object({
  bffEnabled: z.boolean().optional(),
  bffUrl: z.string().url().optional(),
  apiGateway: z.enum(['KONG', 'APIGEE', 'AWS_APIGATEWAY', 'AZURE_APIM', 'CUSTOM']).optional(),
  rateLimit: z.number().min(100).max(100000).optional(),
  corsEnabled: z.boolean().optional(),
  allowedOrigins: z.array(z.string().url()).optional(),
  authType: z.enum(['JWT', 'OAUTH2', 'API_KEY']).optional(),
  versioning: z.enum(['URL', 'HEADER', 'QUERY']).optional(),
});

export const apiConfigRoutes: FastifyPluginAsync = async (fastify) => {
  // Get API config for current tenant
  fastify.get('/', {
    config: { permission: 'api:read' },
    schema: {
      tags: ['api-config'],
      summary: 'Get API configuration for current tenant',
    },
  }, async (request, reply) => {
    const config = await request.db.apiConfig.findUnique({
      where: { tenantId: request.tenant.id },
    });

    if (!config) {
      throw new AppError('API configuration not found', 404);
    }

    return config;
  });

  // Update API config
  fastify.patch('/', {
    config: { permission: 'api:manage' },
    schema: {
      tags: ['api-config'],
      summary: 'Update API configuration',
      body: {
        type: 'object',
        properties: {
          bffEnabled: { type: 'boolean' },
          bffUrl: { type: 'string', format: 'uri' },
          apiGateway: { type: 'string', enum: ['KONG', 'APIGEE', 'AWS_APIGATEWAY', 'AZURE_APIM', 'CUSTOM'] },
          rateLimit: { type: 'number', minimum: 100, maximum: 100000 },
          corsEnabled: { type: 'boolean' },
          allowedOrigins: { type: 'array', items: { type: 'string', format: 'uri' } },
          authType: { type: 'string', enum: ['JWT', 'OAUTH2', 'API_KEY'] },
          versioning: { type: 'string', enum: ['URL', 'HEADER', 'QUERY'] },
        },
      },
    },
  }, async (request, reply) => {

    const data = updateApiConfigSchema.parse(request.body);

    // Validate BFF URL if BFF is enabled
    if (data.bffEnabled && !data.bffUrl) {
      throw new AppError('BFF URL required when BFF is enabled', 400);
    }

    const before = await request.db.apiConfig.findUnique({ where: { tenantId: request.tenant.id } });
    const config = await request.db.apiConfig.update({
      where: { tenantId: request.tenant.id },
      data,
    });

    await logActivity({
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'updated API configuration',
        target: 'api',
        type: 'API',
        metadata: data,
      });
    await audit(request, 'api_config.updated', { resource: { type: 'api_config', label: 'API settings' }, changes: diff(before, data) });

    return config;
  });

  // Get API gateways info
  fastify.get('/gateways', {
    config: { permission: 'api:read' },
    schema: {
      tags: ['api-config'],
      summary: 'Get available API gateways',
    },
  }, async (request, reply) => {
    return [
      {
        id: 'KONG',
        name: 'Kong',
        description: 'Open-source API Gateway and Microservices Management Layer',
        features: ['Rate Limiting', 'Authentication', 'Logging', 'Transformations'],
      },
      {
        id: 'APIGEE',
        name: 'Apigee',
        description: 'Google Cloud API management platform',
        features: ['Analytics', 'Monetization', 'Security', 'Traffic Management'],
      },
      {
        id: 'AWS_APIGATEWAY',
        name: 'AWS API Gateway',
        description: 'Amazon Web Services API management service',
        features: ['Lambda Integration', 'WebSocket APIs', 'Usage Plans', 'Custom Domains'],
      },
      {
        id: 'AZURE_APIM',
        name: 'Azure API Management',
        description: 'Microsoft Azure API management solution',
        features: ['API Analytics', 'Security', 'Developer Portal', 'Multi-Cloud'],
      },
      {
        id: 'CUSTOM',
        name: 'Custom',
        description: 'Custom API gateway implementation',
        features: ['Full Control', 'Custom Logic', 'Self-Hosted'],
      },
    ];
  });

  // Get BFF pattern info
  fastify.get('/bff-info', {
    config: { permission: 'api:read' },
    schema: {
      tags: ['api-config'],
      summary: 'Get BFF pattern information',
    },
  }, async (request, reply) => {
    return {
      name: 'Backend for Frontend (BFF)',
      description: 'The BFF pattern provides a dedicated backend service for each frontend application',
      benefits: [
        'Token Management: Securely store and manage OAuth tokens server-side',
        'API Aggregation: Combine multiple backend calls into single frontend requests',
        'Tenant Isolation: Inject tenant context and enforce data isolation',
        'Security: Keep sensitive credentials server-side',
      ],
      architecture: {
        flow: 'Frontend → BFF → API Gateway → Microservices',
        components: [
          {
            name: 'Frontend',
            description: 'React application that communicates with BFF',
          },
          {
            name: 'BFF',
            description: 'Node.js service that aggregates APIs and manages tokens',
          },
          {
            name: 'API Gateway',
            description: 'Routes requests to appropriate microservices',
          },
          {
            name: 'Microservices',
            description: 'Backend services that handle business logic',
          },
        ],
      },
    };
  });
};
