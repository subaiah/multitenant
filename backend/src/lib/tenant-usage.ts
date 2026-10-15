/**
 * Per-tenant usage snapshots for platform pages (tenant list, platform
 * dashboard). Tenant data lives in many databases and schemas, so platform
 * pages read these control-plane snapshots instead of querying every tenant;
 * they may lag by up to TENANT_USAGE_REFRESH_MS.
 *
 * A refresh reads each target once, as the platform role (which bypasses
 * row-level security), and covers every READY tenant on it.
 */
import { config } from '../config/env.js';
import { controlDb } from './prisma.js';
import { platformDb, targetOf, describeTarget, type Target } from './tenant-targets.js';
import type { DayCount } from './stats.js';

const DAYS = 14;
const RECENT = 5;

export interface RecentActivity {
  id: string;
  action: string;
  target: string;
  type: string;
  user: string;
  timestamp: string;
}

/** Refresh the snapshots of these tenants (default: every READY tenant). */
export async function refreshTenantUsage(tenantIds?: string[]): Promise<{ refreshed: number; failed: string[] }> {
  const configs = await controlDb.databaseConfig.findMany({
    where: { tenant: { provisioningStatus: 'READY' }, dbRoleName: { not: null }, ...(tenantIds && { tenantId: { in: tenantIds } }) },
    select: { tenantId: true, strategy: true, schemaName: true, databaseName: true },
  });
  const byTarget = new Map<string, { target: Target; ids: string[] }>();
  for (const c of configs) {
    const target = targetOf(c);
    const key = describeTarget(target);
    if (!byTarget.has(key)) byTarget.set(key, { target, ids: [] });
    byTarget.get(key)!.ids.push(c.tenantId);
  }

  let refreshed = 0;
  const failed: string[] = [];
  for (const { target, ids } of byTarget.values()) {
    try {
      refreshed += await refreshTarget(target, ids);
    } catch (err) {
      failed.push(`${describeTarget(target)}: ${(err as Error).message}`);
    }
  }
  return { refreshed, failed };
}

async function refreshTarget(target: Target, ids: string[]): Promise<number> {
  const db = platformDb(target);
  const where = { tenantId: { in: ids } };
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (DAYS - 1));

  const [users, apps, lastActive, recentRows, dayRows] = await Promise.all([
    db.user.groupBy({ by: ['tenantId'], where, _count: true }),
    db.application.groupBy({ by: ['tenantId', 'status'], where, _count: true }),
    db.activity.groupBy({ by: ['tenantId'], where, _max: { createdAt: true } }),
    // The latest few entries of each tenant
    Promise.all(ids.map((tenantId) => db.activity.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: RECENT }))),
    db.activity.findMany({ where: { ...where, createdAt: { gte: start } }, select: { tenantId: true, createdAt: true } }),
  ]);

  // Names of the people in recent activity: tenant users on this target, or platform staff
  const recent = recentRows.flat();
  const userIds = [...new Set(recent.map((a) => a.userId).filter((u): u is string => !!u))];
  const select = { id: true, name: true, email: true } as const;
  const [tenantUsers, platformUsers] = userIds.length
    ? await Promise.all([db.user.findMany({ where: { id: { in: userIds } }, select }), controlDb.platformUser.findMany({ where: { id: { in: userIds } }, select })])
    : [[], []];
  const names = new Map([...tenantUsers, ...platformUsers].map((u) => [u.id, u.name || u.email]));

  const days = (tenantId: string): DayCount[] => {
    const counts = new Map<string, number>();
    for (const r of dayRows) {
      if (r.tenantId !== tenantId) continue;
      const day = r.createdAt.toISOString().slice(0, 10);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return Array.from({ length: DAYS }, (_, i) => {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      const date = d.toISOString().slice(0, 10);
      return { date, count: counts.get(date) ?? 0 };
    });
  };

  const now = new Date();
  for (const tenantId of ids) {
    const appsByStatus: Record<string, number> = {};
    for (const a of apps) if (a.tenantId === tenantId) appsByStatus[a.status] = a._count;
    const recentActivity: RecentActivity[] = recent
      .filter((a) => a.tenantId === tenantId)
      .map((a) => ({
        id: a.id,
        action: a.action,
        target: a.target,
        type: a.type,
        user: (a.userId && names.get(a.userId)) || 'System',
        timestamp: a.createdAt.toISOString(),
      }));
    const data = {
      users: users.find((u) => u.tenantId === tenantId)?._count ?? 0,
      applications: Object.values(appsByStatus).reduce((a, b) => a + b, 0),
      appsByStatus,
      lastActiveAt: lastActive.find((l) => l.tenantId === tenantId)?._max.createdAt ?? null,
      activityByDay: days(tenantId) as unknown as object,
      recentActivity: recentActivity as unknown as object,
      refreshedAt: now,
    };
    await controlDb.tenantUsage.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
  }
  return ids.length;
}

let timer: NodeJS.Timeout | undefined;

/** Refresh every TENANT_USAGE_REFRESH_MS (and once shortly after start), running onTick first. */
export function startUsageRefresh(log: (msg: string) => void = () => {}, onTick?: () => Promise<void>) {
  if (timer || config.tenantUsageRefreshMs <= 0) return;
  const run = () =>
    (onTick?.() ?? Promise.resolve())
      .catch((err) => log(`background job failed: ${(err as Error).message}`))
      .then(() => refreshTenantUsage())
      .then(({ failed }) => failed.forEach((f) => log(`usage refresh failed for ${f}`)))
      .catch((err) => log(`usage refresh failed: ${(err as Error).message}`));
  setTimeout(run, 2_000).unref();
  timer = setInterval(run, config.tenantUsageRefreshMs);
  timer.unref();
}

export function stopUsageRefresh() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
