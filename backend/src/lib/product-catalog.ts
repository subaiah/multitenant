/**
 * The notification and audit event types external products declare in their
 * manifests (platformServices; docs/hub/MANIFEST_V2.md), and the events they
 * publish (events.emits; lib/product-events.ts), next to the kit's
 * and the embedded product's (kit/notification-types.ts, kit/audit-events.ts).
 *
 * - Stored in product_declared_types; kept in memory here, because the
 *   catalogs are looked up synchronously (inside the audit transaction,
 *   for one). Reloaded when a manifest changes on this server, and on any
 *   server when its copy is older than RELOAD_MS (refreshProductCatalog()),
 *   which the routes that use product types call first.
 * - Retired types (gone from the manifest) stay known, so existing audit
 *   entries, organization rules and saved webhooks still read right, but
 *   can't be sent or written any more.
 * - Each organization sees only the types of products it has turned on
 *   (hiddenProductTypes()).
 */
import { controlDb } from './prisma.js';
import type { AuditEventDefinition } from '../kit/audit-events.js';
import type { NotificationType, NotifyEvent } from '../kit/notification-types.js';

export interface DeclaredType {
  kind: 'notification' | 'audit' | 'event';
  type: string;
  label: string;
  description: string | null;
  schemaUrl: string | null;
  defaultInApp: boolean;
  defaultEmail: boolean;
  retired: boolean;
  applicationId: string;
  productKey: string;
  productName: string;
  baseUrl: string | null;
}

const RELOAD_MS = 30_000;
let types = new Map<string, DeclaredType>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

async function load() {
  const rows = await controlDb.productDeclaredType.findMany({
    include: { application: { select: { key: true, name: true, baseUrl: true } } },
  });
  types = new Map(rows.map((r) => [r.type, {
    kind: r.kind as DeclaredType['kind'],
    type: r.type,
    label: r.label,
    description: r.description,
    schemaUrl: r.schemaUrl,
    defaultInApp: r.defaultInApp,
    defaultEmail: r.defaultEmail,
    retired: !!r.retiredAt,
    applicationId: r.applicationId,
    productKey: r.application.key,
    productName: r.application.name,
    baseUrl: r.application.baseUrl,
  }]));
  loadedAt = Date.now();
}

/** Make sure this server's copy is recent (force: reload now, e.g. after an import) */
export async function refreshProductCatalog(force = false): Promise<void> {
  if (!force && Date.now() - loadedAt < RELOAD_MS) return;
  loading ??= load().finally(() => {
    loading = null;
  });
  await loading;
}

export const declaredType = (type: string): DeclaredType | undefined => types.get(type);
export const declaredTypes = (): DeclaredType[] => [...types.values()];

/** As the notification catalog wants them (lib/notifications.ts) */
export function productNotificationTypes(): Record<string, NotificationType> {
  const out: Record<string, NotificationType> = {};
  for (const t of types.values()) {
    if (t.kind !== 'notification') continue;
    out[t.type] = {
      label: `${t.productName}: ${t.label}`,
      description: t.description ?? `From ${t.productName}`,
      category: 'product',
      scope: 'tenant',
      defaults: { inApp: t.defaultInApp, email: t.defaultEmail },
      // Who: the people and groups the product named (notify()'s recipients), or everyone holding one of its permissions
      audience: (e: NotifyEvent) => ({
        permission: typeof e.details?.permission === 'string' ? e.details.permission : undefined,
        groupIds: Array.isArray(e.details?.groupIds) ? (e.details.groupIds as unknown[]) : undefined,
      }),
      // Plain text the product sent, always saying where it's from
      render: (e: NotifyEvent) => ({
        title: `${t.productName}: ${String(e.details?.title ?? t.label)}`,
        body: typeof e.details?.body === 'string' ? e.details.body : undefined,
        link: typeof e.details?.link === 'string' ? e.details.link : undefined,
      }),
    };
  }
  return out;
}

/** As the audit catalog wants them (lib/audit.ts) */
export function productAuditEvents(): Record<string, AuditEventDefinition> {
  const out: Record<string, AuditEventDefinition> = {};
  for (const t of types.values()) {
    if (t.kind === 'audit') out[t.type] = { label: `${t.productName}: ${t.label}`, category: 'application', scope: 'tenant' };
  }
  return out;
}

/** Events applications publish (lib/product-events.ts), for organizations' webhooks (lib/webhooks.ts) */
export function productEventTypes(): { type: string; label: string; category: string }[] {
  return [...types.values()].filter((t) => t.kind === 'event').map((t) => ({ type: t.type, label: `${t.productName}: ${t.label}`, category: 'application' }));
}

/** The product types an organization doesn't see: those of products it hasn't turned on */
export async function hiddenProductTypes(tenantId: string): Promise<Set<string>> {
  await refreshProductCatalog();
  const now = new Date();
  const on = new Set((await controlDb.tenantApplication.findMany({
    where: { tenantId, state: { in: ['ENABLED', 'TRIAL'] }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
    select: { applicationId: true },
  })).map((e) => e.applicationId));
  return new Set([...types.values()].filter((t) => !on.has(t.applicationId)).map((t) => t.type));
}
