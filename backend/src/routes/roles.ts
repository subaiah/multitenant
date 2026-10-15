import { AUTHENTICATED, requireCanGrant, requirePermission } from '../middleware/authorize.js';
import { assignmentState, rolePermissionNames } from '../lib/access.js';
import { PERMISSIONS, PERMISSION_INFO, RESOURCE_INFO, isTenantGrantable } from '../utils/permissions.js';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler.js';
import { createDefaultTenantRoles, getEnhancedUserPermissions } from '../utils/authorization.js';
import type { TenantDb } from '../lib/tenant-db.js';
import { logActivity } from '../lib/activity.js';

// Validation schemas
const createRoleSchema = z.object({
  name: z.string().min(2).max(50),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

const updateRoleSchema = z.object({
  name: z.string().min(2).max(50).optional(),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

const assignRoleSchema = z.object({
  roleId: z.string().uuid(),
  principalType: z.enum(['USER', 'GROUP']),
  userId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
  scopeType: z.enum(['TENANT', 'ORGANIZATION', 'ORG_UNIT', 'RESOURCE']).default('TENANT'),
  scopeId: z.string().uuid().optional(), // defaults to the tenant for TENANT scope
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
});

const memberCount = (n: number) => `${n} ${n === 1 ? 'member' : 'members'}`;

/**
 * Check and resolve the permissions for a role: catalog names only, nothing
 * platform-level, and only what the editor holds. Returns the names.
 */
async function validRolePermissions(request: FastifyRequest, requested: string[]) {
  const names = [...new Set(requested)];
  const catalog = new Set<string>(PERMISSIONS);
  const unknown = names.filter((p) => !catalog.has(p));
  if (unknown.length > 0) {
    throw new AppError(`Unknown permissions: ${unknown.join(', ')}`, 400);
  }
  const refused = names.filter((p) => !isTenantGrantable(p));
  if (refused.length > 0) {
    throw new AppError(`These permissions can't be part of a tenant role: ${refused.join(', ')}`, 400);
  }
  await requireCanGrant(request, names, 'build a role with these permissions');
  return names;
}

async function requireUniqueRoleName(db: TenantDb, tenantId: string, name: string) {
  const clash = await db.role.findFirst({ where: { tenantId, name: { equals: name, mode: 'insensitive' } } });
  if (clash) throw new AppError(`A role called "${clash.name}" already exists`, 409);
}

export const roleRoutes: FastifyPluginAsync = async (fastify) => {
  // List all roles (platform-wide or tenant-specific)
  fastify.get('/', {
    config: { permission: 'roles:read' },
    schema: {
      tags: ['roles'],
      summary: 'List roles',
      querystring: {
        type: 'object',
        properties: {
          tenantId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request) => {
    // Roles belong to the current tenant (platform staff choose it with x-tenant-id)
    const { tenantId } = request.query as { tenantId?: string };
    if (tenantId && tenantId !== request.tenant.id) {
      throw new AppError('Access denied to this tenant', 403);
    }
    const roles = await request.db.role.findMany({
      where: { tenantId: request.tenant.id },
      include: {
        permissions: true,
        _count: {
          select: { roleAssignments: true },
        },
      },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });

    return { roles };
  });

  // Get role by ID
  fastify.get('/:id', {
    config: { permission: 'roles:read' },
    schema: {
      tags: ['roles'],
      summary: 'Get role by ID',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const role = await request.db.role.findFirst({
      where: { id, tenantId: request.tenant.id },
      include: {
        permissions: true,
        _count: { select: { roleAssignments: true } },
      },
    });

    if (!role) {
      throw new AppError('Role not found', 404);
    }

    return role;
  });

  // Permissions a tenant role can contain, grouped for the role editor
  fastify.get('/catalog', {
    // Names and descriptions only; also used to explain your own access
    config: { permission: AUTHENTICATED },
    schema: { tags: ['roles'], summary: 'Permissions available to tenant roles' },
  }, async () => {
    const groups = new Map<string, { resource: string; label: string; description: string; permissions: { name: string; action: string; description: string }[] }>();
    for (const name of PERMISSIONS) {
      if (!isTenantGrantable(name)) continue;
      const [resource, action] = name.split(':');
      const info = RESOURCE_INFO[resource] ?? { label: resource, description: '' };
      if (!groups.has(resource)) groups.set(resource, { resource, ...info, permissions: [] });
      groups.get(resource)!.permissions.push({ name, action, description: PERMISSION_INFO[name] ?? `${action} ${resource}` });
    }
    return { resources: [...groups.values()] };
  });

  // Create role
  fastify.post('/', {
    config: { permission: 'roles:manage' },
    schema: {
      tags: ['roles'],
      summary: 'Create role',
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 50 },
          description: { type: 'string', maxLength: 500 },
          tenantId: { type: 'string', format: 'uuid' },
          permissions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const data = createRoleSchema.parse(request.body);
    const tenantId = request.tenant.id;
    const bodyTenant = (request.body as { tenantId?: string }).tenantId;
    if (bodyTenant && bodyTenant !== tenantId) {
      throw new AppError('Access denied to this tenant', 403);
    }
    const name = data.name.trim();
    const permissions = await validRolePermissions(request, data.permissions ?? []);
    await requireUniqueRoleName(request.db, tenantId, name);

    const role = await request.db.role.create({
      data: {
        tenantId,
        name,
        description: data.description?.trim() || null,
        isSystem: false,
        permissions: { create: permissions.map((permission) => ({ tenantId, permission })) },
      },
    });

    await logActivity({ tenantId, userId, action: 'created role', target: role.name, type: 'CONFIG' });

    return reply.status(201).send(role);
  });

  // Update role
  fastify.patch('/:id', {
    config: { permission: 'roles:manage' },
    schema: {
      tags: ['roles'],
      summary: 'Update role',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 50 },
          description: { type: 'string', maxLength: 500 },
          permissions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request) => {
    const userId = (request.user as any).userId;
    const { id } = request.params as { id: string };
    const tenantId = request.tenant.id;
    const data = updateRoleSchema.parse(request.body);

    const role = await request.db.role.findFirst({ where: { id, tenantId } });
    if (!role) {
      throw new AppError('Role not found', 404);
    }
    // Built-in roles mirror the user types; duplicate one to customise it
    if (role.isSystem) {
      throw new AppError('Built-in roles can\'t be changed. Duplicate it and edit the copy.', 403);
    }

    const name = data.name?.trim();
    if (name && name !== role.name) await requireUniqueRoleName(request.db, tenantId, name);

    let permissions: string[] | undefined;
    let added: string[] = [];
    let removed: string[] = [];
    if (data.permissions) {
      permissions = await validRolePermissions(request, data.permissions);
      // Changing a role changes everyone who holds it, so the editor must
      // also cover what it grants today
      const before = await rolePermissionNames(request.db, id);
      await requireCanGrant(request, before, 'change this role');
      const after = new Set(permissions);
      added = [...after].filter((p) => !before.includes(p));
      removed = before.filter((p) => !after.has(p));
    }

    const updated = await request.db.$transaction(async (tx) => {
      const r = await tx.role.update({
        where: { id },
        data: { name, description: data.description === undefined ? undefined : data.description.trim() || null },
      });
      if (permissions) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ tenantId, roleId: id, permission })) });
      }
      return r;
    });

    const changes = [
      added.length && `+${added.join(', +')}`,
      removed.length && `-${removed.join(', -')}`,
    ].filter(Boolean).join('; ');
    await logActivity({
        tenantId,
        userId,
        action: 'updated role',
        target: changes ? `${updated.name} (${changes})`.slice(0, 500) : updated.name,
        type: 'CONFIG',
      });

    return updated;
  });

  // Delete role
  fastify.delete('/:id', {
    config: { permission: 'roles:manage' },
    schema: {
      tags: ['roles'],
      summary: 'Delete role',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const { id } = request.params as { id: string };
    const tenantId = request.tenant.id;

    const role = await request.db.role.findFirst({
      where: { id, tenantId },
      include: { _count: { select: { roleAssignments: true } } },
    });
    if (!role) {
      throw new AppError('Role not found', 404);
    }
    if (role.isSystem) {
      throw new AppError('Built-in roles can\'t be deleted', 403);
    }
    if (role._count.roleAssignments > 0) {
      throw new AppError('Cannot delete a role that is assigned. Remove its assignments first.', 400);
    }

    await request.db.role.delete({ where: { id } });
    await logActivity({ tenantId, userId, action: 'deleted role', target: role.name, type: 'CONFIG' });

    return reply.status(204).send();
  });

  // Where a role can apply: the tenant, its organizations and their units
  fastify.get('/scopes', {
    config: { permission: 'roles:read' },
    schema: { tags: ['roles'], summary: 'Scopes a role can be assigned at' },
  }, async (request) => {
    const tenantId = request.tenant.id;
    const organizations = await request.db.organization.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, units: { select: { id: true, name: true }, orderBy: { name: 'asc' } } },
    });
    return { tenant: { id: tenantId, name: request.tenant.name }, organizations };
  });

  // List role assignments in the current tenant (Role Assignments page)
  fastify.get('/assignments', {
    config: { permission: 'roles:read' },
    schema: {
      tags: ['roles'],
      summary: 'List role assignments in the current tenant',
    },
  }, async (request) => {
    const tenantId = request.tenant.id;

    const assignments = await request.db.roleAssignment.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      include: {
        role: { include: { permissions: true } },
        user: { select: { email: true, name: true, status: true } },
        group: { select: { name: true, status: true, _count: { select: { members: true } } } },
      },
    });

    // Resolve scope names in bulk
    const idsOf = (type: string) => assignments.filter((a) => a.scopeType === type).map((a) => a.scopeId);
    const [orgs, units] = await Promise.all([
      request.db.organization.findMany({ where: { tenantId, id: { in: idsOf('ORGANIZATION') } }, select: { id: true, name: true } }),
      request.db.orgUnit.findMany({ where: { tenantId, id: { in: idsOf('ORG_UNIT') } }, select: { id: true, name: true } }),
    ]);
    const scopeNames = new Map<string, string>([...orgs, ...units].map((x) => [x.id, x.name]));

    return {
      assignments: assignments.map((a) => ({
        id: a.id,
        roleId: a.roleId,
        roleName: a.role.name,
        principalType: a.principalType,
        userId: a.userId,
        groupId: a.groupId,
        principalName: a.principalType === 'USER' ? (a.user?.name || a.user?.email || 'Unknown user') : (a.group?.name || 'Unknown group'),
        principalDetail: a.principalType === 'USER' ? (a.user?.email ?? null) : memberCount(a.group?._count.members ?? 0),
        scopeType: a.scopeType,
        scopeId: a.scopeId,
        scopeName: a.scopeType === 'TENANT' ? request.tenant.name : (scopeNames.get(a.scopeId) ?? a.scopeId),
        validFrom: a.validFrom,
        validTo: a.validTo,
        status: a.status,
        state: assignmentState(a),
        permissions: a.role.permissions.map((rp) => rp.permission),
      })),
    };
  });

  // Assign role to user or group
  fastify.post('/assign', {
    config: { permission: 'roles:assign' },
    schema: {
      tags: ['roles'],
      summary: 'Assign role to user or group with scope',
      body: {
        type: 'object',
        required: ['roleId', 'principalType'],
        properties: {
          roleId: { type: 'string', format: 'uuid' },
          principalType: { type: 'string', enum: ['USER', 'GROUP'] },
          userId: { type: 'string', format: 'uuid' },
          groupId: { type: 'string', format: 'uuid' },
          scopeType: { type: 'string', enum: ['TENANT', 'ORGANIZATION', 'ORG_UNIT', 'RESOURCE'], default: 'TENANT' },
          scopeId: { type: 'string', format: 'uuid' },
          validFrom: { type: 'string', format: 'date-time' },
          validTo: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const tenantId = request.tenant.id;
    
    const data = assignRoleSchema.parse(request.body);
    
    // Validate principal
    if (data.principalType === 'USER' && !data.userId) {
      throw new AppError('userId is required for USER principal', 400);
    }
    if (data.principalType === 'GROUP' && !data.groupId) {
      throw new AppError('groupId is required for GROUP principal', 400);
    }
    
    // Validate scope: it must exist in this tenant
    let scopeId = data.scopeId;
    if (data.scopeType === 'TENANT') {
      if (scopeId && scopeId !== tenantId) throw new AppError('Tenant scope must be the current tenant', 400);
      scopeId = tenantId;
    } else if (!scopeId) {
      throw new AppError('scopeId is required for this scope', 400);
    } else if (data.scopeType === 'ORGANIZATION') {
      if (!(await request.db.organization.findFirst({ where: { id: scopeId, tenantId } }))) throw new AppError('Organization not found', 404);
    } else if (data.scopeType === 'ORG_UNIT') {
      if (!(await request.db.orgUnit.findFirst({ where: { id: scopeId, tenantId } }))) throw new AppError('Organization unit not found', 404);
    }
    
    const validFrom = data.validFrom ? new Date(data.validFrom) : new Date();
    const validTo = data.validTo ? new Date(data.validTo) : null;
    if (validTo && validTo <= validFrom) {
      throw new AppError('End date must be after the start date', 400);
    }
    
    // Verify role exists
    const role = await request.db.role.findFirst({
      where: { id: data.roleId, tenantId },
    });
    
    if (!role) {
      throw new AppError('Role not found', 404);
    }
    
    // Verify principal exists
    let principalName = '';
    if (data.principalType === 'USER') {
      const user = await request.db.user.findFirst({
        where: { id: data.userId, tenantId },
      });
      if (!user) {
        throw new AppError('User not found', 404);
      }
      principalName = user.email;
    } else {
      const group = await request.db.group.findFirst({
        where: { id: data.groupId, tenantId },
      });
      if (!group) {
        throw new AppError('Group not found', 404);
      }
      principalName = group.name;
    }
    
    await requireCanGrant(request, await rolePermissionNames(request.db, role.id), `assign ${role.name}`);
    
    // Check for existing assignment
    const existing = await request.db.roleAssignment.findFirst({
      where: {
        tenantId,
        roleId: data.roleId,
        principalType: data.principalType,
        ...(data.principalType === 'USER' ? { userId: data.userId } : { groupId: data.groupId }),
        scopeType: data.scopeType,
        scopeId,
      },
    });
    
    if (existing) {
      throw new AppError('Role already assigned with this scope', 409);
    }
    
    const assignment = await request.db.roleAssignment.create({
      data: {
        tenantId,
        roleId: data.roleId,
        principalType: data.principalType,
        userId: data.principalType === 'USER' ? data.userId : null,
        groupId: data.principalType === 'GROUP' ? data.groupId : null,
        scopeType: data.scopeType,
        scopeId,
        validFrom,
        validTo,
      },
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'assigned role',
        target: `${role.name} to ${data.principalType.toLowerCase()} ${principalName}`,
        type: 'USER',
      });
    
    return reply.status(201).send(assignment);
  });

  async function removeAssignment(request: FastifyRequest, assignmentId: string) {
    const userId = (request.user as any).userId;
    const tenantId = request.tenant.id;

    const assignment = await request.db.roleAssignment.findFirst({
      where: { id: assignmentId, tenantId },
      include: {
        role: true,
        user: { select: { email: true } },
        group: { select: { name: true } },
      },
    });
    
    if (!assignment) {
      throw new AppError('Role assignment not found', 404);
    }
    
    // Taking access away needs the same standing as granting it
    await requireCanGrant(request, await rolePermissionNames(request.db, assignment.roleId), `remove ${assignment.role.name}`);
    
    await request.db.roleAssignment.delete({
      where: { id: assignmentId },
    });
    
    const principalName = assignment.principalType === 'USER' 
      ? assignment.user?.email 
      : assignment.group?.name;
    
    await logActivity({
        tenantId,
        userId,
        action: 'removed role assignment',
        target: `${assignment.role.name} from ${assignment.principalType.toLowerCase()} ${principalName}`,
        type: 'USER',
      });
  }

  // Remove role assignment
  fastify.delete('/assignments/:id', {
    config: { permission: 'roles:assign' },
    schema: {
      tags: ['roles'],
      summary: 'Remove role assignment',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    await removeAssignment(request, (request.params as { id: string }).id);
    return reply.status(204).send();
  });

  // Remove role assignment (older form, assignment id in the body)
  fastify.delete('/unassign', {
    config: { permission: 'roles:assign' },
    schema: {
      tags: ['roles'],
      summary: 'Remove role assignment',
      body: {
        type: 'object',
        required: ['assignmentId'],
        properties: {
          assignmentId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request) => {
    await removeAssignment(request, (request.body as { assignmentId: string }).assignmentId);
    return { message: 'Role assignment removed successfully' };
  });

  // Get user roles and assignments
  fastify.get('/user/:userId', {
    config: { permission: AUTHENTICATED },
    schema: {
      tags: ['roles'],
      summary: 'Get user roles and assignments',
      params: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const requesterId = (request.user as any).userId;
    const { userId } = request.params as { userId: string };

    const user = await request.db.user.findFirst({
      where: { id: userId, tenantId: request.tenant.id },
      include: {
        // New RoleAssignment with scope
        roleAssignments: {
          where: {
            status: 'ACTIVE',
            validFrom: { lte: new Date() },
            OR: [
              { validTo: null },
              { validTo: { gt: new Date() } },
            ],
          },
          include: {
            role: {
              include: {
                permissions: true,
              },
            },
          },
        },
        // Group memberships
        groupMemberships: {
          where: {
            validFrom: { lte: new Date() },
            OR: [
              { validTo: null },
              { validTo: { gt: new Date() } },
            ],
          },
          include: {
            group: true,
          },
        },
      },
    });

    // Only users in the current tenant; your own roles, or anyone's with roles:read
    if (!user || user.tenantId !== request.tenant.id) {
      throw new AppError('User not found', 404);
    }
    if (userId !== requesterId) {
      await requirePermission(request, 'roles:read');
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        userType: user.userType,
      },
      // New role assignments with scope
      roleAssignments: user.roleAssignments.map(ra => ({
        id: ra.id,
        roleId: ra.roleId,
        roleName: ra.role.name,
        roleDescription: ra.role.description,
        scopeType: ra.scopeType,
        scopeId: ra.scopeId,
        validFrom: ra.validFrom,
        validTo: ra.validTo,
        permissions: ra.role.permissions.map((rp) => rp.permission),
      })),
      // Group memberships
      groups: user.groupMemberships.map(gm => ({
        id: gm.group.id,
        name: gm.group.name,
        description: gm.group.description,
        validFrom: gm.validFrom,
        validTo: gm.validTo,
      })),
    };
  });

  // Get user permissions
  fastify.get('/user/:userId/permissions', {
    config: { permission: AUTHENTICATED },
    schema: {
      tags: ['roles'],
      summary: 'Get user permissions',
      params: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const requesterId = (request.user as any).userId;
    const { userId } = request.params as { userId: string };

    const user = await request.db.user.findFirst({
      where: { id: userId, tenantId: request.tenant.id },
    });

    // Only users in the current tenant; your own roles, or anyone's with roles:read
    if (!user || user.tenantId !== request.tenant.id) {
      throw new AppError('User not found', 404);
    }
    if (userId !== requesterId) {
      await requirePermission(request, 'roles:read');
    }

    const { permissions } = await getEnhancedUserPermissions(userId, request.tenant.id, user.userType);

    return { permissions };
  });

  // List all permissions
  fastify.get('/permissions/list', {
    config: { permission: 'roles:read' },
    schema: {
      tags: ['roles'],
      summary: 'List all available permissions',
    },
  }, async (request, reply) => {
    // The catalogue lives in code (utils/permissions.ts)
    const permissions = [...PERMISSIONS].sort().map((name) => {
      const [resource, action] = name.split(':');
      return { name, resource, action, description: PERMISSION_INFO[name] ?? `${action} ${resource}` };
    });

    return { permissions };
  });

  // Initialize default roles for tenant
  fastify.post('/initialize/:tenantId', {
    config: { permission: 'roles:manage' },
    schema: {
      tags: ['roles'],
      summary: 'Initialize default roles for tenant',
      params: {
        type: 'object',
        required: ['tenantId'],
        properties: {
          tenantId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const { tenantId } = request.params as { tenantId: string };

    // Only the tenant being worked in (platform staff select it with x-tenant-id)
    if (tenantId !== request.tenant.id) {
      throw new AppError('Access denied to this tenant', 403);
    }

    await createDefaultTenantRoles(tenantId, request.db);

    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'initialized default roles',
        target: 'roles',
        type: 'CONFIG',
      });

    return { message: 'Default roles initialized successfully' };
  });
};
