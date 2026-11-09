/**
 * The platform's own services for external products (docs/hub/HUB_GAPS.md
 * G3; routes/product-v1.ts): sending notifications to an organization's
 * people, and writing to its audit log. Only the types the product declares
 * in its manifest (platformServices), only for organizations that have it
 * turned on.
 *
 * Safeguards, because these reach people under the platform's name:
 * - Notifications are plain text (never rendered as HTML), always titled
 *   with the product's name, and may link only to the product's own pages.
 * - Recipients must be in the organization (named people or groups), or
 *   everyone holding one of the product's own permissions; the
 *   organization's notification rules and each person's preferences apply.
 * - Audit entries are always the product's (actor type APPLICATION): a
 *   person the product says it acted for is recorded as onBehalfOf, never
 *   as the actor.
 * - A rate limit per service credential.
 */
import { z } from 'zod';
import { notify } from './notifications.js';
import { recordAudit } from './audit.js';
import { declaredType, refreshProductCatalog } from './product-catalog.js';
import { readableOrganization } from './product-data.js';
import { controlDb } from './prisma.js';
import { accountIdFor } from './oidc/accounts.js';
import type { ServiceCaller } from './product-service.js';
import { AppError } from '../middleware/error-handler.js';

// ---------------------------------------------------------------------------
// Rate limits (per server; each server counts its own)
// ---------------------------------------------------------------------------

export const LIMITS = { notifications: 120, audit: 600 } as const;

export class RateLimited extends AppError {
  constructor(message: string, readonly retryAfter: number) {
    super(message, 429, true, 'RATE_LIMITED');
  }
}
const windows = new Map<string, { start: number; count: number }>();

function limit(kind: keyof typeof LIMITS, credentialId: string) {
  const key = `${kind}:${credentialId}`;
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.start >= 60_000) {
    windows.set(key, { start: now, count: 1 });
    return;
  }
  if (++w.count > LIMITS[kind]) {
    throw new RateLimited(`More than ${LIMITS[kind]} a minute for this credential: wait a moment`, Math.ceil((w.start + 60_000 - now) / 1000));
  }
}

/** One of this product's declared types, of this kind, still declared */
async function ownType(caller: ServiceCaller, kind: 'notification' | 'audit', type: string) {
  await refreshProductCatalog();
  let t = declaredType(type);
  if (!t) {
    await refreshProductCatalog(true);
    t = declaredType(type);
  }
  if (!t || t.kind !== kind || t.applicationId !== caller.applicationId) {
    throw new AppError(`"${type}" isn't one of this application's declared ${kind === 'notification' ? 'notification types' : 'audit event types'} (manifest platformServices)`, 400, true, 'UNKNOWN_TYPE');
  }
  if (t.retired) throw new AppError(`"${type}" is no longer in this application's manifest`, 400, true, 'RETIRED_TYPE');
  return t;
}

