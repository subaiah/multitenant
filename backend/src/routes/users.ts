import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { config } from '../config/env.js';
import { sendMail } from '../lib/mailer.js';
import { inviteEmail } from '../lib/email-templates.js';
import { INVITE_TTL_DAYS, issueUserToken } from '../lib/user-tokens.js';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { explainAccess } from '../lib/access.js';
import { endAllSessions } from '../lib/sessions.js';
import { AppError } from '../middleware/error-handler.js';
import { requireCanManageUserType } from '../utils/authorization.js';
import { AUTHENTICATED } from '../middleware/authorize.js';
import { hasPermission, requirePermission } from '../middleware/authorize.js';

const TENANT_USER_TYPES = ['TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER'] as const;

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  // This API manages users inside a tenant, so only tenant user types can be assigned.
  userType: z.enum(TENANT_USER_TYPES).default('TENANT_USER'),
});

const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  userType: z.enum(TENANT_USER_TYPES).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING']).optional(),
});

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).default(10),
  userType: z.enum(['PLATFORM_ADMIN', 'PLATFORM_USER', 'TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING']).optional(),
  search: z.string().optional(),
});

async function sendInvitation(request: FastifyRequest, user: { id: string; email: string }) {
  const inviter = await prisma.user.findUnique({ where: { id: request.user.userId }, select: { name: true, email: true } });
  const token = await issueUserToken(user.id, 'INVITE', INVITE_TTL_DAYS * 24 * 60 * 60 * 1000, request.user.userId);
  const link = `${config.frontendUrl}/accept-invite?token=${encodeURIComponent(token)}`;
  await sendMail(inviteEmail(user.email, link, request.tenant.name, inviter?.name || inviter?.email || 'An administrator', INVITE_TTL_DAYS));
}

