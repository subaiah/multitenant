import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType, isPlatformAdmin } from '../utils/authorization.js';
import { logActivity } from '../lib/activity.js';
import { audit, diff, withAudit } from '../lib/audit.js';
import { pageOf } from '../lib/pagination.js';
import { decide, forgetOrganizationRules, organizationRules, platformRules, ruleBodySchema, subjectFor } from '../lib/access-rules.js';

const createPolicySchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().optional(),
  effect: z.enum(['ALLOW', 'DENY']),
  // Which permissions, for whom, under what conditions (lib/access-rules.ts)
  conditions: ruleBodySchema,
  priority: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
});

const updatePolicySchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().optional(),
  effect: z.enum(['ALLOW', 'DENY']).optional(),
  conditions: ruleBodySchema.optional(),
  priority: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

const createBindingSchema = z.object({
  scopeType: z.enum(['TENANT', 'ORGANIZATION', 'ORG_UNIT', 'RESOURCE']),
  scopeId: z.string().uuid(),
});

export const policyRoutes: FastifyPluginAsync = async (fastify) => {
  // Any change applies from the next request on this server (others within half a minute)
  fastify.addHook('onResponse', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD' && reply.statusCode < 400 && request.tenant) forgetOrganizationRules(request.tenant.id);
  });
  // List policies
  fastify.get('/', {
    config: { permission: 'policies:read' },
    schema: {
      tags: ['policies'],
      summary: 'List access policies',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', default: '1' },
          limit: { type: 'string', default: '20' },
          enabled: { type: 'string', enum: ['true', 'false'] },
          effect: { type: 'string', enum: ['ALLOW', 'DENY'] },
        },
      },
    },
  }, async (request, reply) => {
    const userType = (request.user as any).userType;
    const tenantId = request.tenant.id;
    const { page = '1', limit = '20', enabled, effect } = request.query as any;
    const paging = pageOf(page, limit);
    
    const skip = paging.skip;
    
    // Only the current tenant's policies (platform staff select a tenant with x-tenant-id)
    const where = {
      AND: [
        { tenantId },
        enabled ? { enabled: enabled === 'true' } : {},
        effect ? { effect } : {},
      ],
    };
    
    const [policies, total] = await Promise.all([
      request.db.accessPolicy.findMany({
        where,
        skip,
        take: paging.limit,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        include: {
          _count: {
            select: { bindings: true },
          },
        },
      }),
      request.db.accessPolicy.count({ where }),
    ]);
    
    return {
      policies,
      pagination: {
        page: paging.page,
        limit: paging.limit,
        total,
        pages: Math.ceil(total / paging.limit),
      },
    };
  });

  // Get policy by ID
  fastify.get('/:id', {
    config: { permission: 'policies:read' },
    schema: {
      tags: ['policies'],
      summary: 'Get policy by ID',
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
    const tenantId = request.tenant.id;
    const { id } = request.params as { id: string };
    
    const policy = await request.db.accessPolicy.findFirst({
      where: {
        id,
        tenantId,
      },
      include: {
        bindings: true,
      },
    });
    
    if (!policy) {
      throw new AppError('Policy not found', 404);
    }
    
    return policy;
  });

  // Create policy
  fastify.post('/', {
    config: { permission: 'policies:manage' },
    schema: {
      tags: ['policies'],
      summary: 'Create access policy',
      body: {
        type: 'object',
        required: ['name', 'effect', 'conditions'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 100 },
          description: { type: 'string' },
          effect: { type: 'string', enum: ['ALLOW', 'DENY'] },
          conditions: { type: 'object' },
          priority: { type: 'number', minimum: 0 },
          enabled: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const tenantId = request.tenant.id;
    
    
    const data = createPolicySchema.parse(request.body);
    
    const policy = await withAudit(request, async (tx, record) => {
      const policy = await tx.accessPolicy.create({
        data: {
          tenantId,
          ...data,
        },
      });
      await record('policy.created', { resource: { type: 'policy', id: policy.id, label: policy.name }, details: { policy: data } });
      return policy;
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'created policy',
        target: policy.name,
        type: 'CONFIG',
      });
    
    return reply.status(201).send(policy);
  });

  // Update policy
  fastify.patch('/:id', {
    config: { permission: 'policies:manage' },
    schema: {
      tags: ['policies'],
      summary: 'Update access policy',
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
          name: { type: 'string', minLength: 2, maxLength: 100 },
          description: { type: 'string' },
          effect: { type: 'string', enum: ['ALLOW', 'DENY'] },
          conditions: { type: 'object' },
          priority: { type: 'number', minimum: 0 },
          enabled: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const tenantId = request.tenant.id;
    const { id } = request.params as { id: string };
    
    
    const data = updatePolicySchema.parse(request.body);
    
    const before = await request.db.accessPolicy.findFirst({ where: { id, tenantId } });
    const policy = await withAudit(request, async (tx, record) => {
      const policy = await tx.accessPolicy.update({
        where: { id, tenantId },
        data,
      });
      await record('policy.updated', { resource: { type: 'policy', id: policy.id, label: policy.name }, changes: diff(before as Record<string, unknown> | null, data as Record<string, unknown>) });
      return policy;
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'updated policy',
        target: policy.name,
        type: 'CONFIG',
      });
    
    return policy;
  });

  // Delete policy
  fastify.delete('/:id', {
    config: { permission: 'policies:manage' },
    schema: {
      tags: ['policies'],
      summary: 'Delete access policy',
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
    const tenantId = request.tenant.id;
    const { id } = request.params as { id: string };
    
    
    const policy = await withAudit(request, async (tx, record) => {
      const policy = await tx.accessPolicy.delete({
        where: { id, tenantId },
      });
      await record('policy.deleted', { resource: { type: 'policy', id: policy.id, label: policy.name } });
      return policy;
    });
    
    // Log activity
    await logActivity({
        tenantId,
        userId,
        action: 'deleted policy',
        target: policy.name,
        type: 'CONFIG',
      });
    
    return reply.status(204).send();
  });

  // Add binding to policy
  fastify.post('/:id/bindings', {
    config: { permission: 'policies:manage' },
    schema: {
      tags: ['policies'],
      summary: 'Add binding to policy',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        required: ['scopeType', 'scopeId'],
        properties: {
          scopeType: { type: 'string', enum: ['TENANT', 'ORGANIZATION', 'ORG_UNIT', 'RESOURCE'] },
          scopeId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const tenantId = request.tenant.id;
    const { id } = request.params as { id: string };
    
    
    const data = createBindingSchema.parse(request.body);
    
    // Verify policy exists
    const policy = await request.db.accessPolicy.findFirst({
      where: { id, tenantId },
    });
    
    if (!policy) {
      throw new AppError('Policy not found', 404);
    }
    
    // Check for existing binding
    const existing = await request.db.policyBinding.findFirst({
      where: {
        policyId: id,
        scopeType: data.scopeType,
        scopeId: data.scopeId,
      },
    });
    
    if (existing) {
      throw new AppError('Binding already exists', 409);
    }
    
    const binding = await request.db.policyBinding.create({
      data: {
        tenantId: request.tenant.id,
        policyId: id,
        ...data,
      },
    });
    
    return reply.status(201).send(binding);
  });

  // Remove binding from policy
  fastify.delete('/:id/bindings/:bindingId', {
    config: { permission: 'policies:manage' },
    schema: {
      tags: ['policies'],
      summary: 'Remove binding from policy',
      params: {
        type: 'object',
        required: ['id', 'bindingId'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          bindingId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { id, bindingId } = request.params as { id: string; bindingId: string };
    
    
    await request.db.policyBinding.delete({
      where: { id: bindingId, policyId: id },
    });
    
    return reply.status(204).send();
  });

  // Test policy evaluation
  fastify.post('/evaluate', {
    config: { permission: 'policies:read' },
    schema: {
      tags: ['policies'],
      summary: "Try the access rules: would this person's request with this permission be refused, and by which rule",
      body: {
        type: 'object',
        required: ['action'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
          email: { type: 'string', description: 'Or the person by email' },
          action: { type: 'string', description: 'The permission the request needs, e.g. users:delete' },
          context: {
            type: 'object',
            properties: {
              ip: { type: 'string' },
              at: { type: 'string', format: 'date-time', description: 'When (default: now)' },
              method: { type: 'string' },
              path: { type: 'string' },
              resourceId: { type: 'string' },
              apiKey: { type: 'boolean' },
            },
          },
        },
      },
    },
  }, async (request) => {
    const tenantId = request.tenant.id;
    const { userId, email, action, context = {} } = request.body as { userId?: string; email?: string; action: string; context?: { ip?: string; at?: string; method?: string; path?: string; resourceId?: string; apiKey?: boolean } };
    if (!userId && !email) throw new AppError('Say who: userId or email', 400);
    const user = await request.db.user.findFirst({
      where: { tenantId, ...(userId ? { id: userId } : { email: { equals: email!, mode: 'insensitive' as const } }) },
      select: { id: true, userType: true, email: true },
    });
    if (!user) throw new AppError('User not found', 404);
    const subject = subjectFor(request.db, tenantId, { userId: user.id, userType: context.apiKey ? 'API_KEY' : user.userType, email: user.email }, {
      ip: context.ip ?? request.ip,
      method: context.method ?? 'GET',
      path: context.path ?? '/',
      apiKey: Boolean(context.apiKey),
      resourceId: context.resourceId ?? null,
    }, [action], context.at ? new Date(context.at) : new Date());
    const { allowed, deniedBy, steps } = await decide(await platformRules(), await organizationRules(tenantId, request.db), subject);
    return {
      // What the rules say; the person's roles must also allow the permission
      decision: allowed ? 'ALLOW' : 'DENY',
      deniedBy,
      evaluations: steps,
      context: { userId: user.id, action, ...context },
    };
  });
};
