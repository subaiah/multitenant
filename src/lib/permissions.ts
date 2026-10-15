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