export const userRoutes: FastifyPluginAsync = async (fastify) => {
  // List users for current tenant
  fastify.get('/', {
    config: { permission: 'users:read' },
    schema: {
      tags: ['users'],
      summary: 'List users for current tenant',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', default: '1' },
          limit: { type: 'string', default: '10' },
          userType: { type: 'string', enum: ['PLATFORM_ADMIN', 'PLATFORM_USER', 'TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER'] },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'PENDING'] },
          search: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { page, limit, userType, status, search } = querySchema.parse(request.query);
    const skip = (page - 1) * limit;

    const where = {
      tenantId: request.tenant.id,
      AND: [
        userType ? { userType } : {},
        status ? { status } : {},
        search
          ? {
              OR: [
                { email: { contains: search, mode: 'insensitive' as const } },
                { name: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {},
      ],
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          userType: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
        },
      }),
      prisma.user.count({ where }),
    ]);

    return {
      data: users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  });

  // Get current user
  fastify.get('/me', {
    config: { permission: AUTHENTICATED },
    schema: {
      tags: ['users'],
      summary: 'Get current user',
    },
  }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.userId },
      select: {
        id: true,
        email: true,
        name: true,
        userType: true,
        status: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });

    return user;
  });

  // Access review: what this user can do, and where each permission comes from
  fastify.get('/:id/access', {
    config: { permission: AUTHENTICATED },
    schema: {
      tags: ['users'],
      summary: "Explain a user's effective permissions and their sources",
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    // Your own access is always visible; anyone else's needs roles:read
    if (id !== request.user.userId) {
      await requirePermission(request, 'roles:read');
    }
    const review = await explainAccess(id, request.tenant.id, request.tenant.name);
    if (!review) {
      throw new AppError('User not found', 404);
    }
    return review;
  });

  // Get user by ID
  fastify.get('/:id', {
    config: { permission: AUTHENTICATED },
    schema: {
      tags: ['users'],
      summary: 'Get user by ID',
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

    // Anyone can read their own record; reading others needs users:read
    if (id !== request.user.userId) {
      await requirePermission(request, 'users:read');
    }

    const user = await prisma.user.findFirst({
      where: {
        id,
        tenantId: request.tenant.id,
      },
      select: {
        id: true,
        email: true,
        name: true,
        userType: true,
        status: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    return user;
  });

  // Create user
  fastify.post('/', {
    config: { permission: 'users:create' },
    schema: {
      tags: ['users'],
      summary: 'Create user',
      body: {
        type: 'object',
        required: ['email', 'name'],
        properties: {
          email: { type: 'string', format: 'email' },
          name: { type: 'string', minLength: 2 },
          userType: { type: 'string', enum: ['TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER'], default: 'TENANT_USER' },
        },
      },
    },
  }, async (request, reply) => {
    const data = createUserSchema.parse(request.body);
    requireCanManageUserType(request.user.userType, data.userType);

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: {
        tenantId_email: {
          tenantId: request.tenant.id,
          email: data.email,
        },
      },
    });

    if (existingUser) {
      throw new AppError('User with this email already exists', 409);
    }

    // New users are invited: they set their own password from the emailed link
    const user = await prisma.user.create({
      data: {
        ...data,
        tenantId: request.tenant.id,
        status: 'PENDING',
      },
      select: {
        id: true,
        email: true,
        name: true,
        userType: true,
        status: true,
        createdAt: true,
      },
    });

    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'invited user',
        target: user.email,
        type: 'USER',
      },
    });

    await sendInvitation(request, user);
    return reply.status(201).send({ ...user, invitationSent: true });
  });

  // Resend an invitation (invalidates the previous link)
  fastify.post('/:id/resend-invite', {
    config: { permission: 'users:create' },
    schema: {
      tags: ['users'],
      summary: 'Resend the invitation email to a pending user',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await prisma.user.findFirst({
      where: { id, tenantId: request.tenant.id },
      select: { id: true, email: true, name: true, userType: true, status: true },
    });
    if (!user) {
      throw new AppError('User not found', 404);
    }
    if (user.status !== 'PENDING') {
      throw new AppError('This user has already accepted their invitation', 409);
    }
    requireCanManageUserType(request.user.userType, user.userType);
    await sendInvitation(request, user);
    return { invitationSent: true };
  });

  // Update user
  fastify.patch('/:id', {
    config: { permission: AUTHENTICATED },
    schema: {
      tags: ['users'],
      summary: 'Update user',
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
          name: { type: 'string', minLength: 2 },
          userType: { type: 'string', enum: ['TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER'] },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'PENDING'] },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = updateUserSchema.parse(request.body);
    const actorType = request.user.userType;
    const isSelf = id === request.user.userId;

    const target = await prisma.user.findFirst({
      where: { id, tenantId: request.tenant.id },
      select: { userType: true },
    });
    if (!target) {
      throw new AppError('User not found', 404);
    }

    if (isSelf) {
      // Users may edit their own profile, but not their own type or status
      if (data.userType !== undefined || data.status !== undefined) {
        throw new AppError('You cannot change your own user type or status', 403);
      }
    } else {
      // Only admins can update other users, and only users ranked at or below them
      await requirePermission(request, 'users:update');
      requireCanManageUserType(actorType, target.userType);
      if (data.userType) {
        requireCanManageUserType(actorType, data.userType);
      }
    }

    const update = prisma.user.update({
      where: {
        id,
        tenantId: request.tenant.id,
      },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        userType: true,
        status: true,
        updatedAt: true,
      },
    });
    // Deactivating signs the person out everywhere, right away
    const [user] = data.status && data.status !== 'ACTIVE'
      ? await prisma.$transaction([update, ...endAllSessions(id)])
      : [await update];

    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'updated user',
        target: user.email,
        type: 'USER',
        metadata: data,
      },
    });

    return user;
  });

  // Delete user
  fastify.delete('/:id', {
    config: { permission: 'users:delete' },
    schema: {
      tags: ['users'],
      summary: 'Delete user',
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

    // Only admins can delete users

    // Prevent self-deletion
    if (id === request.user.userId) {
      throw new AppError('Cannot delete your own account', 400);
    }

    const target = await prisma.user.findFirst({
      where: { id, tenantId: request.tenant.id },
      select: { userType: true },
    });
    if (!target) {
      throw new AppError('User not found', 404);
    }
    requireCanManageUserType(request.user.userType, target.userType);

    await prisma.user.delete({
      where: {
        id,
        tenantId: request.tenant.id,
      },
    });

    return reply.status(204).send();
  });
};
