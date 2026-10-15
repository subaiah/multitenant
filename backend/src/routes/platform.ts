import { FastifyPluginAsync } from 'fastify';
import { controlDb, tenantDb } from '../lib/prisma.js';
import { countTenantData, groupByDatabase } from '../lib/tenant-data.js';
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
    const [byStatus, byPlan, tenants, platformUsers, platformRecent] = await Promise.all([
      controlDb.tenant.groupBy({ by: ['status'], _count: true }),
      controlDb.tenant.groupBy({ by: ['plan'], _count: true }),
      controlDb.tenant.findMany({ select: { id: true, name: true, slug: true, plan: true, status: true } }),
      controlDb.platformUser.count(),
      controlDb.platformActivity.findMany({ take: 8, orderBy: { createdAt: 'desc' } }),
    ]);
    const tenantName = new Map(tenants.map((t) => [t.id, t.name]));

    // Tenant-plane figures, read from each tenant database. Fine while tenants
    // share a few databases; with many databases this moves to a periodic job.
    const counts = await countTenantData(tenants.map((t) => t.id));
    const apps: Record<string, number> = {};
    const perDayTotals = new Map<string, number>();
    type RecentRow = { id: string; action: string; target: string; type: string; tenantId: string | null; createdAt: Date; user: { name: string | null; email: string } | null };
    const tenantRecent: RecentRow[] = [];
    for (const [db, ids] of groupByDatabase(tenants.map((t) => t.id))) {
      const [appsByStatus, recent, perDay] = await Promise.all([
        db.application.groupBy({ by: ['status'], where: { tenantId: { in: ids } }, _count: true }),
        db.activity.findMany({ where: { tenantId: { in: ids } }, take: 8, orderBy: { createdAt: 'desc' } }).then((r) => withActivityUsers(db, r)),
        activityByDay(db, undefined, 14),
      ]);
      for (const [k, v] of Object.entries(countBy(appsByStatus, 'status'))) apps[k] = (apps[k] ?? 0) + v;
      for (const d of perDay) perDayTotals.set(d.date, (perDayTotals.get(d.date) ?? 0) + d.count);
      tenantRecent.push(...recent);
    }
    const platformRecentWithUsers = await withActivityUsers(tenantDb, platformRecent);
    const recentActivity = [...tenantRecent, ...(platformRecentWithUsers as RecentRow[])]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 8);

    const tenantStatus = countBy(byStatus, 'status');
    const tenantUsers = [...counts.values()].reduce((sum, c) => sum + c.users, 0);
    return {
      tenants: {
        total: Object.values(tenantStatus).reduce((a, b) => a + b, 0),
        byStatus: tenantStatus,
        byPlan: countBy(byPlan, 'plan'),
      },
      users: { tenant: tenantUsers, platform: platformUsers },
      applications: { total: Object.values(apps).reduce((a, b) => a + b, 0), byStatus: apps },
      activityByDay: [...perDayTotals].map(([date, count]) => ({ date, count })),
      recentActivity: recentActivity.map((a) => ({
        id: a.id,
        action: a.action,
        target: a.target,
        type: a.type,
        tenant: (a.tenantId && tenantName.get(a.tenantId)) || 'Platform',
        user: a.user?.name || a.user?.email || 'System',
        timestamp: a.createdAt,
      })),
      topTenants: tenants
        .map((t) => ({ ...t, users: counts.get(t.id)!.users, applications: counts.get(t.id)!.applications }))
        .sort((a, b) => b.users - a.users)
        .slice(0, 5),
    };
  });

  fastify.get('/users', {
    config: { permission: 'platform-users:read' },
    schema: { tags: ['platform'], summary: 'List platform users' },
  }, async () => {
    const users = await controlDb.platformUser.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, name: true, userType: true, status: true, lastLoginAt: true, createdAt: true },
    });
    return { users };
  });
};
