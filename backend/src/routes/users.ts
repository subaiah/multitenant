import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  userType: z.enum(['PLATFORM_ADMIN', 'PLATFORM_USER', 'TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER']).default('TENANT_USER'),
});

const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  userType: z.enum(['PLATFORM_ADMIN', 'PLATFORM_USER', 'TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING']).optional(),
});

const querySchema = z.object({
  page: z.string().transform(Number).default('1'),
  limit: z.string().transform(Number).default('10'),
  userType: z.enum(['PLATFORM_ADMIN', 'PLATFORM_USER', 'TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING']).optional(),
  search: z.string().optional(),
});

export const userRoutes: FastifyPluginAsync = async (fastify) => {
  // List users for current tenant
  fastify.get('/', {
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
                { email: { contains: search, mode: 'insensitive' } },
                { name: { contains: search, mode: 'insensitive' } },
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

  // Get user by ID
  fastify.get('/:id', {
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
    const { id } = request.params;

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
    schema: {
      tags: ['users'],
      summary: 'Create user',
      body: {
        type: 'object',
        required: ['email', 'name'],
        properties: {
          email: { type: 'string', format: 'email' },
          name: { type: 'string', minLength: 2 },
          userType: { type: 'string', enum: ['PLATFORM_ADMIN', 'PLATFORM_USER', 'TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER'], default: 'TENANT_USER' },
        },
      },
    },
  }, async (request, reply) => {
    // Only admins and managers can create users
    if (!['PLATFORM_ADMIN', 'PLATFORM_USER', 'TENANT_ADMIN', 'TENANT_MANAGER'].includes(request.user.userType)) {
      throw new AppError('Admin or Manager access required', 403);
    }

    const data = createUserSchema.parse(request.body);

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

    const user = await prisma.user.create({
      data: {
        ...data,
        tenantId: request.tenant.id,
        status: 'ACTIVE',
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
        action: 'created user',
        target: user.email,
        type: 'USER',
      },
    });

    return reply.status(201).send(user);
  });

  // Update user
  fastify.patch('/:id', {
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
          userType: { type: 'string', enum: ['PLATFORM_ADMIN', 'PLATFORM_USER', 'TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_DEVELOPER', 'TENANT_USER', 'TENANT_VIEWER'] },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'PENDING'] },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const data = updateUserSchema.parse(request.body);

    // Only admins can update users
    if (!['PLATFORM_ADMIN', 'TENANT_ADMIN'].includes(request.user.userType)) {
      throw new AppError('Admin access required', 403);
    }

    const user = await prisma.user.update({
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
    const { id } = request.params;

    // Only admins can delete users
    if (!['PLATFORM_ADMIN', 'TENANT_ADMIN'].includes(request.user.userType)) {
      throw new AppError('Admin access required', 403);
    }

    // Prevent self-deletion
    if (id === request.user.userId) {
      throw new AppError('Cannot delete your own account', 400);
    }

    await prisma.user.delete({
      where: {
        id,
        tenantId: request.tenant.id,
      },
    });

    return reply.status(204).send();
  });
};
