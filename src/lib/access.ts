/** Shapes returned by /roles and /groups, shared by the access pages. */

export interface Role {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: { permission: string }[];
  _count: { roleAssignments: number };
}

export interface Scopes {
  tenant: { id: string; name: string };
  organizations: { id: string; name: string; units: { id: string; name: string }[] }[];
}

export type ScopeType = 'TENANT' | 'ORGANIZATION' | 'ORG_UNIT' | 'RESOURCE';
export type AssignmentState = 'ACTIVE' | 'SCHEDULED' | 'EXPIRED' | 'INACTIVE';

export const rolePermissions = (role: Role) => role.permissions.map((p) => p.permission);

export const SCOPE_LABEL: Record<ScopeType, string> = {
  TENANT: 'Entire tenant',
  ORGANIZATION: 'Organization',
  ORG_UNIT: 'Unit',
  RESOURCE: 'Resource',
};

/** "12 Mar 2026 – no end" style validity text. */
export function validityText(from: string, to: string | null) {
  const fmt = (d: string) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return `${fmt(from)} – ${to ? fmt(to) : 'no end'}`;
}
