import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { isPlatformUser } from '../utils/authorization.js';
import { withActivityUsers } from '../lib/activity-users.js';
import { activityByDay, countBy } from '../lib/stats.js';

/** Platform-portal data: cross-tenant statistics and platform users. */
export const platformRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    if (!isPlatformUser(request.user.userType)) {
      throw new AppError('Platform access required', 403);
    }
  });

  fastify.get('/stats', {
    config: { permission: 'platform:read' },
    schema: { tags: ['platform'], summary: 'Cross-tenant statistics for the platform dashboard' },
  }, async () => {
    const [byStatus, byPlan, tenantUsers, platformUsers, appsByStatus, recent, topTenants, perDay] = await Promise.all([
      prisma.tenant.groupBy({ by: ['status'], _count: true }),
      prisma.tenant.groupBy({ by: ['plan'], _count: true }),
      prisma.user.count({ where: { tenantId: { not: null } } }),
      prisma.user.count({ where: { tenantId: null } }),
      prisma.application.groupBy({ by: ['status'], _count: true }),
      prisma.activity
        .findMany({ take: 8, orderBy: { createdAt: 'desc' }, include: { tenant: { select: { name: true } } } })
        .then(withActivityUsers),
      prisma.tenant.findMany({
        take: 5,
        orderBy: { users: { _count: 'desc' } },
        select: {
          id: true, name: true, slug: true, plan: true, status: true,
          _count: { select: { users: true, applications: true } },
        },
      }),
      activityByDay(undefined, 14),
    ]);

    const tenantStatus = countBy(byStatus, 'status');
    const apps = countBy(appsByStatus, 'status');
    return {
      tenants: {
        total: Object.values(tenantStatus).reduce((a, b) => a + b, 0),
        byStatus: tenantStatus,
        byPlan: countBy(byPlan, 'plan'),
      },
      users: { tenant: tenantUsers, platform: platformUsers },
      applications: { total: Object.values(apps).reduce((a, b) => a + b, 0), byStatus: apps },
      activityByDay: perDay,
      recentActivity: recent.map((a) => ({
        id: a.id,
        action: a.action,
        target: a.target,
        type: a.type,
        tenant: a.tenant?.name ?? 'Platform',
        user: a.user?.name || a.user?.email || 'System',
        timestamp: a.createdAt,
      })),
      topTenants: topTenants.map(({ _count, ...t }) => ({ ...t, users: _count.users, applications: _count.applications })),
    };
  });

  fastify.get('/users', {
    config: { permission: 'platform-users:read' },
    schema: { tags: ['platform'], summary: 'List platform users (users without a tenant)' },
  }, async () => {
    const users = await prisma.user.findMany({
      where: { tenantId: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, name: true, userType: true, status: true, lastLoginAt: true, createdAt: true },
    });
    return { users };
  });
};
