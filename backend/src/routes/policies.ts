import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType, isPlatformAdmin } from '../utils/authorization.js';

const createPolicySchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().optional(),
  effect: z.enum(['ALLOW', 'DENY']),
  conditions: z.any(), // JSON conditions
  priority: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
});

const updatePolicySchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().optional(),
  effect: z.enum(['ALLOW', 'DENY']).optional(),
  conditions: z.any().optional(),
  priority: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

const createBindingSchema = z.object({
  scopeType: z.enum(['TENANT', 'ORGANIZATION', 'ORG_UNIT', 'RESOURCE']),
  scopeId: z.string().uuid(),
});

export const policyRoutes: FastifyPluginAsync = async (fastify) => {
  // List policies
  fastify.get('/', {
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
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Platform admins can see all policies, tenant users only see their tenant's policies
    const where = {
      AND: [
        isPlatformAdmin(userType) ? {} : { tenantId },
        enabled ? { enabled: enabled === 'true' } : {},
        effect ? { effect } : {},
      ],
    };
    
    const [policies, total] = await Promise.all([
      prisma.accessPolicy.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        include: {
          _count: {
            select: { bindings: true },
          },
        },
      }),
      prisma.accessPolicy.count({ where }),
    ]);
    
    return {
      policies,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  });

  // Get policy by ID
  fastify.get('/:id', {
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
    
    const policy = await prisma.accessPolicy.findFirst({
      where: {
        id,
        ...(isPlatformAdmin(userType) ? {} : { tenantId }),
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
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    const data = createPolicySchema.parse(request.body);
    
    const policy = await prisma.accessPolicy.create({
       {
        tenantId,
        ...data,
      },
    });
    
    // Log activity
    await prisma.activity.create({
       {
        tenantId,
        userId,
        action: 'created policy',
        target: policy.name,
        type: 'CONFIG',
      },
    });
    
    return reply.status(201).send(policy);
  });

  // Update policy
  fastify.patch('/:id', {
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
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    const data = updatePolicySchema.parse(request.body);
    
    const policy = await prisma.accessPolicy.update({
      where: { id, tenantId },
      data,
    });
    
    // Log activity
    await prisma.activity.create({
       {
        tenantId,
        userId,
        action: 'updated policy',
        target: policy.name,
        type: 'CONFIG',
      },
    });
    
    return policy;
  });

  // Delete policy
  fastify.delete('/:id', {
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
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    const policy = await prisma.accessPolicy.delete({
      where: { id, tenantId },
    });
    
    // Log activity
    await prisma.activity.create({
       {
        tenantId,
        userId,
        action: 'deleted policy',
        target: policy.name,
        type: 'CONFIG',
      },
    });
    
    return reply.status(204).send();
  });

  // Add binding to policy
  fastify.post('/:id/bindings', {
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
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    const data = createBindingSchema.parse(request.body);
    
    // Verify policy exists
    const policy = await prisma.accessPolicy.findFirst({
      where: { id, tenantId },
    });
    
    if (!policy) {
      throw new AppError('Policy not found', 404);
    }
    
    // Check for existing binding
    const existing = await prisma.policyBinding.findFirst({
      where: {
        policyId: id,
        scopeType: data.scopeType,
        scopeId: data.scopeId,
      },
    });
    
    if (existing) {
      throw new AppError('Binding already exists', 409);
    }
    
    const binding = await prisma.policyBinding.create({
       {
        policyId: id,
        ...data,
      },
    });
    
    return reply.status(201).send(binding);
  });

  // Remove binding from policy
  fastify.delete('/:id/bindings/:bindingId', {
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
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    await prisma.policyBinding.delete({
      where: { id: bindingId, policyId: id },
    });
    
    return reply.status(204).send();
  });

  // Test policy evaluation
  fastify.post('/evaluate', {
    schema: {
      tags: ['policies'],
      summary: 'Test policy evaluation',
      body: {
        type: 'object',
        required: ['userId', 'action', 'resource'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
          action: { type: 'string' },
          resource: { type: 'string' },
          context: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const tenantId = request.tenant.id;
    const { userId, action, resource, context } = request.body as any;
    
    // Get all enabled policies for this tenant
    const policies = await prisma.accessPolicy.findMany({
      where: {
        tenantId,
        enabled: true,
      },
      orderBy: { priority: 'desc' },
      include: {
        bindings: true,
      },
    });
    
    // Evaluate policies (simplified - in production, implement full ABAC evaluation)
    const results = policies.map(policy => {
      // Check if policy applies to this context
      const applies = policy.bindings.some(binding => {
        // Simplified binding check
        return binding.scopeType === 'TENANT' && binding.scopeId === tenantId;
      });
      
      if (!applies) {
        return { policyId: policy.id, applies: false, decision: null };
      }
      
      // Evaluate conditions (simplified)
      const conditions = policy.conditions as any;
      let matches = true;
      
      if (conditions.action && conditions.action !== action) {
        matches = false;
      }
      
      if (conditions.resource && conditions.resource !== resource) {
        matches = false;
      }
      
      return {
        policyId: policy.id,
        policyName: policy.name,
        applies: true,
        matches,
        effect: policy.effect,
        decision: matches ? policy.effect : null,
      };
    });
    
    // Determine final decision (DENY takes precedence)
    const applicableResults = results.filter(r => r.decision);
    const hasDeny = applicableResults.some(r => r.decision === 'DENY');
    const hasAllow = applicableResults.some(r => r.decision === 'ALLOW');
    
    const finalDecision = hasDeny ? 'DENY' : hasAllow ? 'ALLOW' : 'DENY';
    
    return {
      decision: finalDecision,
      evaluations: results,
      context: { userId, action, resource, ...context },
    };
  });
};
