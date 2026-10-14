import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType, isPlatformAdmin } from '../utils/authorization.js';

const createMenuItemSchema = z.object({
  portal: z.enum(['PLATFORM', 'TENANT']),
  parentId: z.string().uuid().optional(),
  label: z.string().min(1).max(100),
  path: z.string().min(1).max(200),
  icon: z.string().optional(),
  permission: z.string().optional(),
  order: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

const updateMenuItemSchema = z.object({
  parentId: z.string().uuid().nullable().optional(),
  label: z.string().min(1).max(100).optional(),
  path: z.string().min(1).max(200).optional(),
  icon: z.string().nullable().optional(),
  permission: z.string().nullable().optional(),
  order: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const menuItemRoutes: FastifyPluginAsync = async (fastify) => {
  // Get menu items for a portal (public endpoint for authenticated users)
  fastify.get('/portal/:portal', {
    schema: {
      tags: ['menu-items'],
      summary: 'Get menu items for a portal',
      params: {
        type: 'object',
        required: ['portal'],
        properties: {
          portal: { type: 'string', enum: ['PLATFORM', 'TENANT'] },
        },
      },
    },
  }, async (request, reply) => {
    const { portal } = request.params as { portal: 'PLATFORM' | 'TENANT' };
    const userId = (request.user as any).userId;
    const tenantId = (request.user as any).tenantId;
    
    // Get all active menu items for the portal
    const menuItems = await prisma.menuItem.findMany({
      where: {
        portal,
        isActive: true,
      },
      orderBy: { order: 'asc' },
      include: {
        children: {
          where: { isActive: true },
          orderBy: { order: 'asc' },
        },
      },
    });
    
    // Get user permissions
    const { getUserPermissions } = await import('../utils/authorization.js');
    const userPermissions = await getUserPermissions(userId, tenantId);
    
    // Filter menu items based on permissions
    const filteredItems = menuItems.filter(item => {
      if (!item.permission) return true; // No permission required
      return userPermissions.includes(item.permission) || userPermissions.includes('*');
    }).map(item => ({
      ...item,
      children: item.children.filter(child => {
        if (!child.permission) return true;
        return userPermissions.includes(child.permission) || userPermissions.includes('*');
      }),
    }));
    
    return { menuItems: filteredItems };
  });

  // List all menu items (admin only)
  fastify.get('/', {
    schema: {
      tags: ['menu-items'],
      summary: 'List all menu items',
      querystring: {
        type: 'object',
        properties: {
          portal: { type: 'string', enum: ['PLATFORM', 'TENANT'] },
        },
      },
    },
  }, async (request, reply) => {
    const userType = (request.user as any).userType;
    const { portal } = request.query as { portal?: 'PLATFORM' | 'TENANT' };
    
    // Only platform admins can manage menu items
    if (!isPlatformAdmin(userType)) {
      throw new AppError('Only platform admins can manage menu items', 403);
    }
    
    const where = portal ? { portal } : {};
    
    const menuItems = await prisma.menuItem.findMany({
      where,
      orderBy: [{ portal: 'asc' }, { order: 'asc' }],
      include: {
        parent: {
          select: { id: true, label: true },
        },
        children: {
          orderBy: { order: 'asc' },
        },
        _count: {
          select: { children: true },
        },
      },
    });
    
    return { menuItems };
  });

  // Get menu item by ID
  fastify.get('/:id', {
    schema: {
      tags: ['menu-items'],
      summary: 'Get menu item by ID',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userType = (request.user as any).userType;
    const { id } = request.params as { id: string };
    
    if (!isPlatformAdmin(userType)) {
      throw new AppError('Only platform admins can view menu items', 403);
    }
    
    const menuItem = await prisma.menuItem.findUnique({
      where: { id },
      include: {
        parent: true,
        children: {
          orderBy: { order: 'asc' },
        },
      },
    });
    
    if (!menuItem) {
      throw new AppError('Menu item not found', 404);
    }
    
    return menuItem;
  });

  // Create menu item
  fastify.post('/', {
    schema: {
      tags: ['menu-items'],
      summary: 'Create menu item',
      body: {
        type: 'object',
        required: ['portal', 'label', 'path'],
        properties: {
          portal: { type: 'string', enum: ['PLATFORM', 'TENANT'] },
          parentId: { type: 'string', format: 'uuid' },
          label: { type: 'string', minLength: 1, maxLength: 100 },
          path: { type: 'string', minLength: 1, maxLength: 200 },
          icon: { type: 'string' },
          permission: { type: 'string' },
          order: { type: 'number', minimum: 0 },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    
    if (!isPlatformAdmin(userType)) {
      throw new AppError('Only platform admins can create menu items', 403);
    }
    
    const data = createMenuItemSchema.parse(request.body);
    
    // Verify parent exists if provided
    if (data.parentId) {
      const parent = await prisma.menuItem.findUnique({
        where: { id: data.parentId },
      });
      
      if (!parent) {
        throw new AppError('Parent menu item not found', 404);
      }
      
      if (parent.portal !== data.portal) {
        throw new AppError('Parent menu item must be in the same portal', 400);
      }
    }
    
    const menuItem = await prisma.menuItem.create({
      data,
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant.id,
        userId,
        action: 'created menu item',
        target: menuItem.label,
        type: 'CONFIG',
      },
    });
    
    return reply.status(201).send(menuItem);
  });

  // Update menu item
  fastify.patch('/:id', {
    schema: {
      tags: ['menu-items'],
      summary: 'Update menu item',
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
          parentId: { type: 'string', format: 'uuid' },
          label: { type: 'string', minLength: 1, maxLength: 100 },
          path: { type: 'string', minLength: 1, maxLength: 200 },
          icon: { type: 'string' },
          permission: { type: 'string' },
          order: { type: 'number', minimum: 0 },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { id } = request.params as { id: string };
    
    if (!isPlatformAdmin(userType)) {
      throw new AppError('Only platform admins can update menu items', 403);
    }
    
    const data = updateMenuItemSchema.parse(request.body);
    
    // Verify parent exists if provided
    if (data.parentId) {
      const parent = await prisma.menuItem.findUnique({
        where: { id: data.parentId },
      });
      
      if (!parent) {
        throw new AppError('Parent menu item not found', 404);
      }
      
      const menuItem = await prisma.menuItem.findUnique({ where: { id } });
      if (menuItem && parent.portal !== menuItem.portal) {
        throw new AppError('Parent menu item must be in the same portal', 400);
      }
    }
    
    const menuItem = await prisma.menuItem.update({
      where: { id },
      data,
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant.id,
        userId,
        action: 'updated menu item',
        target: menuItem.label,
        type: 'CONFIG',
      },
    });
    
    return menuItem;
  });

  // Delete menu item
  fastify.delete('/:id', {
    schema: {
      tags: ['menu-items'],
      summary: 'Delete menu item',
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
    const userType = (request.user as any).userType;
    const { id } = request.params as { id: string };
    
    if (!isPlatformAdmin(userType)) {
      throw new AppError('Only platform admins can delete menu items', 403);
    }
    
    const menuItem = await prisma.menuItem.delete({
      where: { id },
    });
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant.id,
        userId,
        action: 'deleted menu item',
        target: menuItem.label,
        type: 'CONFIG',
      },
    });
    
    return reply.status(204).send();
  });

  // Reorder menu items
  fastify.post('/reorder', {
    schema: {
      tags: ['menu-items'],
      summary: 'Reorder menu items',
      body: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'order'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                order: { type: 'number', minimum: 0 },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { items } = request.body as { items: Array<{ id: string; order: number }> };
    
    if (!isPlatformAdmin(userType)) {
      throw new AppError('Only platform admins can reorder menu items', 403);
    }
    
    // Update all items in a transaction
    await prisma.$transaction(
      items.map(item =>
        prisma.menuItem.update({
          where: { id: item.id },
          data: { order: item.order },
        })
      )
    );
    
    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant.id,
        userId,
        action: 'reordered menu items',
        target: `${items.length} items`,
        type: 'CONFIG',
      },
    });
    
    return { message: 'Menu items reordered successfully' };
  });
};
