import type { TenantDb } from './tenant-db.js';

export interface DayCount {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
}

/**
 * Activity counts per UTC day for the last `days` days, oldest first, with
 * zero-filled gaps, for one tenant or (platform role) several. Counted in
 * code rather than SQL so it works the same on every target.
 */
export async function activityByDay(db: TenantDb, tenantIds: string | string[], days = 14): Promise<DayCount[]> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));

  const ids = Array.isArray(tenantIds) ? tenantIds : [tenantIds];
  const rows = await db.activity.findMany({ where: { tenantId: { in: ids }, createdAt: { gte: start } }, select: { createdAt: true } });
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = r.createdAt.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }

  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    return { date, count: byDay.get(date) ?? 0 };
  });
}

/** groupBy result -> { KEY: count } */
export function countBy<K extends string>(rows: { _count: number }[], key: K): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [(r as unknown as Record<K, string>)[key], r._count]));
}
