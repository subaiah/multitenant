import { prisma } from './prisma.js';

type ActivityUser = { id: string; name: string | null; email: string };

/**
 * Activity has a userId column but no Prisma relation to User,
 * so `include: { user }` is not available. Attach users with one extra query.
 */
export async function withActivityUsers<T extends { userId: string | null }>(
  activities: T[],
): Promise<(T & { user: ActivityUser | null })[]> {
  const ids = [...new Set(activities.map((a) => a.userId).filter((id): id is string => !!id))];
  const users = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return activities.map((a) => ({ ...a, user: a.userId ? byId.get(a.userId) ?? null : null }));
}
