/**
 * Usage of applications' metered features (docs/hub/HUB_GAPS.md G6): AI
 * tokens in AppForge, storage in Hearth, and so on.
 *
 * - Declared in the manifest (v2 usage: key, label, unit).
 * - Reported by the application's server for an organization that has it
 *   on: POST …/organizations/{id}/usage (usage.report), one record or a batch
 *   of up to 100. A record's idempotencyKey makes sending it again harmless.
 *   occurredAt may be up to 35 days back (late reports), not in the future.
 * - Totals per month are shown to the organization's administrators and to
 *   platform staff, and are what per-application billing charges (G6's
 *   prices: lib/billing).
 */
import { z } from 'zod';
import { controlDb } from './prisma.js';
import { readableOrganization } from './product-data.js';
import { limit } from './product-services.js';
import type { ServiceCaller } from './product-service.js';
import { AppError } from '../middleware/error-handler.js';

export const MAX_BACKDATE_DAYS = 35;

const record = z.object({
  key: z.string().max(100),
  quantity: z.number().finite().min(0).max(1e12),
  occurredAt: z.coerce.date().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});
const batch = z.object({ records: z.array(record).min(1).max(100) });
/** One record, or { records: [...] }: the shape is picked first, so a mistake names its field */
export const usageSchema = {
  parse: (input: unknown) => (input && typeof input === 'object' && 'records' in input ? batch.parse(input) : { records: [record.parse(input)] }),
};

export async function reportUsage(caller: ServiceCaller, tenantId: string, input: unknown) {
  limit('usage', caller.credentialId);
  const { records } = usageSchema.parse(input);
  await readableOrganization(caller.applicationId, tenantId);
  const meters = new Map((await controlDb.productUsageMeter.findMany({ where: { applicationId: caller.applicationId } })).map((m) => [m.key, m]));
  const now = Date.now();
  const problems: string[] = [];
  records.forEach((r, i) => {
    const m = meters.get(r.key);
    if (!m) problems.push(`records.${i}.key: "${r.key}" isn't one of this application's meters (manifest usage)`);
    else if (m.retiredAt) problems.push(`records.${i}.key: "${r.key}" is no longer in this application's manifest`);
    const at = r.occurredAt?.getTime() ?? now;
    if (at > now + 5 * 60_000) problems.push(`records.${i}.occurredAt: in the future`);
    if (at < now - MAX_BACKDATE_DAYS * 86_400_000) problems.push(`records.${i}.occurredAt: more than ${MAX_BACKDATE_DAYS} days ago`);
  });
  if (problems.length) throw new AppError(problems.join('; '), 400, true, 'INVALID_USAGE');
  const keys = records.map((r) => r.idempotencyKey).filter((k): k is string => !!k);
  if (new Set(keys).size !== keys.length) throw new AppError('An idempotencyKey is used twice in this batch', 400, true, 'INVALID_USAGE');
  const { count } = await controlDb.productUsageRecord.createMany({
    data: records.map((r) => ({
      applicationId: caller.applicationId, tenantId, meterKey: r.key, quantity: r.quantity,
      occurredAt: r.occurredAt ?? new Date(now), idempotencyKey: r.idempotencyKey ?? null,
    })),
    skipDuplicates: true,
  });
  return { accepted: count, duplicates: records.length - count };
}

/** The calendar month (UTC) a date falls in, or the one named YYYY-MM */
export function monthOf(month?: string, at = new Date()): { month: string; from: Date; to: Date } {
  const m = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  const [y, mo] = m.split('-').map(Number);
  return { month: m, from: new Date(Date.UTC(y, mo - 1, 1)), to: new Date(Date.UTC(y, mo, 1)) };
}

/** Totals per application and meter for an organization in [from, to) */
export async function usageTotals(where: { tenantId?: string; applicationId?: string }, from: Date, to: Date) {
  const rows = await controlDb.productUsageRecord.groupBy({
    by: ['applicationId', 'tenantId', 'meterKey'],
    where: { ...where, occurredAt: { gte: from, lt: to } },
    _sum: { quantity: true },
    _count: { _all: true },
  });
  return rows.map((r) => ({ applicationId: r.applicationId, tenantId: r.tenantId, key: r.meterKey, total: r._sum.quantity ?? 0, records: r._count._all }));
}

/** For the application: its usage in an organization for a month, per meter */
export async function usageForApplication(caller: ServiceCaller, tenantId: string, month?: string) {
  await readableOrganization(caller.applicationId, tenantId);
  const period = monthOf(month);
  const meters = await controlDb.productUsageMeter.findMany({ where: { applicationId: caller.applicationId }, orderBy: { position: 'asc' } });
  const totals = new Map((await usageTotals({ tenantId, applicationId: caller.applicationId }, period.from, period.to)).map((t) => [t.key, t]));
  return {
    month: period.month,
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    meters: meters.map((m) => ({ key: m.key, label: m.label, unit: m.unit, total: totals.get(m.key)?.total ?? 0, records: totals.get(m.key)?.records ?? 0 })),
  };
}
