/**
 * Platform roles (lib/platform-roles.ts): define them and give them to
 * platform users. Only platform permissions can go in them, and nobody can
 * hand out permissions they don't hold themselves.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { requireCanGrant } from '../middleware/authorize.js';
import { audit, diff } from '../lib/audit.js';
import { isPlatformUser } from '../utils/authorization.js';
import { PERMISSIONS, PERMISSION_INFO, isPlatformGrantable } from '../utils/permissions.js';

const roleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(z.string()).min(1).max(100),
});

function checkPermissions(permissions: string[]) {
  const bad = permissions.filter((p) => !isPlatformGrantable(p) || !PERMISSIONS.includes(p));
  if (bad.length) throw new AppError(`Not platform permissions: ${bad.join(', ')}`, 400);
}

export const platformRoleRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    if (!isPlatformUser(request.user.userType)) throw new AppError('Platform access required', 403);
  });

  fastify.get('/', {
    config: { permission: 'platform-users:read' },
    schema: { tags: ['platform'], summary: 'Platform roles, and the permissions they can contain' },
  }, async () => {
    const roles = await controlDb.platformRole.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { assignments: true } } },
    });
    return {
      roles: roles.map(({ _count, ...r }) => ({ ...r, holders: _count.assignments })),
      permissions: PERMISSIONS.filter(isPlatformGrantable).map((name) => ({ name, description: PERMISSION_INFO[name] ?? name })),
    };
  });

  fastify.post('/', {
    config: { permission: 'platform-users:manage' },
    schema: { tags: ['platform'], summary: 'Create a platform role' },
  }, async (request, reply) => {
    const data = roleSchema.parse(request.body);
    checkPermissions(data.permissions);
    await requireCanGrant(request, data.permissions, 'create this role');
    if (await controlDb.platformRole.findUnique({ where: { name: data.name } })) throw new AppError('A role with this name already exists', 409);
    const role = await controlDb.platformRole.create({ data: { ...data, isSystem: false } });
    await audit(request, 'platform_role.created', { resource: { type: 'platform_role', id: role.id, label: role.name }, details: { permissions: role.permissions } });
    return reply.status(201).send(role);
  });

  fastify.patch('/:id', {
    config: { permission: 'platform-users:manage' },
    schema: { tags: ['platform'], summary: 'Change a platform role (not the built-in ones)' },
  }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const data = roleSchema.partial().parse(request.body);
    const role = await controlDb.platformRole.findUnique({ where: { id } });
    if (!role) throw new AppError('Role not found', 404);
    if (role.isSystem) throw new AppError("Built-in roles can't be changed", 403);
    if (data.permissions) {
      checkPermissions(data.permissions);
      // It changes what everyone holding it can do: the editor must cover old and new
      await requireCanGrant(request, [...role.permissions, ...data.permissions], 'change this role');
    }
    if (data.name && data.name !== role.name && (await controlDb.platformRole.findUnique({ where: { name: data.name } }))) {
      throw new AppError('A role with this name already exists', 409);
    }
    const updated = await controlDb.platformRole.update({ where: { id }, data });
    await audit(request, 'platform_role.updated', { resource: { type: 'platform_role', id, label: updated.name }, changes: diff(role, data) });
    return updated;
  });

  fastify.delete('/:id', {
    config: { permission: 'platform-users:manage' },
    schema: { tags: ['platform'], summary: 'Delete a platform role (not the built-in ones)' },
  }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const role = await controlDb.platformRole.findUnique({ where: { id }, include: { assignments: { include: { platformUser: { select: { email: true } } } } } });
    if (!role) throw new AppError('Role not found', 404);
    if (role.isSystem) throw new AppError("Built-in roles can't be deleted", 403);
    await requireCanGrant(request, role.permissions, 'delete this role');
    await controlDb.platformRole.delete({ where: { id } });
    await audit(request, 'platform_role.deleted', {
      resource: { type: 'platform_role', id, label: role.name },
      details: { permissions: role.permissions, heldBy: role.assignments.map((a) => a.platformUser.email) },
    });
    return reply.status(204).send();
  });

  fastify.put('/users/:userId', {
    config: { permission: 'platform-users:manage' },
    schema: { tags: ['platform'], summary: "Set a platform user's roles" },
  }, async (request) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    const { roleIds } = z.object({ roleIds: z.array(z.string().uuid()).max(50) }).parse(request.body);
    const user = await controlDb.platformUser.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user) throw new AppError('User not found', 404);
    const roles = await controlDb.platformRole.findMany({ where: { id: { in: roleIds } } });
    if (roles.length !== new Set(roleIds).size) throw new AppError('Role not found', 404);

    const current = await controlDb.platformRoleAssignment.findMany({ where: { platformUserId: userId }, include: { role: true } });
    const adding = roles.filter((r) => !current.some((c) => c.roleId === r.id));
    const removing = current.filter((c) => !roleIds.includes(c.roleId));
    // Giving a role, or taking one away, needs standing over what it grants
    await requireCanGrant(request, [...adding.flatMap((r) => r.permissions), ...removing.flatMap((c) => c.role.permissions)], "change this person's roles");

    await controlDb.$transaction([
      controlDb.platformRoleAssignment.deleteMany({ where: { platformUserId: userId, roleId: { in: removing.map((c) => c.roleId) } } }),
      controlDb.platformRoleAssignment.createMany({ data: adding.map((r) => ({ platformUserId: userId, roleId: r.id, assignedBy: request.user.userId })) }),
    ]);
    for (const r of adding) {
      await audit(request, 'platform_role.assigned', { resource: { type: 'platform_role', id: r.id, label: r.name }, details: { userId, user: user.email, permissions: r.permissions } });
    }
    for (const c of removing) {
      await audit(request, 'platform_role.unassigned', { resource: { type: 'platform_role', id: c.roleId, label: c.role.name }, details: { userId, user: user.email } });
    }
    return { roles: roles.map((r) => ({ id: r.id, name: r.name })) };
  });
};
