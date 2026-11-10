/**
 * What a person holds in one application, as the application is told it
 * (docs/hub/HUB_GAPS.md G7): the `permissions` and `scoped_permissions`
 * claims, the members API and user events all use this, so they agree.
 *
 * - permissions: the application's declared permissions the person holds
 *   across the whole organization.
 * - scopedPermissions: the ones held only inside one of the organization's
 *   own organizations (scopeType ORGANIZATION), one unit and every unit below
 *   it (ORG_UNIT) or one resource (RESOURCE), from scoped role assignments
 *   (lib/scopes.ts). One already held everywhere isn't repeated. The
 *   application applies them to its own rows the same way the platform does:
 *   a unit grant covers the units below it (GET .../org-units has the tree).
 *
 * Only the application's own permissions: never the kit's or another
 * application's.
 */
import type { EnhancedPermissionData, ScopedGrant } from '../utils/authorization.js';
import { permissionMatches } from '../utils/permissions.js';

export interface ScopedPermission {
  permission: string;
  scopeType: ScopedGrant['scopeType'];
  scopeId: string;
}

export const scopedKey = (s: ScopedPermission) => `${s.permission}@${s.scopeType}:${s.scopeId}`;

export function applicationAccess(data: Pick<EnhancedPermissionData, 'permissions' | 'scoped'>, declared: string[]) {
  // Sorted here, not by the database, so the order doesn't depend on its collation
  const names = [...declared].sort();
  const permissions = names.filter((p) => permissionMatches(data.permissions, p));
  const everywhere = new Set(permissions);
  const byKey = new Map<string, ScopedPermission>();
  for (const g of data.scoped) {
    for (const p of names) {
      if (everywhere.has(p) || !permissionMatches([g.permission], p)) continue;
      const s = { permission: p, scopeType: g.scopeType, scopeId: g.scopeId };
      byKey.set(scopedKey(s), s);
    }
  }
  const scopedPermissions = [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s);
  return { permissions, scopedPermissions };
}
