import { FastifyPluginAsync } from 'fastify';
import { sendInvitation, type InvitationResult } from '../lib/invitations.js';
import { emailTaken, newEmailSchema, requestEmailChange } from './my-account.js';

/** What the inviter is told: sent, or the link to share because the email failed */
const inviteOutcome = (r: InvitationResult) =>
  r.sent ? { invitationSent: true } : { invitationSent: false, inviteLink: r.link, emailError: r.error };
import { z } from 'zod';
import { explainAccess } from '../lib/access.js';
import { endAllSessions } from '../lib/sessions.js';
import { AppError } from '../middleware/error-handler.js';
import { requireCanManageUserType } from '../utils/authorization.js';
import { AUTHENTICATED } from '../middleware/authorize.js';
import { hasPermission, requirePermission } from '../middleware/authorize.js';
import { logActivity } from '../lib/activity.js';
import { audit, diff } from '../lib/audit.js';
import { resetTwoFactor } from './two-factor.js';
import { limitSchema, pageSchema } from '../lib/pagination.js';
import { assertWithinLimitFor } from '../lib/billing/plans.js';

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
  page: pageSchema.default(1),
  limit: limitSchema(10),
  userType: z.enum(['TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING']).optional(),
  search: z.string().optional(),
});

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
          userType: { type: 'string', enum: ['TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER'] },
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
      request.db.user.findMany({
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
          mfaEnabledAt: true,
        },
      }),
      request.db.user.count({ where }),
    ]);

    return {
      data: users.map(({ mfaEnabledAt, ...u }) => ({ ...u, mfaEnabled: Boolean(mfaEnabledAt) })),
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
    const user = await request.db.user.findUnique({
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
    const review = await explainAccess(request.db, id, request.tenant.id, request.tenant.name);
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

    const user = await request.db.user.findFirst({
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
    const existingUser = await request.db.user.findUnique({
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
    // Each person is a seat: the plan's limit applies
    await assertWithinLimitFor(request, 'users');

    // New users are invited: they set their own password from the emailed link
    const user = await request.db.user.create({
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
    await logActivity({
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'invited user',
        target: user.email,
        type: 'USER',
      });
    await audit(request, 'user.invited', { resource: { type: 'user', id: user.id, label: user.email }, details: { name: user.name, userType: user.userType } });

    // The invitation exists even if the email didn't go out: hand back the link to share another way
    const invite = await sendInvitation(request.tenant, user, request.user.userId);
    return reply.status(201).send({ ...user, ...inviteOutcome(invite) });
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
    const user = await request.db.user.findFirst({
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
    const invite = await sendInvitation(request.tenant, user, request.user.userId);
    await audit(request, 'user.invitation_resent', { resource: { type: 'user', id: user.id, label: user.email }, details: { emailed: invite.sent } });
    return inviteOutcome(invite);
  });

  // Correct someone's email address. Not yet accepted: the invitation moves to
  // the new address. Otherwise the new address confirms it (as when people
  // change their own; routes/my-account.ts), and the old one is told.
  fastify.post('/:id/email', {
    config: { permission: 'users:update' },
    schema: {
      tags: ['users'],
      summary: "Change a user's email address (confirmed from the new address)",
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { email: newEmail } = z.object({ email: newEmailSchema }).parse(request.body);
    if (id === request.user.userId) throw new AppError('Change your own email on your Profile page', 400);
    const user = await request.db.user.findFirst({ where: { id, tenantId: request.tenant.id }, select: { id: true, email: true, userType: true, status: true } });
    if (!user) throw new AppError('User not found', 404);
    requireCanManageUserType(request.user.userType, user.userType);
    if (newEmail === user.email.toLowerCase()) throw new AppError('That is already their email address', 400);
    const owner = { tenantId: request.tenant.id, tenantSlug: request.tenant.slug };
    if (await emailTaken(owner, newEmail, user.id)) throw new AppError('Another account already uses that email address', 409, true, 'EMAIL_TAKEN');

    if (user.status === 'PENDING') {
      // Nobody has used the account yet: invite the right address instead
      await request.db.user.update({ where: { id: user.id }, data: { email: newEmail } });
      const invite = await sendInvitation(request.tenant, { id: user.id, email: newEmail }, request.user.userId);
      await audit(request, 'user.updated', { resource: { type: 'user', id: user.id, label: newEmail }, changes: { email: [user.email, newEmail] } });
      return { email: newEmail, pendingEmail: null, ...inviteOutcome(invite) };
    }
    await requestEmailChange(owner, user, newEmail, request.user.userId);
    await audit(request, 'user.email_change_requested', { resource: { type: 'user', id: user.id, label: user.email }, details: { to: newEmail } });
    return { email: user.email, pendingEmail: { newEmail } };
  });

  // Clear a user's two-factor (lost device): they set it up again at their next sign-in
  fastify.post('/:id/mfa/reset', {
    config: { permission: 'users:update' },
    schema: {
      tags: ['users'],
      summary: "Reset a user's two-factor sign-in",
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await request.db.user.findFirst({
      where: { id, tenantId: request.tenant.id },
      select: { id: true, email: true, userType: true },
    });
    if (!user) throw new AppError('User not found', 404);
    requireCanManageUserType(request.user.userType, user.userType);
    await resetTwoFactor({ tenantId: request.tenant.id, tenantSlug: request.tenant.slug }, user.id);
    await logActivity({ tenantId: request.tenant.id, userId: request.user.userId, action: `reset two-factor for ${user.email}`, target: 'user', type: 'USER' });
    await audit(request, 'user.mfa_reset', { resource: { type: 'user', id: user.id, label: user.email } });
    return { mfaEnabled: false };
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

    const target = await request.db.user.findFirst({
      where: { id, tenantId: request.tenant.id },
      select: { userType: true, name: true, status: true },
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
    // Reactivating someone takes a seat again
    if (data.status === 'ACTIVE' && target.status === 'INACTIVE') await assertWithinLimitFor(request, 'users');

    const update = request.db.user.update({
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
      ? await request.db.$transaction([update, ...endAllSessions(request.db, id)])
      : [await update];

    // Log activity
    await logActivity({
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'updated user',
        target: user.email,
        type: 'USER',
        metadata: data,
      });
    const changes = diff(target, data);
    if (Object.keys(changes).length) {
      const event = changes.status && data.status === 'INACTIVE' ? 'user.deactivated'
        : changes.status && data.status === 'ACTIVE' ? 'user.reactivated' : 'user.updated';
      await audit(request, event, { resource: { type: 'user', id: user.id, label: user.email }, changes });
    }

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

    const target = await request.db.user.findFirst({
      where: { id, tenantId: request.tenant.id },
      select: { userType: true, email: true, name: true, status: true },
    });
    if (!target) {
      throw new AppError('User not found', 404);
    }
    requireCanManageUserType(request.user.userType, target.userType);

    await request.db.user.delete({
      where: {
        id,
        tenantId: request.tenant.id,
      },
    });
    await audit(request, 'user.deleted', { resource: { type: 'user', id, label: target.email }, details: { name: target.name, userType: target.userType, status: target.status } });

    return reply.status(204).send();
  });
};
