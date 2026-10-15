import { prisma } from './prisma.js';
import { PERMISSIONS, USER_TYPE_PERMISSIONS, isTenantGrantable, permissionMatches } from '../utils/permissions.js';

const permName = (rp: { permission: { resource: string; action: string } }) => `${rp.permission.resource}:${rp.permission.action}`;

/** Permissions a role carries, as `resource:action` strings. */
export async function rolePermissionNames(roleId: string): Promise<string[]> {
  const rows = await prisma.rolePermission.findMany({ where: { roleId }, include: { permission: true } });
  return rows.map(permName);
}

/**
 * Permissions that membership of this group grants (through every role
 * assigned to the group, active or scheduled; expired ones are ignored).
 */
export async function groupPermissionNames(groupId: string, tenantId: string): Promise<string[]> {
  const assignments = await prisma.roleAssignment.findMany({
    where: {
      tenantId,
      groupId,
      principalType: 'GROUP',
      status: 'ACTIVE',
      OR: [{ validTo: null }, { validTo: { gt: new Date() } }],
    },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  return [...new Set(assignments.flatMap((a) => a.role.permissions.map(permName)))];
}

/** ACTIVE / SCHEDULED / EXPIRED / INACTIVE, from status and validity window. */
export function assignmentState(a: { status: string; validFrom: Date; validTo: Date | null }, now = new Date()) {
  if (a.status !== 'ACTIVE') return 'INACTIVE';
  if (a.validTo && a.validTo <= now) return 'EXPIRED';
  if (a.validFrom > now) return 'SCHEDULED';
  return 'ACTIVE';
}

// ---------------------------------------------------------------------------
// Access review: everything a user can do in a tenant, and why.
// Mirrors getEnhancedUserPermissions (utils/authorization.ts), which is what
// the server enforces; test/access-review.test.ts checks the two agree.
// ---------------------------------------------------------------------------

export type AccessSourceKind = 'USER_TYPE' | 'ROLE' | 'GROUP' | 'DELEGATION';

export interface AccessSource {
  id: string;
  kind: AccessSourceKind;
  active: boolean;
  /** Why an inactive source grants nothing right now */
  inactiveReason?: string;
  roleId?: string;
  roleName?: string;
  assignmentId?: string;
  groupId?: string;
  groupName?: string;
  delegationId?: string;
  delegatorName?: string;
  scopeType?: string;
  scopeName?: string;
  validFrom?: Date;
  validTo?: Date | null;
  /** Catalog permissions this source grants (wildcards expanded) */
  permissions: string[];
  /** Permissions in the role that tenant roles can't grant, so they're ignored */
  ignored: string[];
}

export interface AccessReview {
  user: { id: string; email: string; name: string | null; userType: string; status: string };
  sources: AccessSource[];
  /** Permission -> ids of the active sources that grant it */
  effective: { permission: string; sources: string[] }[];
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

function windowReason(validFrom: Date, validTo: Date | null, now: Date, what: string): string | undefined {
  if (validFrom > now) return `${what} starts ${fmtDate(validFrom)}`;
  if (validTo && validTo <= now) return `${what} ended ${fmtDate(validTo)}`;
  return undefined;
}

function splitGrantable(perms: string[]) {
  const permissions: string[] = [];
  const ignored: string[] = [];
  for (const p of perms) (isTenantGrantable(p) && CATALOG.has(p) ? permissions : ignored).push(p);
  return { permissions, ignored };
}

const CATALOG = new Set<string>(PERMISSIONS);

export async function explainAccess(userId: string, tenantId: string, tenantName: string, now = new Date()): Promise<AccessReview | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId },
    select: { id: true, email: true, name: true, userType: true, status: true },
  });
  if (!user) return null;

  const roleInclude = { role: { include: { permissions: { include: { permission: true } } } } } as const;
  const [direct, memberships, delegations] = await Promise.all([
    prisma.roleAssignment.findMany({ where: { tenantId, userId, principalType: 'USER' }, include: roleInclude, orderBy: { createdAt: 'asc' } }),
    prisma.groupMembership.findMany({
      where: { tenantId, userId },
      include: { group: { include: { roleAssignments: { where: { principalType: 'GROUP' }, include: roleInclude, orderBy: { createdAt: 'asc' } } } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.delegation.findMany({
      where: { tenantId, delegateId: userId },
      include: { delegator: { select: { name: true, email: true } }, roleAssignment: { include: roleInclude } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  // Scope names for organizations and units
  const scopeIds = [...direct, ...memberships.flatMap((m) => m.group.roleAssignments), ...delegations.map((d) => d.roleAssignment)]
    .filter((a) => a.scopeType !== 'TENANT').map((a) => a.scopeId);
  const [orgs, units] = await Promise.all([
    prisma.organization.findMany({ where: { tenantId, id: { in: scopeIds } }, select: { id: true, name: true } }),
    prisma.orgUnit.findMany({ where: { tenantId, id: { in: scopeIds } }, select: { id: true, name: true } }),
  ]);
  const scopeNames = new Map<string, string>([...orgs, ...units].map((x) => [x.id, x.name]));
  const scopeOf = (a: { scopeType: string; scopeId: string }) => ({
    scopeType: a.scopeType,
    scopeName: a.scopeType === 'TENANT' ? tenantName : (scopeNames.get(a.scopeId) ?? a.scopeId),
  });
  const assignmentReason = (a: { status: string; validFrom: Date; validTo: Date | null }, what: string) =>
    a.status !== 'ACTIVE' ? `${what} is ${a.status.toLowerCase()}` : windowReason(a.validFrom, a.validTo, now, what);
  const rolePerms = (a: { role: { permissions: { permission: { resource: string; action: string } }[] } }) =>
    splitGrantable(a.role.permissions.map(permName));

  const sources: AccessSource[] = [];

  // 1. User type defaults (wildcards expanded against the catalog)
  const typeGrants = USER_TYPE_PERMISSIONS[user.userType as keyof typeof USER_TYPE_PERMISSIONS] ?? [];
  sources.push({
    id: 'type',
    kind: 'USER_TYPE',
    active: true,
    permissions: PERMISSIONS.filter((p) => isTenantGrantable(p) && permissionMatches(typeGrants, p)),
    ignored: [],
  });

  // 2. Roles assigned directly
  for (const a of direct) {
    const reason = assignmentReason(a, 'The assignment');
    sources.push({
      id: `role:${a.id}`, kind: 'ROLE', active: !reason, inactiveReason: reason,
      roleId: a.roleId, roleName: a.role.name, assignmentId: a.id, ...scopeOf(a),
      validFrom: a.validFrom, validTo: a.validTo, ...rolePerms(a),
    });
  }

  // 3. Roles through groups
  for (const m of memberships) {
    const membershipReason = windowReason(m.validFrom, m.validTo, now, 'Membership');
    const groupReason = m.group.status !== 'ACTIVE' ? 'The group is inactive' : undefined;
    if (m.group.roleAssignments.length === 0) {
      sources.push({
        id: `group:${m.id}`, kind: 'GROUP', active: false, inactiveReason: 'The group has no roles',
        groupId: m.groupId, groupName: m.group.name, validFrom: m.validFrom, validTo: m.validTo, permissions: [], ignored: [],
      });
      continue;
    }
    for (const a of m.group.roleAssignments) {
      const reason = groupReason ?? membershipReason ?? assignmentReason(a, "The group's role");
      sources.push({
        id: `group:${m.id}:${a.id}`, kind: 'GROUP', active: !reason, inactiveReason: reason,
        groupId: m.groupId, groupName: m.group.name, roleId: a.roleId, roleName: a.role.name, assignmentId: a.id, ...scopeOf(a),
        validFrom: a.validFrom, validTo: a.validTo, ...rolePerms(a),
      });
    }
  }

  // 4. Delegations received
  for (const d of delegations) {
    const reason = d.status !== 'ACTIVE'
      ? `The delegation is ${d.status.toLowerCase()}`
      : windowReason(d.validFrom, d.validTo, now, 'The delegation') ?? assignmentReason(d.roleAssignment, "The delegator's role");
    sources.push({
      id: `delegation:${d.id}`, kind: 'DELEGATION', active: !reason, inactiveReason: reason,
      delegationId: d.id, delegatorName: d.delegator.name || d.delegator.email,
      roleId: d.roleAssignment.roleId, roleName: d.roleAssignment.role.name, ...scopeOf(d.roleAssignment),
      validFrom: d.validFrom, validTo: d.validTo, ...rolePerms(d.roleAssignment),
    });
  }

  const grantedBy = new Map<string, string[]>();
  for (const s of sources) {
    if (!s.active) continue;
    for (const p of s.permissions) grantedBy.set(p, [...(grantedBy.get(p) ?? []), s.id]);
  }
  const effective = PERMISSIONS.filter((p) => grantedBy.has(p)).map((p) => ({ permission: p, sources: grantedBy.get(p)! }));

  return { user, sources, effective };
}
