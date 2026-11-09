/**
 * Applications that need, or work with, other applications (manifest v2
 * requires and integratesWith; docs/hub/HUB_GAPS.md G2).
 *
 * - Turning an application on (entitling it, or making an entitlement
 *   active again) needs everything it requires already on, or turned on in
 *   the same step (a bundle): otherwise refused, naming what's missing and
 *   why (MISSING_DEPENDENCY). It's never turned on for the organization
 *   automatically: that may change what it pays (until per-application
 *   billing, G6).
 * - Turning one off (disabling, ending or removing the entitlement) while an
 *   application that requires it is on is refused, naming those
 *   (REQUIRED_BY).
 * - integratesWith is informational: shown to administrators.
 * - A new requires entry doesn't turn anything off for organizations that
 *   already have the application; the Integrations page lists organizations
 *   missing a dependency.
 */
import { controlDb } from './prisma.js';
import { AppError } from '../middleware/error-handler.js';

type Tx = Pick<typeof controlDb, 'productDependency' | 'applicationRegistry' | 'tenantApplication'>;
const ACTIVE_STATES = ['ENABLED', 'TRIAL'];

/** An entitlement in effect (now, or once it starts) */
export const isOn = (e: { state: string; validTo: Date | null } | null | undefined, now = new Date()) =>
  !!e && ACTIVE_STATES.includes(e.state) && (!e.validTo || e.validTo > now);

export interface Dependency { productId: string; name: string | null; reason: string }

/** One check of entitlements per organization at a time */
export async function lockEntitlements(tx: Pick<typeof controlDb, '$queryRaw'>, tenantId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`entitlements:${tenantId}`}))::text`;
}

/**
 * Refuse turning these applications on unless what they require is on, or
 * among them. Call inside the transaction that turns them on.
 */
export async function assertCanTurnOn(tx: Tx, tenantId: string, applicationIds: string[]): Promise<void> {
  const deps = await tx.productDependency.findMany({
    where: { applicationId: { in: applicationIds }, kind: 'requires' },
    include: { application: { select: { id: true, name: true } } },
    orderBy: { position: 'asc' },
  });
  if (!deps.length) return;
  const required = await tx.applicationRegistry.findMany({ where: { key: { in: deps.map((d) => d.productKey) } }, select: { id: true, key: true, name: true, status: true } });
  const byKey = new Map(required.map((a) => [a.key, a]));
  const on = new Set((await tx.tenantApplication.findMany({ where: { tenantId, applicationId: { in: required.map((a) => a.id) } } }))
    .filter((e) => isOn(e)).map((e) => e.applicationId));
  const turningOn = new Set(applicationIds);
  const missing: (Dependency & { for: string })[] = [];
  for (const d of deps) {
    const app = byKey.get(d.productKey);
    if (app && app.status === 'ACTIVE' && (on.has(app.id) || turningOn.has(app.id))) continue;
    missing.push({ productId: d.productKey, name: app?.name ?? null, reason: d.reason, for: d.application.name });
  }
  if (!missing.length) return;
  const list = missing.map((m) => `${m.name ?? m.productId}${m.name && byKey.get(m.productId)?.status !== 'ACTIVE' ? ' (not available)' : ''}`);
  const err = new AppError(`${[...new Set(missing.map((m) => m.for))].join(', ')} needs ${list.join(' and ')} turned on first: ${missing.map((m) => m.reason).join('; ')}`, 409, true, 'MISSING_DEPENDENCY');
  err.details = { missing };
  throw err;
}

/**
 * Refuse turning these applications off while an application that requires
 * one of them is on (and not being turned off too).
 */
export async function assertCanTurnOff(tx: Tx, tenantId: string, applicationIds: string[]): Promise<void> {
  const apps = await tx.applicationRegistry.findMany({ where: { id: { in: applicationIds } }, select: { key: true, name: true } });
  if (!apps.length) return;
  const dependants = await tx.productDependency.findMany({
    where: { kind: 'requires', productKey: { in: apps.map((a) => a.key) }, applicationId: { notIn: applicationIds } },
    include: { application: { select: { id: true, key: true, name: true } } },
  });
  if (!dependants.length) return;
  const on = new Set((await tx.tenantApplication.findMany({ where: { tenantId, applicationId: { in: dependants.map((d) => d.applicationId) } } }))
    .filter((e) => isOn(e)).map((e) => e.applicationId));
  const blocking = dependants.filter((d) => on.has(d.applicationId));
  if (!blocking.length) return;
  const nameOf = new Map(apps.map((a) => [a.key, a.name]));
  const err = new AppError(
    `${[...new Set(blocking.map((d) => d.application.name))].join(' and ')} need${blocking.length === 1 ? 's' : ''} ${[...new Set(blocking.map((d) => nameOf.get(d.productKey)))].join(' and ')}: turn ${blocking.length === 1 ? 'it' : 'them'} off first`,
    409, true, 'REQUIRED_BY',
  );
  err.details = { requiredBy: blocking.map((d) => ({ productId: d.application.key, name: d.application.name, needs: d.productKey, reason: d.reason })) };
  throw err;
}

/** For the catalogue: each application's requires and integratesWith, with names where registered */
export async function dependenciesOf(applicationIds: string[]): Promise<Map<string, { requires: Dependency[]; integratesWith: Dependency[] }>> {
  const deps = await controlDb.productDependency.findMany({ where: { applicationId: { in: applicationIds } }, orderBy: { position: 'asc' } });
  const names = new Map((await controlDb.applicationRegistry.findMany({ where: { key: { in: deps.map((d) => d.productKey) } }, select: { key: true, name: true } })).map((a) => [a.key, a.name]));
  const out = new Map<string, { requires: Dependency[]; integratesWith: Dependency[] }>();
  for (const id of applicationIds) out.set(id, { requires: [], integratesWith: [] });
  for (const d of deps) {
    const entry = { productId: d.productKey, name: names.get(d.productKey) ?? null, reason: d.reason };
    (d.kind === 'requires' ? out.get(d.applicationId)!.requires : out.get(d.applicationId)!.integratesWith).push(entry);
  }
  return out;
}

/** Per application: organizations that have it on without something it requires (Integrations page) */
export async function organizationsMissingDependencies(): Promise<Map<string, number>> {
  const deps = await controlDb.productDependency.findMany({ where: { kind: 'requires' }, select: { applicationId: true, productKey: true } });
  const out = new Map<string, number>();
  if (!deps.length) return out;
  const now = new Date();
  const required = new Map((await controlDb.applicationRegistry.findMany({ where: { key: { in: deps.map((d) => d.productKey) } }, select: { id: true, key: true } })).map((a) => [a.key, a.id]));
  const entitlements = await controlDb.tenantApplication.findMany({
    where: { applicationId: { in: [...new Set([...deps.map((d) => d.applicationId), ...required.values()])] }, state: { in: ACTIVE_STATES }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
    select: { tenantId: true, applicationId: true },
  });
  const onFor = new Set(entitlements.map((e) => `${e.tenantId} ${e.applicationId}`));
  for (const appId of new Set(deps.map((d) => d.applicationId))) {
    const needs = deps.filter((d) => d.applicationId === appId).map((d) => required.get(d.productKey));
    const tenants = entitlements.filter((e) => e.applicationId === appId).map((e) => e.tenantId);
    const missing = tenants.filter((t) => needs.some((id) => !id || !onFor.has(`${t} ${id}`))).length;
    if (missing) out.set(appId, missing);
  }
  return out;
}
