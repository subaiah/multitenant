/**
 * Support sessions: the only way platform staff work inside a tenant.
 *
 * - Requested for one tenant, with a reason, for a limited time (at most
 *   SUPPORT_MAX_HOURS), read-only unless read-write is asked for and approved
 *   with specific permissions.
 * - Approved by someone else with support:manage (or by the requester when
 *   SUPPORT_SELF_APPROVAL=true, for one-person teams). Approving starts it.
 * - While it's active, requests that select that tenant are let in
 *   (middleware/authenticate.ts) with the session's permissions only
 *   (middleware/authorize.ts), and a read-only session's database
 *   connection refuses writes in Postgres itself.
 * - The tenant sees it: its audit log records the start, the end and
 *   everything done in between; its admins are notified.
 */
import { config } from '../config/env.js';
import { controlDb } from './prisma.js';
import { PERMISSIONS, isReadPermission, isTenantGrantable } from '../utils/permissions.js';

export interface ActiveSupportSession {
  id: string;
  tenantId: string;
  access: 'READ_ONLY' | 'READ_WRITE';
  permissions: string[];
  validTo: Date;
}

/** The caller's active session for a tenant, or null. */
export async function activeSupportSession(platformUserId: string, tenantId: string): Promise<ActiveSupportSession | null> {
  const now = new Date();
  const s = await controlDb.supportSession.findFirst({
    where: { platformUserId, tenantId, status: 'ACTIVE', validFrom: { lte: now }, validTo: { gt: now } },
    orderBy: { validTo: 'desc' },
    select: { id: true, tenantId: true, access: true, permissions: true, validTo: true },
  });
  if (!s) return null;
  return { ...s, validTo: s.validTo!, permissions: Array.isArray(s.permissions) ? (s.permissions as string[]) : [] };
}

/** Every tenant permission that only reads. */
export const READ_PERMISSIONS = PERMISSIONS.filter(isReadPermission);

/** What a session lets its holder do in the tenant: reading always; READ_WRITE adds its approved permissions. */
export function sessionPermissions(session: Pick<ActiveSupportSession, 'access' | 'permissions'>): string[] {
  if (session.access === 'READ_ONLY') return READ_PERMISSIONS;
  return [...new Set([...READ_PERMISSIONS, ...session.permissions.filter(isTenantGrantable)])];
}

/** Mark sessions past their end as EXPIRED (they stopped working at validTo anyway). */
export async function expireSupportSessions(): Promise<string[]> {
  const ended = await controlDb.supportSession.findMany({ where: { status: 'ACTIVE', validTo: { lte: new Date() } }, select: { id: true } });
  if (ended.length) await controlDb.supportSession.updateMany({ where: { id: { in: ended.map((e) => e.id) } }, data: { status: 'EXPIRED' } });
  return ended.map((e) => e.id);
}

export const supportMaxMinutes = () => config.supportMaxHours * 60;
