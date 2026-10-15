import { controlDb } from './prisma.js';
import type { TenantDb } from './tenant-db.js';

type ActivityUser = { id: string; name: string | null; email: string };

/**
 * Activity has a userId column but no Prisma relation to User,
 * so `include: { user }` is not available. Attach users with one extra query.
 */
export async function withActivityUsers<T extends { userId: string | null }>(
  db: TenantDb,
  activities: T[],
): Promise<(T & { user: ActivityUser | null })[]> {
  const ids = [...new Set(activities.map((a) => a.userId).filter((id): id is string => !!id))];
  const select = { id: true, name: true, email: true } as const;
  // Tenant users, and platform staff who acted inside the tenant (support)
  const [tenantUsers, platformUsers] = ids.length
    ? await Promise.all([
        db.user.findMany({ where: { id: { in: ids } }, select }),
        controlDb.platformUser.findMany({ where: { id: { in: ids } }, select }),
      ])
    : [[], []];
  const users = [...tenantUsers, ...platformUsers];
  const byId = new Map(users.map((u) => [u.id, u]));
  return activities.map((a) => ({ ...a, user: a.userId ? byId.get(a.userId) ?? null : null }));
}
