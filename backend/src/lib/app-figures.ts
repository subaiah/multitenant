/**
 * Real figures for an organization (Deployments and Infrastructure pages),
 * in place of the sample data those pages used to show:
 *
 * - Its applications: whether each is up (the platform's health checks,
 *   lib/product-health.ts), uptime and response times over 1, 7 and 30
 *   days from the checks kept, and what each reported using this month
 *   (usage meters, lib/product-usage.ts). Organizations see no error details.
 * - Its data: how much room it takes, how many rows its main tables hold,
 *   and its open database connections, read as the platform role for
 *   whichever isolation mode it has.
 */
import { controlDb } from './prisma.js';
import { monthOf, usageTotals } from './product-usage.js';
import { targetForTenant } from './tenant-db.js';
import { ident, platformDb, roleNameFor, type Target } from './tenant-targets.js';

const DAY = 86_400_000;

export interface Uptime {
  /** Share of checks answered ok or degraded, 0–1; null without checks */
  uptime: number | null;
  checks: number;
}
export interface HealthFigures {
  day: Uptime & { averageMs: number | null };
  week: Uptime;
  month: Uptime;
}

/** Uptime over the last day, week and 30 days, per application */
export async function healthFigures(applicationIds: string[]): Promise<Map<string, HealthFigures>> {
  const out = new Map<string, HealthFigures>();
  if (!applicationIds.length) return out;
  const rows = await controlDb.$queryRaw<{
    application_id: string; n1: bigint; ok1: bigint; ms1: number | null; n7: bigint; ok7: bigint; n30: bigint; ok30: bigint;
  }[]>`
    SELECT application_id,
      count(*) FILTER (WHERE checked_at > now() - interval '1 day') AS n1,
      count(*) FILTER (WHERE checked_at > now() - interval '1 day' AND outcome <> 'FAILED') AS ok1,
      avg(response_ms) FILTER (WHERE checked_at > now() - interval '1 day')::float8 AS ms1,
      count(*) FILTER (WHERE checked_at > now() - interval '7 days') AS n7,
      count(*) FILTER (WHERE checked_at > now() - interval '7 days' AND outcome <> 'FAILED') AS ok7,
      count(*) AS n30,
      count(*) FILTER (WHERE outcome <> 'FAILED') AS ok30
    FROM application_health_samples
    WHERE application_id = ANY(${applicationIds}) AND checked_at > now() - interval '30 days'
    GROUP BY application_id`;
  const share = (ok: bigint, n: bigint): Uptime => ({ uptime: n > 0n ? Number(ok) / Number(n) : null, checks: Number(n) });
  for (const r of rows) {
    out.set(r.application_id, {
      day: { ...share(r.ok1, r.n1), averageMs: r.ms1 === null ? null : Math.round(r.ms1) },
      week: share(r.ok7, r.n7),
      month: share(r.ok30, r.n30),
    });
  }
  return out;
}

/** Uptime for each of the last `days` days (UTC, oldest first), and the day's average response time */
export async function dailyUptime(applicationId: string, days = 30) {
  const rows = await controlDb.$queryRaw<{ day: Date; n: bigint; ok: bigint; ms: number | null }[]>`
    SELECT date_trunc('day', checked_at AT TIME ZONE 'UTC') AS day, count(*) AS n,
      count(*) FILTER (WHERE outcome <> 'FAILED') AS ok,
      avg(response_ms)::float8 AS ms
    FROM application_health_samples
    WHERE application_id = ${applicationId}
      AND checked_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => ${days - 1})) AT TIME ZONE 'UTC'
    GROUP BY 1 ORDER BY 1`;
  const byDay = new Map(rows.map((r) => [r.day.toISOString().slice(0, 10), r]));
  const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(today - (days - 1 - i) * DAY).toISOString().slice(0, 10);
    const r = byDay.get(day);
    return { day, checks: r ? Number(r.n) : 0, uptime: r && r.n > 0n ? Number(r.ok) / Number(r.n) : null, averageMs: r?.ms == null ? null : Math.round(r.ms) };
  });
}

/** What each application reported using in a month, per meter (this month by default) */
export async function usageFigures(tenantId: string, applicationIds: string[], month?: string) {
  const period = monthOf(month);
  const [meters, totals] = await Promise.all([
    controlDb.productUsageMeter.findMany({ where: { applicationId: { in: applicationIds }, retiredAt: null }, orderBy: { position: 'asc' } }),
    usageTotals({ tenantId }, period.from, period.to),
  ]);
  const out = new Map<string, { month: string; meters: { key: string; label: string; unit: string; total: number; records: number }[] }>();
  for (const id of applicationIds) {
    out.set(id, {
      month: period.month,
      meters: meters.filter((m) => m.applicationId === id).map((m) => {
        const t = totals.find((x) => x.applicationId === id && x.key === m.key);
        return { key: m.key, label: m.label, unit: m.unit, total: t?.total ?? 0, records: t?.records ?? 0 };
      }),
    });
  }
  return out;
}

