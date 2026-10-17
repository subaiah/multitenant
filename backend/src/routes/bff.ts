import { FastifyPluginAsync } from 'fastify';
import { controlDb } from '../lib/prisma.js';
import { withActivityUsers } from '../lib/activity-users.js';
import { activityByDay, countBy } from '../lib/stats.js';
import { config } from '../config/env.js';

/**
 * Aggregations for the frontend (Backend for Frontend): one call per screen
 * instead of several. Sign-in and sessions are in bff-auth.ts.
 */
export const bffRoutes: FastifyPluginAsync = async (fastify) => {
  // Dashboard aggregation endpoint
  // Combines multiple API calls into one
  fastify.get('/dashboard', {
    config: { permission: 'dashboard:view' },
    schema: {
      tags: ['bff'],
      summary: 'Get aggregated dashboard data',
      description: 'Aggregates tenant info, app stats, and recent activities',
    },
  }, async (request, reply) => {
    const tenantId = request.tenant.id;
    const db = request.db;

    // Aggregate multiple queries in parallel
    const [tenant, appStats, recentActivities, userCount, appsByEnv, groupCount, orgCount, entitledApps, perDay, activityTypes] = await Promise.all([
      // Get tenant info
      controlDb.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          name: true,
          plan: true,
          status: true,
        },
      }),
      // Deployed applications are sample data until something reports real
      // deployments (PREVIEW_FEATURES)
      config.previewFeatures ? db.application.groupBy({ by: ['status'], where: { tenantId }, _count: true }) : null,
      // Get recent activities
      db.activity.findMany({
        where: { tenantId },
        take: 8,
        orderBy: { createdAt: 'desc' },
      }).then((rows) => withActivityUsers(db, rows)),
      // Get user count
      db.user.count({
        where: { tenantId },
      }),
      config.previewFeatures ? db.application.groupBy({ by: ['environment'], where: { tenantId }, _count: true }) : null,
      db.group.count({ where: { tenantId } }),
      db.organization.count({ where: { tenantId } }),
      controlDb.tenantApplication.count({ where: { tenantId } }),
      activityByDay(db, tenantId, 14),
      db.activity.groupBy({ by: ['type'], where: { tenantId }, _count: true }),
    ]);

    // Transform data for frontend
    return {
      tenant: {
        name: tenant?.name,
        plan: tenant?.plan,
        status: tenant?.status,
      },
      applications: appStats && {
        total: appStats.reduce((sum, stat) => sum + stat._count, 0),
        byStatus: countBy(appStats, 'status'),
      },
      users: {
        total: userCount,
      },
      applicationsByEnvironment: appsByEnv && countBy(appsByEnv, 'environment'),
      counts: { groups: groupCount, organizations: orgCount, entitledApplications: entitledApps },
      activityByDay: perDay,
      activityByType: countBy(activityTypes, 'type'),
      recentActivities: recentActivities.map((activity) => ({
        id: activity.id,
        action: activity.action,
        target: activity.target,
        type: activity.type,
        user: activity.user?.name || activity.user?.email || 'System',
        timestamp: activity.createdAt,
      })),
    };
  });
};
