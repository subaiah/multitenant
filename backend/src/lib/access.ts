import { prisma } from './prisma.js';

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
