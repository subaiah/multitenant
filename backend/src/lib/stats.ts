import { Prisma } from '../generated/tenant/index.js';
import type { TenantDb } from './tenant-db.js';

export interface DayCount {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
}

/**
 * Activity counts per UTC day for the last `days` days, oldest first,
 * with zero-filled gaps. Scoped to one tenant, or every tenant in `db` when omitted.
 */
export async function activityByDay(db: TenantDb, tenantId: string | undefined, days = 14): Promise<DayCount[]> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));

  // Prisma stores UTC in timestamp columns; format in SQL so the server's
  // local timezone can't shift days when parsing.
  const rows = await db.$queryRaw<{ day: string; count: bigint }[]>`
    SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*) AS count
    FROM activities
    WHERE created_at >= ${start}
      ${tenantId ? Prisma.sql`AND tenant_id = ${tenantId}` : Prisma.empty}
    GROUP BY 1
  `;
  const byDay = new Map(rows.map((r) => [r.day, Number(r.count)]));

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
