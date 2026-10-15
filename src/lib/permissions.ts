/**
 * Permission matching, mirroring backend/src/utils/permissions.ts.
 * Permission names live in that backend catalog; the backend test
 * test/permissions.test.ts checks every name used in this app against it.
 *
 * Grants may use wildcards: `*`, `*:*`, `resource:*`, `*:action`.
 */
export function permissionMatches(granted: Iterable<string>, required: string): boolean {
  const set = granted instanceof Set ? (granted as Set<string>) : new Set(granted);
  if (set.has('*') || set.has('*:*') || set.has(required)) return true;
  const i = required.indexOf(':');
  if (i === -1) return false;
  const resource = required.slice(0, i);
  const action = required.slice(i + 1);
  return set.has(`${resource}:*`) || set.has(`*:${action}`);
}

export type Portal = 'PLATFORM' | 'TENANT';

export function portalHome(portal: Portal): string {
  return portal === 'PLATFORM' ? '/platform/dashboard' : '/dashboard';
}

/** Mirrors USER_TYPE_HIERARCHY in backend/src/utils/authorization.ts. */
export const USER_TYPE_RANK: Record<string, number> = {
  PLATFORM_ADMIN: 100,
  PLATFORM_USER: 90,
  TENANT_ADMIN: 80,
  TENANT_MANAGER: 70,
  TENANT_DEVELOPER: 60,
  TENANT_USER: 50,
  TENANT_VIEWER: 40,
};

export const TENANT_USER_TYPES = ['TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER'] as const;

/** Nobody can grant or manage a user type ranked above their own (enforced server-side too). */
export function canManageUserType(actor: string, target: string) {
  return (USER_TYPE_RANK[target] ?? 999) <= (USER_TYPE_RANK[actor] ?? 0);
}
