import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { hasMinimumUserType } from '../utils/authorization.js';
import { logActivity } from '../lib/activity.js';
import { audit, diff } from '../lib/audit.js';
import { PREVIEW_DATABASE_FIELDS, previewEnabled } from '../lib/preview.js';

// Where the data lives (isolation mode, role, schema or database, connection
// string) is set by provisioning and can't change once a tenant has data;
// only these operational settings can be edited.
const updateDatabaseConfigSchema = z
  .object({
    backupEnabled: z.boolean().optional(),
    encryptionAtRest: z.boolean().optional(),
    storageLimit: z.string().max(20).optional(),
  })
  .strict();
const LOCKED = ['strategy', 'provider', 'region', 'connectionString', 'schemaName', 'databaseName', 'tenantColumn', 'dbRoleName', 'maxConnections'];

/** What the API shows: never the connection string (it holds credentials) */
function present(cfg: NonNullable<Awaited<ReturnType<typeof controlDb.databaseConfig.findUnique>>>) {
  const { connectionString, ...safe } = cfg;
  return { ...safe, hasConnectionString: Boolean(connectionString), isolationLocked: true };
}

export const databaseRoutes: FastifyPluginAsync = async (fastify) => {
  // Get database config for current tenant
  fastify.get('/', {
    config: { permission: 'database:read' },
    schema: {
      tags: ['database'],
      summary: 'Get database configuration for current tenant',
    },
  }, async (request, reply) => {
    const config = await controlDb.databaseConfig.findUnique({
      where: { tenantId: request.tenant.id },
    });

    if (!config) {
      throw new AppError('Database configuration not found', 404);
    }

    return present(config);
  });

  // Update database config
  fastify.patch('/', {
    config: { permission: 'database:manage' },
    schema: {
      tags: ['database'],
      summary: 'Update database configuration',
      body: {
        type: 'object',
        properties: {
          backupEnabled: { type: 'boolean' },
          encryptionAtRest: { type: 'boolean' },
          storageLimit: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {

    const locked = Object.keys((request.body as object) ?? {}).filter((k) => LOCKED.includes(k));
    if (locked.length) {
      throw new AppError(`Where this tenant's data lives is fixed once it's set up (${locked.join(', ')} can't be changed)`, 400);
    }
    const data = updateDatabaseConfigSchema.parse(request.body);
    const preview = Object.keys(data).filter((k) => PREVIEW_DATABASE_FIELDS.includes(k));
    if (preview.length && !previewEnabled()) {
      throw new AppError(`${preview.join(' and ')} can't be changed here yet: backups and encryption are set up by the platform operator`, 400);
    }

    const before = await controlDb.databaseConfig.findUnique({ where: { tenantId: request.tenant.id }, omit: { connectionString: true } });
    const config = await controlDb.databaseConfig.update({
      where: { tenantId: request.tenant.id },
      data,
    });

    // Log activity
    await logActivity({
        tenantId: request.tenant.id,
        userId: request.user.userId,
        action: 'updated database configuration',
        target: 'database',
        type: 'CONFIG',
        metadata: data,
      });
    await audit(request, 'database_config.updated', { resource: { type: 'database_config', label: 'Database settings' }, changes: diff(before, data) });

    return present(config);
  });

  // Get database strategies info
  fastify.get('/strategies', {
    config: { permission: 'database:read' },
    schema: {
      tags: ['database'],
      summary: 'Get available database strategies',
    },
  }, async (request, reply) => {
    return [
      {
        id: 'DATABASE_PER_TENANT',
        name: 'Database per Tenant',
        description: 'A database of its own, reached only by its own database role',
        pros: ['Maximum isolation', 'Independent scaling', 'Custom backups', 'No noisy neighbor'],
        cons: ['Higher cost', 'Complex migrations', 'More infrastructure to manage'],
        bestFor: 'Enterprise, Regulated Industries',
      },
      {
        id: 'SCHEMA_PER_TENANT',
        name: 'Schema per Tenant',
        description: 'A schema of its own in a shared database, reached only by its own database role',
        pros: ['Good isolation', 'Lower cost than dedicated DBs', 'Easier cross-tenant queries', 'Shared infrastructure'],
        cons: ['Schema migrations complexity', 'Connection pooling limits', 'Backup coordination'],
        bestFor: 'Mid-market, SaaS Platforms',
      },
      {
        id: 'SHARED_TABLES',
        name: 'Shared Tables (Row-Level)',
        description: 'Shared tables; row-level security shows each tenant\'s database role only its own rows',
        pros: ['Lowest cost', 'Simplest operations', 'Easy migrations', 'Efficient resource use'],
        cons: ['Weakest isolation', 'Noisy neighbor risk', 'Complex RLS policies', 'Data leakage risk'],
        bestFor: 'Startups, Free Tiers, High-volume low-value',
      },
    ];
  });
};
