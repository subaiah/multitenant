import { FastifyPluginAsync } from 'fastify';
import { controlDb } from '../lib/prisma.js';
import type { DayCount } from '../lib/stats.js';
import type { RecentActivity } from '../lib/tenant-usage.js';
import { AppError } from '../middleware/error-handler.js';
import { isPlatformUser } from '../utils/authorization.js';
import { countBy } from '../lib/stats.js';
import { latestMigration, startRollout, tenantsBehind } from '../lib/tenant-migrations.js';
import { logPlatformActivity } from '../lib/activity.js';
import { audit } from '../lib/audit.js';
import { resetTwoFactor } from './two-factor.js';
import { describeMailError, emailSetup, sendMail } from '../lib/mailer.js';
import { testEmail } from '../lib/email-templates.js';

/** Platform-portal data: cross-tenant statistics and platform users. */
export const platformRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    if (!isPlatformUser(request.user.userType)) {
      throw new AppError('Platform access required', 403);
    }
  });

  // Where the platform's email goes (no password), and a test message to yourself
  fastify.get('/email', {
    config: { permission: 'platform-settings:manage' },
    schema: { tags: ['platform'], summary: 'How email is sent (SMTP host, sender; never the password)' },
  }, async () => emailSetup());

  fastify.post('/email/test', {
    config: { permission: 'platform-settings:manage', rateLimit: { max: 5, timeWindow: '15 minutes' } },
    schema: { tags: ['platform'], summary: 'Send a test email to yourself' },
  }, async (request) => {
    const me = await controlDb.platformUser.findUniqueOrThrow({ where: { id: request.user.userId }, select: { email: true } });
    try {
      await sendMail(testEmail(me.email, emailSetup().from));
    } catch (err) {
      return { sent: false, to: me.email, error: describeMailError(err) };
    }
    await audit(request, 'platform.test_email_sent', { details: { to: me.email } });
    return { sent: true, to: me.email };
  });

  fastify.get('/stats', {
    config: { permission: 'platform:read' },
    schema: { tags: ['platform'], summary: 'Cross-tenant statistics for the platform dashboard' },
  }, async () => {
    const [byStatus, byPlan, byProvisioning, tenants, platformUsers, platformRecent] = await Promise.all([
      controlDb.tenant.groupBy({ by: ['status'], _count: true }),
      controlDb.tenant.groupBy({ by: ['plan'], _count: true }),
      controlDb.tenant.groupBy({ by: ['provisioningStatus'], _count: true }),
      controlDb.tenant.findMany({
        select: { id: true, name: true, slug: true, plan: true, status: true, usage: true },
      }),
      controlDb.platformUser.count(),
      controlDb.platformActivity.findMany({ take: 8, orderBy: { createdAt: 'desc' } }),
    ]);

    // Tenant figures come from the usage snapshots (lib/tenant-usage.ts), which
    // lag by up to a few minutes, instead of querying every tenant database
    const apps: Record<string, number> = {};
    const perDay = new Map<string, number>();
    const recent: (RecentActivity & { tenant: string })[] = [];
    let tenantUsers = 0;
    let oldestSnapshot: Date | null = null;
    for (const t of tenants) {
      if (!t.usage) continue;
      tenantUsers += t.usage.users;
      for (const [k, v] of Object.entries(t.usage.appsByStatus as Record<string, number>)) apps[k] = (apps[k] ?? 0) + v;
      for (const d of t.usage.activityByDay as unknown as DayCount[]) perDay.set(d.date, (perDay.get(d.date) ?? 0) + d.count);
      for (const a of t.usage.recentActivity as unknown as RecentActivity[]) recent.push({ ...a, tenant: t.name });
      if (!oldestSnapshot || t.usage.refreshedAt < oldestSnapshot) oldestSnapshot = t.usage.refreshedAt;
    }

    // Platform-level actions, with names of the platform staff behind them
    const staffIds = [...new Set(platformRecent.map((a) => a.userId).filter((u): u is string => !!u))];
    const staff = new Map(
      (await controlDb.platformUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name || u.email]),
    );
    const tenantName = new Map(tenants.map((t) => [t.id, t.name]));
    for (const a of platformRecent) {
      recent.push({
        id: a.id, action: a.action, target: a.target, type: a.type,
        user: (a.userId && staff.get(a.userId)) || 'System',
        timestamp: a.createdAt.toISOString(),
        tenant: (a.tenantId && tenantName.get(a.tenantId)) || 'Platform',
      });
    }

    const tenantStatus = countBy(byStatus, 'status');
    return {
      tenants: {
        total: Object.values(tenantStatus).reduce((a, b) => a + b, 0),
        byStatus: tenantStatus,
        byPlan: countBy(byPlan, 'plan'),
        byProvisioning: countBy(byProvisioning, 'provisioningStatus'),
      },
      users: { tenant: tenantUsers, platform: platformUsers },
      applications: { total: Object.values(apps).reduce((a, b) => a + b, 0), byStatus: apps },
      // The last 14 days (a snapshot taken yesterday also covers a day before them)
      activityByDay: Array.from({ length: 14 }, (_, i) => {
        const date = new Date(Date.now() - (13 - i) * 86_400_000).toISOString().slice(0, 10);
        return { date, count: perDay.get(date) ?? 0 };
      }),
      recentActivity: recent.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 8),
      topTenants: tenants
        .map(({ usage, ...t }) => ({ ...t, users: usage?.users ?? 0, applications: usage?.applications ?? 0 }))
        .sort((a, b) => b.users - a.users)
        .slice(0, 5),
      usageAsOf: oldestSnapshot,
    };
  });

  // Apply pending tenant migrations everywhere (what `npm run tenant:migrate` does)
  fastify.post('/tenant-migrations', {
    config: { permission: 'tenants:manage' },
    schema: { tags: ['platform'], summary: 'Run tenant migrations on every tenant database and schema' },
  }, async (request) => {
    const run = startRollout();
    if (!run) throw new AppError('Tenant migrations are already running', 409);
    const report = await run;
    await logPlatformActivity({
      userId: request.user.userId,
      action: 'ran tenant migrations',
      target: latestMigration() ?? 'no migrations',
      type: report.failed.length ? 'ALERT' : 'DEPLOY',
      metadata: { succeeded: report.succeeded.length, failed: report.failed.map((f) => f.target) },
    });
    await audit(request, 'tenant.migrations_run', { details: { latest: latestMigration(), succeeded: report.succeeded.length, failed: report.failed.map((f) => f.target) } });
    return { ...report, latest: latestMigration(), tenantsBehind: await tenantsBehind() };
  });

  fastify.get('/users', {
    config: { permission: 'platform-users:read' },
    schema: { tags: ['platform'], summary: 'List platform users' },
  }, async () => {
    const users = await controlDb.platformUser.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, email: true, name: true, userType: true, status: true, lastLoginAt: true, createdAt: true, mfaEnabledAt: true,
        platformRoles: { select: { role: { select: { id: true, name: true } } } },
      },
    });
    return {
      users: users.map(({ mfaEnabledAt, platformRoles, ...u }) => ({ ...u, mfaEnabled: Boolean(mfaEnabledAt), roles: platformRoles.map((r) => r.role) })),
    };
  });

  // Clear a platform user's two-factor (lost device)
  fastify.post('/users/:id/mfa/reset', {
    config: { permission: 'platform-settings:manage' },
    schema: {
      tags: ['platform'],
      summary: "Reset a platform user's two-factor sign-in",
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await controlDb.platformUser.findUnique({ where: { id }, select: { id: true, email: true } });
    if (!user) throw new AppError('User not found', 404);
    await resetTwoFactor('platform', user.id);
    await logPlatformActivity({ userId: request.user.userId, action: `reset two-factor for ${user.email}`, target: 'user', type: 'USER' });
    await audit(request, 'platform_user.mfa_reset', { resource: { type: 'platform_user', id: user.id, label: user.email } });
    return { mfaEnabled: false };
  });
};
