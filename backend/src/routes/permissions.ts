import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { 
  getEnhancedUserPermissions, 
  getUserPermissions,
  hasPermission,
  requirePermission,
  UserType 
} from '../utils/authorization.js';

export const permissionRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /permissions
   * Get current user's permissions with metadata
   */
  fastify.get('/', {
    schema: {
      tags: ['permissions'],
      summary: 'Get current user permissions with metadata',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            permissions: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of permission strings',
            },
            sources: {
              type: 'object',
              properties: {
                userType: { type: 'string' },
                directRoles: { type: 'array', items: { type: 'string' } },
                groupRoles: { type: 'array', items: { type: 'string' } },
                delegations: { type: 'array', items: { type: 'string' } },
              },
            },
            effectivePermissions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  permission: { type: 'string' },
                  sources: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const tenantId = (request.user as any).tenantId;
    const userType = (request.user as any).userType;

    const permissionData = await getEnhancedUserPermissions(userId, tenantId, userType);

    return permissionData;
  });

  /**
   * GET /permissions/simple
   * Get current user's permissions as simple array (backward compatibility)
   */
  fastify.get('/simple', {
    schema: {
      tags: ['permissions'],
      summary: 'Get current user permissions as simple array',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            permissions: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const tenantId = (request.user as any).tenantId;

    const permissions = await getUserPermissions(userId, tenantId);

    return { permissions };
  });

  /**
   * GET /permissions/check
   * Check if user has a specific permission
   */
  fastify.get('/check', {
    schema: {
      tags: ['permissions'],
      summary: 'Check if user has a specific permission',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['resource', 'action'],
        properties: {
          resource: { type: 'string' },
          action: { type: 'string' },
          scopeType: { type: 'string' },
          scopeId: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            hasPermission: { type: 'boolean' },
            permission: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const tenantId = (request.user as any).tenantId;
    const { resource, action, scopeType, scopeId } = request.query as {
      resource: string;
      action: string;
      scopeType?: string;
      scopeId?: string;
    };

    const hasPerm = await hasPermission(userId, tenantId, resource, action, scopeType, scopeId);

    return {
      hasPermission: hasPerm,
      permission: `${resource}:${action}`,
    };
  });

  /**
   * GET /permissions/roles
   * Get all roles assigned to current user
   */
  fastify.get('/roles', {
    schema: {
      tags: ['permissions'],
      summary: 'Get all roles assigned to current user',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            directRoles: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  scopeType: { type: 'string' },
                  validFrom: { type: 'string', format: 'date-time' },
                  validTo: { type: 'string', format: 'date-time' },
                },
              },
            },
            groupRoles: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  groupName: { type: 'string' },
                  scopeType: { type: 'string' },
                  validFrom: { type: 'string', format: 'date-time' },
                  validTo: { type: 'string', format: 'date-time' },
                },
              },
            },
            delegatedRoles: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  delegatedBy: { type: 'string' },
                  validTo: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const tenantId = (request.user as any).tenantId;

    // Get direct role assignments
    const directAssignments = await prisma.roleAssignment.findMany({
      where: {
        userId,
        tenantId,
        principalType: 'USER',
        status: 'ACTIVE',
        validFrom: { lte: new Date() },
        OR: [
          { validTo: null },
          { validTo: { gt: new Date() } },
        ],
      },
      include: {
        role: true,
      },
    });

    // Get group memberships
    const groupMemberships = await prisma.groupMembership.findMany({
      where: {
        userId,
        tenantId,
        validFrom: { lte: new Date() },
        OR: [
          { validTo: null },
          { validTo: { gt: new Date() } },
        ],
      },
      include: {
        group: true,
      },
    });

    const groupIds = groupMemberships.map(m => m.groupId);
    
    // Get group-based role assignments
    let groupAssignments: any[] = [];
    if (groupIds.length > 0) {
      groupAssignments = await prisma.roleAssignment.findMany({
        where: {
          groupId: { in: groupIds },
          tenantId,
          principalType: 'GROUP',
          status: 'ACTIVE',
          validFrom: { lte: new Date() },
          OR: [
            { validTo: null },
            { validTo: { gt: new Date() } },
          ],
        },
        include: {
          role: true,
          group: true,
        },
      });
    }

    // Get delegations
    const delegations = await prisma.delegation.findMany({
      where: {
        delegateId: userId,
        tenantId,
        status: 'ACTIVE',
        validTo: { gt: new Date() },
      },
      include: {
        roleAssignment: {
          include: {
            role: true,
          },
        },
        delegator: {
          select: {
            name: true,
            email: true,
          },
        },
      },
    });

    return {
      directRoles: directAssignments.map(a => ({
        id: a.role.id,
        name: a.role.name,
        description: a.role.description,
        scopeType: a.scopeType,
        validFrom: a.validFrom,
        validTo: a.validTo,
      })),
      groupRoles: groupAssignments.map(a => ({
        id: a.role.id,
        name: a.role.name,
        description: a.role.description,
        groupName: a.group?.name || 'Unknown',
        scopeType: a.scopeType,
        validFrom: a.validFrom,
        validTo: a.validTo,
      })),
      delegatedRoles: delegations.map(d => ({
        id: d.roleAssignment.role.id,
        name: d.roleAssignment.role.name,
        description: d.roleAssignment.role.description,
        delegatedBy: d.delegator.name || d.delegator.email,
        validTo: d.validTo,
      })),
    };
  });

  /**
   * GET /permissions/groups
   * Get all groups the current user belongs to
   */
  fastify.get('/groups', {
    schema: {
      tags: ['permissions'],
      summary: 'Get all groups the current user belongs to',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            groups: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  groupType: { type: 'string' },
                  validFrom: { type: 'string', format: 'date-time' },
                  validTo: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const tenantId = (request.user as any).tenantId;

    const groupMemberships = await prisma.groupMembership.findMany({
      where: {
        userId,
        tenantId,
        validFrom: { lte: new Date() },
        OR: [
          { validTo: null },
          { validTo: { gt: new Date() } },
        ],
      },
      include: {
        group: true,
      },
    });

    return {
      groups: groupMemberships.map(m => ({
        id: m.group.id,
        name: m.group.name,
        description: m.group.description,
        groupType: m.group.groupType,
        validFrom: m.validFrom,
        validTo: m.validTo,
      })),
    };
  });
};
