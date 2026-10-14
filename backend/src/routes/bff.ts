import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma.js';

/**
 * BFF (Backend for Frontend) Routes
 * 
 * This demonstrates the BFF pattern where:
 * 1. Frontend never stores sensitive tokens
 * 2. BFF handles token refresh and management
 * 3. BFF aggregates multiple API calls
 * 4. BFF injects tenant context
 */
export const bffRoutes: FastifyPluginAsync = async (fastify) => {
  // Dashboard aggregation endpoint
  // Combines multiple API calls into one
  fastify.get('/dashboard', {
    schema: {
      tags: ['bff'],
      summary: 'Get aggregated dashboard data',
      description: 'Aggregates tenant info, app stats, and recent activities',
    },
  }, async (request, reply) => {
    const tenantId = request.tenant.id;

    // Aggregate multiple queries in parallel
    const [tenant, appStats, recentActivities, userCount] = await Promise.all([
      // Get tenant info
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          name: true,
          plan: true,
          status: true,
        },
      }),
      // Get application statistics
      prisma.application.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: true,
      }),
      // Get recent activities
      prisma.activity.findMany({
        where: { tenantId },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              name: true,
              email: true,
            },
          },
        },
      }),
      // Get user count
      prisma.user.count({
        where: { tenantId },
      }),
    ]);

    // Transform data for frontend
    return {
      tenant: {
        name: tenant?.name,
        plan: tenant?.plan,
        status: tenant?.status,
      },
      applications: {
        total: appStats.reduce((sum, stat) => sum + stat._count, 0),
        byStatus: appStats.reduce((acc, stat) => {
          acc[stat.status] = stat._count;
          return acc;
        }, {} as Record<string, number>),
      },
      users: {
        total: userCount,
      },
      recentActivities: recentActivities.map((activity) => ({
        id: activity.id,
        action: activity.action,
        target: activity.target,
        type: activity.type,
        user: activity.user?.name || 'System',
        timestamp: activity.createdAt,
      })),
    };
  });

  // Token exchange endpoint
  // Frontend sends BFF token, gets backend service token
  fastify.post('/token/exchange', {
    schema: {
      tags: ['bff'],
      summary: 'Exchange BFF token for backend service token',
      description: 'Securely exchange tokens without exposing credentials to frontend',
      body: {
        type: 'object',
        required: ['service'],
        properties: {
          service: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { service } = request.body as { service: string };

    // In a real implementation, this would:
    // 1. Validate the BFF token (already done by JWT middleware)
    // 2. Fetch a service-specific token from the identity provider
    // 3. Return the service token to the frontend

    // For demo purposes, we'll just return a mock token
    const serviceToken = fastify.jwt.sign({
      userId: request.user.userId,
      tenantId: request.tenant.id,
      service,
      scope: `${service}:read ${service}:write`,
      expiresIn: '1h',
    });

    return {
      token: serviceToken,
      expiresIn: 3600,
      service,
    };
  });

  // Multi-tenant data aggregation
  // Example: Get data from multiple services for a specific tenant
  fastify.get('/tenant/:tenantId/data', {
    schema: {
      tags: ['bff'],
      summary: 'Get aggregated data for a specific tenant',
      description: 'Admin-only endpoint to aggregate data across services',
      params: {
        type: 'object',
        required: ['tenantId'],
        properties: {
          tenantId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    // Only admins can access this
    if (request.user.role !== 'ADMIN') {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const { tenantId } = request.params;

    // Aggregate data from multiple sources
    const [tenant, applications, users, activities, dbConfig, authConfig, apiConfig] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: tenantId },
      }),
      prisma.application.findMany({
        where: { tenantId },
      }),
      prisma.user.findMany({
        where: { tenantId },
      }),
      prisma.activity.findMany({
        where: { tenantId },
        take: 10,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.databaseConfig.findUnique({
        where: { tenantId },
      }),
      prisma.authConfig.findUnique({
        where: { tenantId },
        include: { providers: true },
      }),
      prisma.apiConfig.findUnique({
        where: { tenantId },
      }),
    ]);

    return {
      tenant,
      summary: {
        applications: applications.length,
        users: users.length,
        activities: activities.length,
      },
      configurations: {
        database: dbConfig,
        authentication: authConfig,
        api: apiConfig,
      },
      applications: applications.slice(0, 5), // Limit for response size
      recentActivities: activities,
    };
  });

  // Health check with tenant context
  fastify.get('/health', {
    schema: {
      tags: ['bff'],
      summary: 'BFF health check with tenant context',
    },
  }, async (request, reply) => {
    return {
      status: 'ok',
      tenant: {
        id: request.tenant.id,
        name: request.tenant.name,
        plan: request.tenant.plan,
      },
      user: {
        id: request.user.userId,
        role: request.user.role,
      },
      timestamp: new Date().toISOString(),
    };
  });

  // API aggregation example
  // Combines multiple endpoints into one call
  fastify.get('/apps/:appId/overview', {
    schema: {
      tags: ['bff'],
      summary: 'Get application overview with aggregated data',
      params: {
        type: 'object',
        required: ['appId'],
        properties: {
          appId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { appId } = request.params;
    const tenantId = request.tenant.id;

    // Get application details
    const application = await prisma.application.findFirst({
      where: {
        id: appId,
        tenantId,
      },
    });

    if (!application) {
      return reply.status(404).send({ error: 'Application not found' });
    }

    // Get related activities
    const activities = await prisma.activity.findMany({
      where: {
        tenantId,
        target: application.name,
      },
      take: 10,
      orderBy: { createdAt: 'desc' },
    });

    // Get deployment history (simulated)
    const deployments = activities
      .filter((a) => a.type === 'DEPLOY')
      .slice(0, 5);

    return {
      application,
      metrics: {
        cpu: application.cpu,
        memory: application.memory,
        requests: application.requests,
      },
      deployments,
      recentActivities: activities.slice(0, 5),
    };
  });
};
