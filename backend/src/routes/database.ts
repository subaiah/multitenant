import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';

const updateDatabaseConfigSchema = z.object({
  strategy: z.enum(['DATABASE_PER_TENANT', 'SCHEMA_PER_TENANT', 'SHARED_TABLES']).optional(),
  provider: z.enum(['POSTGRESQL', 'MYSQL', 'MONGODB', 'SQLSERVER']).optional(),
  region: z.string().optional(),
  backupEnabled: z.boolean().optional(),
  encryptionAtRest: z.boolean().optional(),
  maxConnections: z.number().min(1).max(1000).optional(),
  storageLimit: z.string().optional(),
  connectionString: z.string().optional(),
  schemaName: z.string().optional(),
  tenantColumn: z.string().optional(),
});

export const databaseRoutes: FastifyPluginAsync = async (fastify) => {
  // Get database config for current tenant
  fastify.get('/', {
    schema: {
      tags: ['database'],
      summary: 'Get database configuration for current tenant',
    },
  }, async (request, reply) => {
    const config = await prisma.databaseConfig.findUnique({
      where: { tenantId: request.tenant.id },
    });

    if (!config) {
      throw new AppError('Database configuration not found', 404);
    }

    return config;
  });

  // Update database config
  fastify.patch('/', {
    schema: {
      tags: ['database'],
      summary: 'Update database configuration',
      body: {
        type: 'object',
        properties: {
          strategy: { type: 'string', enum: ['DATABASE_PER_TENANT', 'SCHEMA_PER_TENANT', 'SHARED_TABLES'] },
          provider: { type: 'string', enum: ['POSTGRESQL', 'MYSQL', 'MONGODB', 'SQLSERVER'] },
          region: { type: 'string' },
          backupEnabled: { type: 'boolean' },
          encryptionAtRest: { type: 'boolean' },
          maxConnections: { type: 'number', minimum: 1, maximum: 1000 },
          storageLimit: { type: 'string' },
          connectionString: { type: 'string' },
          schemaName: { type: 'string' },
          tenantColumn: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    // Only admins can update database config
    if (request.user.role !== 'ADMIN') {
      throw new AppError('Admin access required', 403);
    }

    const data = updateDatabaseConfigSchema.parse(request.body);

    // Validate strategy-specific fields
    if (data.strategy === 'DATABASE_PER_TENANT' && !data.connectionString) {
      throw new AppError('Connection string required for DATABASE_PER_TENANT strategy', 400);
    }

    if (data.strategy === 'SCHEMA_PER_TENANT' && !data.schemaName) {
      throw new AppError('Schema name required for SCHEMA_PER_TENANT strategy', 400);
    }

    if (data.strategy === 'SHARED_TABLES' && !data.tenantColumn) {
      throw new AppError('Tenant column required for SHARED_TABLES strategy', 400);
    }

    const config = await prisma.databaseConfig.update({
      where: { tenantId: request.tenant.id },
      data,
    });

    // Log activity
    await prisma.activity.create({
      data: {
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'updated database configuration',
        target: 'database',
        type: 'CONFIG',
        metadata: { strategy: data.strategy },
      },
    });

    return config;
  });

  // Get database strategies info
  fastify.get('/strategies', {
    schema: {
      tags: ['database'],
      summary: 'Get available database strategies',
    },
  }, async (request, reply) => {
    return [
      {
        id: 'DATABASE_PER_TENANT',
        name: 'Database per Tenant',
        description: 'Complete data isolation with dedicated database instances per tenant',
        pros: ['Maximum isolation', 'Independent scaling', 'Custom backups', 'No noisy neighbor'],
        cons: ['Higher cost', 'Complex migrations', 'More infrastructure to manage'],
        bestFor: 'Enterprise, Regulated Industries',
      },
      {
        id: 'SCHEMA_PER_TENANT',
        name: 'Schema per Tenant',
        description: 'Shared database with isolated schemas per tenant',
        pros: ['Good isolation', 'Lower cost than dedicated DBs', 'Easier cross-tenant queries', 'Shared infrastructure'],
        cons: ['Schema migrations complexity', 'Connection pooling limits', 'Backup coordination'],
        bestFor: 'Mid-market, SaaS Platforms',
      },
      {
        id: 'SHARED_TABLES',
        name: 'Shared Tables (Row-Level)',
        description: 'All tenants share the same tables with a tenant_id column and row-level security',
        pros: ['Lowest cost', 'Simplest operations', 'Easy migrations', 'Efficient resource use'],
        cons: ['Weakest isolation', 'Noisy neighbor risk', 'Complex RLS policies', 'Data leakage risk'],
        bestFor: 'Startups, Free Tiers, High-volume low-value',
      },
    ];
  });
};
