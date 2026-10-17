/**
 * Platform roles: sets of platform permissions for platform users, on top of
 * their user type (PLATFORM_ADMIN has everything; PLATFORM_USER a read-only
 * baseline). So "support engineer" or "auditor" doesn't mean "admin".
 *
 * Built-in roles are created and kept current at start-up; admins can add
 * their own. Only platform permissions can go in a platform role
 * (isPlatformGrantable): tenant data is reached only through support
 * sessions (lib/support.ts).
 */
import { controlDb } from './prisma.js';
import { isPlatformGrantable } from '../utils/permissions.js';

export const SYSTEM_PLATFORM_ROLES: { name: string; description: string; permissions: string[] }[] = [
  {
    name: 'Tenant Operations',
    description: 'Create, change, suspend and delete tenants; run tenant migrations',
    permissions: ['platform:read', 'tenants:read', 'tenants:manage'],
  },
  {
    name: 'Support',
    description: 'Ask for time-limited, read-only access to a tenant to help its people',
    permissions: ['platform:read', 'tenants:read', 'support:request'],
  },
  {
    name: 'Support Manager',
    description: 'Approve, review and end support sessions',
    permissions: ['platform:read', 'tenants:read', 'support:request', 'support:manage', 'platform-audit:read'],
  },
  {
    name: 'Auditor',
    description: 'Read the platform audit log, check any audit log and export it',
    permissions: ['platform:read', 'tenants:read', 'platform-audit:read', 'platform-audit:manage', 'platform-users:read'],
  },
  {
    name: 'Catalogue Manager',
    description: 'Manage the application catalogue and the portal menus',
    permissions: ['platform:read', 'applications:read', 'applications:manage', 'app-registry:manage', 'menus:manage'],
  },
  {
    name: 'Platform User Manager',
    description: 'Give platform roles to platform users and define custom roles',
    permissions: ['platform:read', 'platform-users:read', 'platform-users:manage'],
  },
];

/** Create the built-in roles, or bring them up to date (idempotent; run at start-up). */
export async function ensurePlatformRoles(): Promise<void> {
  for (const r of SYSTEM_PLATFORM_ROLES) {
    const write = () =>
      controlDb.platformRole.upsert({
        where: { name: r.name },
        create: { ...r, isSystem: true },
        update: { description: r.description, permissions: r.permissions, isSystem: true },
      });
    // Several servers starting at once: whoever loses the create race updates instead
    await write().catch((err: { code?: string }) => (err.code === 'P2002' ? write() : Promise.reject(err)));
  }
}

/** A platform user's roles and the permissions they add. */
export async function platformRolePermissions(platformUserId: string): Promise<{ role: string; permissions: string[] }[]> {
  const assignments = await controlDb.platformRoleAssignment.findMany({
    where: { platformUserId },
    include: { role: { select: { name: true, permissions: true } } },
  });
  // Defensive: only platform permissions count, whatever is stored
  return assignments.map((a) => ({ role: a.role.name, permissions: a.role.permissions.filter(isPlatformGrantable) }));
}