/** The organization's applications that are on now, with their health, uptime and this month's usage */
export async function applicationFigures(tenantId: string) {
  const now = new Date();
  const rows = await controlDb.tenantApplication.findMany({
    where: { tenantId, state: { in: ['ENABLED', 'TRIAL'] }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }], application: { status: 'ACTIVE' } },
    include: { application: { select: { id: true, key: true, name: true, description: true, healthUrl: true, healthStatus: true, healthVersion: true, healthCheckedAt: true, healthChangedAt: true } } },
    orderBy: { application: { name: 'asc' } },
  });
  const ids = rows.map((r) => r.applicationId);
  const [health, usage] = await Promise.all([healthFigures(ids), usageFigures(tenantId, ids)]);
  return rows.map(({ application: a, state, provisioningStatus }) => ({
    application: { id: a.id, key: a.key, name: a.name, description: a.description, version: a.healthVersion },
    state,
    setUp: provisioningStatus === 'READY' || provisioningStatus === 'NOT_REQUIRED',
    // No health address: the application doesn't take part in checks
    health: a.healthUrl
      ? { status: a.healthStatus as 'UP' | 'DEGRADED' | 'DOWN' | null, since: a.healthChangedAt, checkedAt: a.healthCheckedAt, ...(health.get(a.id) ?? null) }
      : null,
    usage: usage.get(a.id)!,
  }));
}

/** One application in detail: daily uptime for 30 days, this month's and last month's usage */
export async function applicationDetail(tenantId: string, applicationId: string) {
  const list = await applicationFigures(tenantId);
  const app = list.find((a) => a.application.id === applicationId);
  if (!app) return null;
  // The day before this month began is in last month
  const last = monthOf(undefined, new Date(monthOf().from.getTime() - DAY));
  const [days, lastMonth] = await Promise.all([
    app.health ? dailyUptime(applicationId) : Promise.resolve([]),
    usageFigures(tenantId, [applicationId], last.month),
  ]);
  return { ...app, days, lastMonthUsage: lastMonth.get(applicationId)! };
}

// ---------------------------------------------------------------------------
// The organization's data
// ---------------------------------------------------------------------------

/** Tables counted, by label (every one has a tenant_id column) */
const COUNTED: [label: string, table: string][] = [
  ['People', 'users'],
  ['Groups', 'groups'],
  ['Roles', 'roles'],
  ['Organizations', 'organizations'],
  ['Notifications', 'notifications'],
  ['Activity entries', 'activities'],
  ['Audit log entries', 'audit_events'],
  ['API keys', 'api_keys'],
  ['Webhooks', 'webhook_endpoints'],
];

export interface DatabaseFigures {
  mode: 'SHARED_TABLES' | 'SCHEMA_PER_TENANT' | 'DATABASE_PER_TENANT';
  /** Bytes its data takes; null when it shares tables with other organizations (not measurable on its own) */
  sizeBytes: number | null;
  rows: { label: string; table: string; count: number }[];
  connections: { open: number; active: number; idle: number; limit: number | null };
  /** The slowest kinds of query on its connections, when the server keeps statistics (pg_stat_statements) */
  slowQueries: { query: string; calls: number; meanMs: number }[] | null;
  measuredAt: string;
}

const modeOf = (t: Target): DatabaseFigures['mode'] => (t.kind === 'shared' ? 'SHARED_TABLES' : t.kind === 'schema' ? 'SCHEMA_PER_TENANT' : 'DATABASE_PER_TENANT');

/** How much room the organization's data takes, what's in it, and its connections */
export async function databaseFigures(tenantId: string, slug: string): Promise<DatabaseFigures> {
  const target = await targetForTenant(tenantId);
  const db = platformDb(target);
  const role = roleNameFor(slug);
  const schema = target.kind === 'schema' ? target.schema : 'public';

  const size = async (): Promise<number | null> => {
    if (target.kind === 'database') {
      const [r] = await db.$queryRaw<{ bytes: bigint }[]>`SELECT pg_database_size(current_database()) AS bytes`;
      return Number(r.bytes);
    }
    if (target.kind === 'schema') {
      const [r] = await db.$queryRaw<{ bytes: bigint | null }[]>`
        SELECT sum(pg_total_relation_size(c.oid))::bigint AS bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'm', 'p')`;
      return Number(r.bytes ?? 0);
    }
    return null;
  };

  const rows = async () => {
    const out: DatabaseFigures['rows'] = [];
    for (const [label, table] of COUNTED) {
      const [r] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${ident(schema)}.${ident(table)} WHERE tenant_id = $1`, tenantId);
      out.push({ label, table, count: Number(r.n) });
    }
    return out;
  };

  const connections = async () => {
    const [r] = await db.$queryRaw<{ open: bigint; active: bigint; idle: bigint; lim: number | null }[]>`
      SELECT count(a.pid) AS open,
        count(a.pid) FILTER (WHERE a.state = 'active') AS active,
        count(a.pid) FILTER (WHERE a.state LIKE 'idle%') AS idle,
        (SELECT NULLIF(rolconnlimit, -1) FROM pg_roles WHERE rolname = ${role}) AS lim
      FROM pg_stat_activity a WHERE a.usename = ${role}`;
    return { open: Number(r.open), active: Number(r.active), idle: Number(r.idle), limit: r.lim };
  };

  const slow = async (): Promise<DatabaseFigures['slowQueries']> => {
    const [ext] = await db.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS ok`;
    if (!ext.ok) return null;
    try {
      const top = await db.$queryRaw<{ query: string; calls: bigint; mean: number }[]>`
        SELECT left(s.query, 300) AS query, s.calls, s.mean_exec_time AS mean
        FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid
        WHERE r.rolname = ${role} AND s.calls > 0
        ORDER BY s.mean_exec_time DESC LIMIT 5`;
      return top.map((q) => ({ query: q.query, calls: Number(q.calls), meanMs: Math.round(q.mean * 10) / 10 }));
    } catch {
      // Installed in another database, or not readable by this role
      return null;
    }
  };

  const [sizeBytes, counted, conns, slowQueries] = await Promise.all([size(), rows(), connections(), slow()]);
  return { mode: modeOf(target), sizeBytes, rows: counted, connections: conns, slowQueries, measuredAt: new Date().toISOString() };
}
