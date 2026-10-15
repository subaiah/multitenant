import { AUTHENTICATED, requireCanGrant, requirePermission } from '../middleware/authorize.js';
import { assignmentState, rolePermissionNames } from '../lib/access.js';
import { isTenantGrantable } from '../utils/permissions.js';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { 
  requireUserType, 
  requireTenantAccess, 
  getUserPermissions,
  createDefaultTenantRoles,
  UserType 
} from '../utils/authorization.js';

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

/** A role may only hold tenant-level catalog permissions that the editor has. */
async function checkRolePermissions(request: FastifyRequest, permissions: string[]) {
  const refused = permissions.filter((p) => !isTenantGrantable(p));
  if (refused.length > 0) {
    throw new AppError(`These permissions can't be part of a tenant role: ${refused.join(', ')}`, 400);
  }
  await requireCanGrant(request, permissions, 'build a role with these permissions');
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
    const roles = await prisma.role.findMany({
      where: { tenantId: request.tenant.id },
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
        _count: {
          select: { users: true, roleAssignments: true },
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

    const role = await prisma.role.findFirst({
      where: { id, tenantId: request.tenant.id },
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
        users: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                userType: true,
              },
            },
          },
        },
      },
    });

    if (!role) {
      throw new AppError('Role not found', 404);
    }

    return role;
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
          description: { type: 'string' },
          tenantId: { type: 'string', format: 'uuid' },
          permissions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType as UserType;
    const data = createRoleSchema.parse(request.body);
    const tenantId = request.tenant.id;
    const bodyTenant = (request.body as { tenantId?: string }).tenantId;
    if (bodyTenant && bodyTenant !== tenantId) {
      throw new AppError('Access denied to this tenant', 403);
    }
    if (data.permissions) await checkRolePermissions(request, data.permissions);

    // Check if role name already exists
    const existingRole = await prisma.role.findFirst({
      where: { tenantId, name: data.name },
    });

    if (existingRole) {
      throw new AppError('Role name already exists', 409);
    }

    // Create role
    const role = await prisma.role.create({
      data: {
        tenantId,
        name: data.name,
        description: data.description,
        isSystem: false,
      },
    });

    // Assign permissions if provided
    if (data.permissions && data.permissions.length > 0) {
      const permissions = await prisma.permission.findMany({
        where: { name: { in: data.permissions } },
      });

      if (permissions.length !== data.permissions.length) {
        throw new AppError('Some permissions not found', 400);
      }

      await prisma.rolePermission.createMany({
        data: permissions.map(p => ({
          roleId: role.id,
          permissionId: p.id,
        })),
      });
    }

    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'created role',
        target: role.name,
        type: 'CONFIG',
      },
    });

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
          description: { type: 'string' },
          permissions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType as UserType;
    const { id } = request.params as { id: string };
    const data = updateRoleSchema.parse(request.body);

    const role = await prisma.role.findFirst({
      where: { id, tenantId: request.tenant.id },
    });

    if (!role) {
      throw new AppError('Role not found', 404);
    }

    // Can't update system roles
    if (role.isSystem) {
      throw new AppError('Cannot update system roles', 403);
    }

    if (data.permissions) {
      await checkRolePermissions(request, data.permissions);
      // Changing a role changes everyone who holds it
      await requireCanGrant(request, await rolePermissionNames(id), 'change this role');
    }

    // Update role
    const updatedRole = await prisma.role.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description,
      },
    });

    // Replace permissions if provided (all or nothing)
    if (data.permissions) {
      const permissions = await prisma.permission.findMany({
        where: { name: { in: data.permissions } },
      });
      if (permissions.length !== new Set(data.permissions).size) {
        throw new AppError('Some permissions not found', 400);
      }
      await prisma.$transaction([
        prisma.rolePermission.deleteMany({ where: { roleId: id } }),
        prisma.rolePermission.createMany({ data: permissions.map((p) => ({ roleId: id, permissionId: p.id })) }),
      ]);
    }

    // Log activity
    if (role.tenantId) {
      await prisma.activity.create({
        data: {
          tenantId: role.tenantId,
          userId,
          action: 'updated role',
          target: updatedRole.name,
          type: 'CONFIG',
        },
      });
    }

    return updatedRole;
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
    const userType = (request.user as any).userType as UserType;
    const { id } = request.params as { id: string };

    const role = await prisma.role.findFirst({
      where: { id, tenantId: request.tenant.id },
      include: {
        _count: {
          select: { users: true, roleAssignments: true },
        },
      },
    });

    if (!role) {
      throw new AppError('Role not found', 404);
    }

    // Can't delete system roles
    if (role.isSystem) {
      throw new AppError('Cannot delete system roles', 403);
    }

    // Check if role has users
    if (role._count.users > 0 || role._count.roleAssignments > 0) {
      throw new AppError('Cannot delete a role that is assigned. Remove its assignments first.', 400);
    }


    await prisma.role.delete({
      where: { id },
    });

    // Log activity
    if (role.tenantId) {
      await prisma.activity.create({
        data: {
          tenantId: role.tenantId,
          userId,
          action: 'deleted role',
          target: role.name,
          type: 'CONFIG',
        },
      });
    }

    return reply.status(204).send();
  });

  // Where a role can apply: the tenant, its organizations and their units
  fastify.get('/scopes', {
    config: { permission: 'roles:read' },
    schema: { tags: ['roles'], summary: 'Scopes a role can be assigned at' },
  }, async (request) => {
    const tenantId = request.tenant.id;
    const organizations = await prisma.organization.findMany({
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

    const assignments = await prisma.roleAssignment.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
        user: { select: { email: true, name: true, status: true } },
        group: { select: { name: true, status: true, _count: { select: { members: true } } } },
      },
    });

    // Resolve scope names in bulk
    const idsOf = (type: string) => assignments.filter((a) => a.scopeType === type).map((a) => a.scopeId);
    const [orgs, units] = await Promise.all([
      prisma.organization.findMany({ where: { tenantId, id: { in: idsOf('ORGANIZATION') } }, select: { id: true, name: true } }),
      prisma.orgUnit.findMany({ where: { tenantId, id: { in: idsOf('ORG_UNIT') } }, select: { id: true, name: true } }),
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
        permissions: a.role.permissions.map((rp) => `${rp.permission.resource}:${rp.permission.action}`),
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
      if (!(await prisma.organization.findFirst({ where: { id: scopeId, tenantId } }))) throw new AppError('Organization not found', 404);
    } else if (data.scopeType === 'ORG_UNIT') {
      if (!(await prisma.orgUnit.findFirst({ where: { id: scopeId, tenantId } }))) throw new AppError('Organization unit not found', 404);
    }
    
    const validFrom = data.validFrom ? new Date(data.validFrom) : new Date();
    const validTo = data.validTo ? new Date(data.validTo) : null;
    if (validTo && validTo <= validFrom) {
      throw new AppError('End date must be after the start date', 400);
    }
    
    // Verify role exists
    const role = await prisma.role.findFirst({
      where: { id: data.roleId, tenantId },
    });
    
    if (!role) {
      throw new AppError('Role not found', 404);
    }
    
    // Verify principal exists
    let principalName = '';
    if (data.principalType === 'USER') {
      const user = await prisma.user.findFirst({
        where: { id: data.userId, tenantId },
      });
      if (!user) {
        throw new AppError('User not found', 404);
      }
      principalName = user.email;
    } else {
      const group = await prisma.group.findFirst({
        where: { id: data.groupId, tenantId },
      });
      if (!group) {
        throw new AppError('Group not found', 404);
      }
      principalName = group.name;
    }
    
    await requireCanGrant(request, await rolePermissionNames(role.id), `assign ${role.name}`);
    
    // Check for existing assignment
    const existing = await prisma.roleAssignment.findFirst({
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
    
    const assignment = await prisma.roleAssignment.create({
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
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'assigned role',
        target: `${role.name} to ${data.principalType.toLowerCase()} ${principalName}`,
        type: 'USER',
      },
    });
    
    return reply.status(201).send(assignment);
  });

  async function removeAssignment(request: FastifyRequest, assignmentId: string) {
    const userId = (request.user as any).userId;
    const tenantId = request.tenant.id;

    const assignment = await prisma.roleAssignment.findFirst({
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
    await requireCanGrant(request, await rolePermissionNames(assignment.roleId), `remove ${assignment.role.name}`);
    
    await prisma.roleAssignment.delete({
      where: { id: assignmentId },
    });
    
    const principalName = assignment.principalType === 'USER' 
      ? assignment.user?.email 
      : assignment.group?.name;
    
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'removed role assignment',
        target: `${assignment.role.name} from ${assignment.principalType.toLowerCase()} ${principalName}`,
        type: 'USER',
      },
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

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        // Legacy UserRole (for backward compatibility)
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
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
                permissions: {
                  include: {
                    permission: true,
                  },
                },
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
      // Legacy roles (for backward compatibility)
      roles: user.roles.map(ur => ({
        id: ur.role.id,
        name: ur.role.name,
        description: ur.role.description,
        permissions: ur.role.permissions.map(rp => rp.permission.name),
      })),
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
        permissions: ra.role.permissions.map(rp => rp.permission.name),
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

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    // Only users in the current tenant; your own roles, or anyone's with roles:read
    if (!user || user.tenantId !== request.tenant.id) {
      throw new AppError('User not found', 404);
    }
    if (userId !== requesterId) {
      await requirePermission(request, 'roles:read');
    }

    const permissions = await getUserPermissions(userId, request.tenant.id);

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
    const permissions = await prisma.permission.findMany({
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
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
    const userType = (request.user as any).userType as UserType;
    const { tenantId } = request.params as { tenantId: string };

    // Only platform admins or tenant admins can initialize roles
    if (userType !== 'PLATFORM_ADMIN') {
      await requireTenantAccess(userId, tenantId);
    }

    await createDefaultTenantRoles(tenantId);

    // Log activity
    await prisma.activity.create({
      data: {
        tenantId,
        userId,
        action: 'initialized default roles',
        target: 'roles',
        type: 'CONFIG',
      },
    });

    return { message: 'Default roles initialized successfully' };
  });
};