/** <organization id>.<user id> subjects in this organization: their user ids */
function userIdsOf(tenantId: string, subjects: string[]): string[] {
  const prefix = `${tenantId}.`;
  const wrong = subjects.filter((s) => !s.startsWith(prefix) || s.length === prefix.length);
  if (wrong.length) throw new AppError(`Not people in this organization: ${wrong.slice(0, 5).join(', ')}${wrong.length > 5 ? '…' : ''}`, 400, true, 'UNKNOWN_RECIPIENTS');
  return subjects.map((s) => s.slice(prefix.length));
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const plain = (max: number) => z.string().trim().min(1).max(max).transform((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''));

export const notificationSchema = z.object({
  type: z.string().max(100),
  title: plain(120),
  body: plain(1000).optional(),
  /** A path on the application (/deals/42) or a full address on its own host */
  link: z.string().max(2000).optional(),
  to: z.object({
    subjects: z.array(z.string().max(200)).max(500).optional(),
    groupIds: z.array(z.string().uuid()).max(50).optional(),
    /** Everyone holding this permission (one of the application's own) */
    permission: z.string().max(100).optional(),
  }).refine((t) => (t.subjects?.length ?? 0) + (t.groupIds?.length ?? 0) > 0 || !!t.permission, 'Name subjects, groupIds or a permission'),
});

export async function sendProductNotification(caller: ServiceCaller, tenantId: string, input: unknown) {
  limit('notifications', caller.credentialId);
  const n = notificationSchema.parse(input);
  const db = await readableOrganization(caller.applicationId, tenantId);
  const t = await ownType(caller, 'notification', n.type);

  // Links: only the application's own pages
  let link: string | undefined;
  if (n.link) {
    if (!t.baseUrl) throw new AppError('This application has no address, so its notifications can’t link anywhere', 400, true, 'INVALID_LINK');
    const base = new URL(t.baseUrl);
    let url: URL;
    try {
      url = n.link.startsWith('/') && !n.link.startsWith('//') ? new URL(n.link, base) : new URL(n.link);
    } catch {
      throw new AppError('Not a valid link', 400, true, 'INVALID_LINK');
    }
    if (url.origin !== base.origin) throw new AppError(`Links must stay on ${base.origin}`, 400, true, 'INVALID_LINK');
    link = url.toString();
  }

  // Recipients: in this organization
  const userIds = userIdsOf(tenantId, n.to.subjects ?? []);
  if (userIds.length) {
    const found = new Set((await db.user.findMany({ where: { tenantId, id: { in: userIds } }, select: { id: true } })).map((u) => u.id));
    const missing = userIds.filter((id) => !found.has(id));
    if (missing.length) throw new AppError(`Not people in this organization: ${missing.slice(0, 5).map((id) => accountIdFor(tenantId, id)).join(', ')}`, 400, true, 'UNKNOWN_RECIPIENTS');
  }
  if (n.to.groupIds?.length) {
    const found = await db.group.count({ where: { tenantId, id: { in: n.to.groupIds } } });
    if (found !== new Set(n.to.groupIds).size) throw new AppError('Not groups in this organization', 400, true, 'UNKNOWN_RECIPIENTS');
  }
  if (n.to.permission) {
    const own = await controlDb.permission.findFirst({ where: { applicationId: caller.applicationId, name: n.to.permission }, select: { id: true } });
    if (!own) throw new AppError(`"${n.to.permission}" isn't one of this application's permissions`, 400, true, 'UNKNOWN_PERMISSION');
  }

  await notify({ tenantId, actor: { type: 'APPLICATION', id: caller.productKey } }, n.type, {
    resource: { type: 'application', id: caller.productKey, label: caller.productName },
    details: {
      title: n.title,
      ...(n.body && { body: n.body }),
      ...(link && { link }),
      ...(n.to.permission && { permission: n.to.permission }),
      ...(n.to.groupIds?.length && { groupIds: n.to.groupIds }),
    },
    recipients: userIds,
  });
  return { accepted: true };
}

// ---------------------------------------------------------------------------
// Audit entries
// ---------------------------------------------------------------------------

export const auditEventSchema = z.object({
  type: z.string().max(100),
  outcome: z.enum(['SUCCESS', 'FAILURE']).default('SUCCESS'),
  /** The person the application acted for, as their subject */
  onBehalfOf: z.string().max(200).optional(),
  resource: z.object({ type: z.string().trim().min(1).max(50), id: z.string().max(200).optional(), label: z.string().max(200).optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional().refine((d) => !d || JSON.stringify(d).length <= 4000, 'details: at most 4000 characters as JSON'),
});

export async function writeProductAuditEvent(caller: ServiceCaller, tenantId: string, input: unknown, meta: { ip?: string; requestId?: string } = {}) {
  limit('audit', caller.credentialId);
  const e = auditEventSchema.parse(input);
  const db = await readableOrganization(caller.applicationId, tenantId);
  await ownType(caller, 'audit', e.type);
  let onBehalfOf: { subject: string; email: string } | undefined;
  if (e.onBehalfOf) {
    const [userId] = userIdsOf(tenantId, [e.onBehalfOf]);
    const person = await db.user.findFirst({ where: { tenantId, id: userId }, select: { email: true } });
    if (!person) throw new AppError(`${e.onBehalfOf} isn't a person in this organization`, 400, true, 'UNKNOWN_SUBJECT');
    onBehalfOf = { subject: e.onBehalfOf, email: person.email };
  }
  const entry = await recordAudit({ tenantId, actor: { type: 'APPLICATION', id: caller.productKey, email: null }, ip: meta.ip ?? null, requestId: meta.requestId ?? null }, e.type, {
    outcome: e.outcome,
    ...(e.resource && { resource: { type: e.resource.type, id: e.resource.id ?? null, label: e.resource.label ?? null } }),
    // The application's report, kept apart from anything the platform records itself
    details: { ...(e.details ?? {}), application: { id: caller.productKey, name: caller.productName }, ...(onBehalfOf && { onBehalfOf }) },
  });
  return { seq: entry.seq };
}
