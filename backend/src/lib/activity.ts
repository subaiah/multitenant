/**
 * Audit trail. An action inside a tenant goes to that tenant's activity log
 * (tenant plane), whoever did it, including platform staff acting in the
 * tenant. An action with no tenant (the app catalogue, menus, platform users)
 * goes to the platform activity log (control plane).
 */
import type { Prisma } from '../generated/tenant/index.js';
import { controlDb } from './prisma.js';
import { dbForTenant } from './tenant-db.js';

type ActivityType = 'DEPLOY' | 'CONFIG' | 'USER' | 'BILLING' | 'ALERT' | 'AUTH' | 'API';

export interface ActivityEntry {
  tenantId?: string | null;
  userId?: string | null;
  action: string;
  target: string;
  type: ActivityType;
  metadata?: Prisma.InputJsonValue;
}

export async function logActivity(entry: ActivityEntry): Promise<void> {
  const { tenantId, ...rest } = entry;
  if (tenantId) {
    await dbForTenant(tenantId).activity.create({ data: { tenantId, ...rest } });
  } else {
    await controlDb.platformActivity.create({ data: rest });
  }
}

/** Platform-level entry that concerns a tenant (e.g. a support session was granted). */
export async function logPlatformActivity(entry: ActivityEntry): Promise<void> {
  await controlDb.platformActivity.create({ data: entry });
}
