import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType, isPlatformAdmin, getEnhancedUserPermissions } from '../utils/authorization.js';
import { permissionMatches } from '../utils/permissions.js';
import { AUTHENTICATED } from '../middleware/authorize.js';
import { logActivity } from '../lib/activity.js';
import { audit } from '../lib/audit.js';

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
    config: { permission: AUTHENTICATED },
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
    const { userId, userType } = request.user;
    const tenantId = request.tenant?.id;

    // Each user only sees their own portal's menu
    const ownPortal = userType.startsWith('PLATFORM_') ? 'PLATFORM' : 'TENANT';
    if (portal !== ownPortal) {
      throw new AppError('Access denied to this portal', 403);
    }
    
    // Get all active menu items for the portal
    const menuItems = await controlDb.menuItem.findMany({
      where: {
        portal,
        isActive: true,
        parentId: null, // children are nested below; don't list them twice
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
    // Same effective permissions the frontend guards use (user type + roles)
    const { permissions } = await getEnhancedUserPermissions(userId, tenantId, userType);
    const granted = new Set(permissions);
    
    // Filter menu items based on permissions
    const filteredItems = menuItems.filter(item => {
      if (!item.permission) return true; // No permission required
      return permissionMatches(granted, item.permission);
    }).map(item => ({
      ...item,
      children: item.children.filter(child => {
        if (!child.permission) return true;
        return permissionMatches(granted, child.permission);
      }),
    }));
    
    return { menuItems: filteredItems };
  });

  // List all menu items (admin only)
  fastify.get('/', {
    config: { permission: 'menus:manage' },
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
    
    const where = portal ? { portal } : {};
    
    const menuItems = await controlDb.menuItem.findMany({
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
    config: { permission: 'menus:manage' },
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
    
    
    const menuItem = await controlDb.menuItem.findUnique({
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
    config: { permission: 'menus:manage' },
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
    
    
    const data = createMenuItemSchema.parse(request.body);
    
    // Verify parent exists if provided
    if (data.parentId) {
      const parent = await controlDb.menuItem.findUnique({
        where: { id: data.parentId },
      });
      
      if (!parent) {
        throw new AppError('Parent menu item not found', 404);
      }
      
      if (parent.portal !== data.portal) {
        throw new AppError('Parent menu item must be in the same portal', 400);
      }
    }
    
    const menuItem = await controlDb.menuItem.create({
      data,
    });
    
    // Log activity
    await logActivity({
        tenantId: null, // platform-level: the platform activity log
        userId,
        action: 'created menu item',
        target: menuItem.label,
        type: 'CONFIG',
      });
    await audit(request, 'menu.changed', { resource: { type: 'menu_item', label: 'created menu item' }, details: { action: 'created menu item', body: request.body as Record<string, unknown> | undefined, params: request.params as Record<string, unknown> } });
    
    return reply.status(201).send(menuItem);
  });

  // Update menu item
  fastify.patch('/:id', {
    config: { permission: 'menus:manage' },
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
    
    
    const data = updateMenuItemSchema.parse(request.body);
    
    // Verify parent exists if provided
    if (data.parentId) {
      const parent = await controlDb.menuItem.findUnique({
        where: { id: data.parentId },
      });
      
      if (!parent) {
        throw new AppError('Parent menu item not found', 404);
      }
      
      const menuItem = await controlDb.menuItem.findUnique({ where: { id } });
      if (menuItem && parent.portal !== menuItem.portal) {
        throw new AppError('Parent menu item must be in the same portal', 400);
      }
    }
    
    const menuItem = await controlDb.menuItem.update({
      where: { id },
      data,
    });
    
    // Log activity
    await logActivity({
        tenantId: null, // platform-level: the platform activity log
        userId,
        action: 'updated menu item',
        target: menuItem.label,
        type: 'CONFIG',
      });
    await audit(request, 'menu.changed', { resource: { type: 'menu_item', label: 'updated menu item' }, details: { action: 'updated menu item', body: request.body as Record<string, unknown> | undefined, params: request.params as Record<string, unknown> } });
    
    return menuItem;
  });

  // Delete menu item
  fastify.delete('/:id', {
    config: { permission: 'menus:manage' },
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
    
    
    const menuItem = await controlDb.menuItem.delete({
      where: { id },
    });
    
    // Log activity
    await logActivity({
        tenantId: null, // platform-level: the platform activity log
        userId,
        action: 'deleted menu item',
        target: menuItem.label,
        type: 'CONFIG',
      });
    await audit(request, 'menu.changed', { resource: { type: 'menu_item', label: 'deleted menu item' }, details: { action: 'deleted menu item', body: request.body as Record<string, unknown> | undefined, params: request.params as Record<string, unknown> } });
    
    return reply.status(204).send();
  });

  // Reorder menu items
  fastify.post('/reorder', {
    config: { permission: 'menus:manage' },
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
    
    
    // Update all items in a transaction
    await controlDb.$transaction(
      items.map(item =>
        controlDb.menuItem.update({
          where: { id: item.id },
          data: { order: item.order },
        })
      )
    );
    
    // Log activity
    await logActivity({
        tenantId: null, // platform-level: the platform activity log
        userId,
        action: 'reordered menu items',
        target: `${items.length} items`,
        type: 'CONFIG',
      });
    await audit(request, 'menu.changed', { resource: { type: 'menu_item', label: 'reordered menu items' }, details: { action: 'reordered menu items', body: request.body as Record<string, unknown> | undefined, params: request.params as Record<string, unknown> } });
    
    return { message: 'Menu items reordered successfully' };
  });
};
