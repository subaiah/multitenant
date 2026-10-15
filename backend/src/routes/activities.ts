import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { withActivityUsers } from '../lib/activity-users.js';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).default(20),
  type: z.enum(['DEPLOY', 'CONFIG', 'USER', 'BILLING', 'ALERT', 'AUTH', 'API']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  search: z.string().optional(),
});

export const activityRoutes: FastifyPluginAsync = async (fastify) => {
  // List activities for current tenant
  fastify.get('/', {
    config: { permission: 'activity:read' },
    schema: {
      tags: ['activities'],
      summary: 'List activities for current tenant',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', default: '1' },
          limit: { type: 'string', default: '20' },
          type: { type: 'string', enum: ['DEPLOY', 'CONFIG', 'USER', 'BILLING', 'ALERT', 'AUTH', 'API'] },
          startDate: { type: 'string', format: 'date-time' },
          search: { type: 'string' },
          endDate: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request, reply) => {
    const { page, limit, type, startDate, endDate, search } = querySchema.parse(request.query);
    const skip = (page - 1) * limit;

    const where = {
      tenantId: request.tenant.id,
      AND: [
        type ? { type } : {},
        search
          ? {
              OR: [
                { action: { contains: search, mode: 'insensitive' as const } },
                { target: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {},
        startDate || endDate
          ? {
              createdAt: {
                gte: startDate ? new Date(startDate) : undefined,
                lte: endDate ? new Date(endDate) : undefined,
              },
            }
          : {},
      ],
    };

    const [activities, total] = await Promise.all([
      request.db.activity.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }).then((rows) => withActivityUsers(request.db, rows)),
      request.db.activity.count({ where }),
    ]);

    return {
      data: activities,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  });

  // Get activity statistics
  fastify.get('/stats', {
    config: { permission: 'activity:read' },
    schema: {
      tags: ['activities'],
      summary: 'Get activity statistics',
    },
  }, async (request, reply) => {
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const last7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [totalActivities, last24hActivities, last7dActivities, byType] = await Promise.all([
      request.db.activity.count({
        where: { tenantId: request.tenant.id },
      }),
      request.db.activity.count({
        where: {
          tenantId: request.tenant.id,
          createdAt: { gte: last24Hours },
        },
      }),
      request.db.activity.count({
        where: {
          tenantId: request.tenant.id,
          createdAt: { gte: last7Days },
        },
      }),
      request.db.activity.groupBy({
        by: ['type'],
        where: { tenantId: request.tenant.id },
        _count: true,
      }),
    ]);

    return {
      total: totalActivities,
      last24Hours: last24hActivities,
      last7Days: last7dActivities,
      byType: byType.reduce((acc, item) => {
        acc[item.type] = item._count;
        return acc;
      }, {} as Record<string, number>),
    };
  });
};
