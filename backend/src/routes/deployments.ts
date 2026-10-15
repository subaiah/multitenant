import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { countBy } from '../lib/stats.js';

/**
 * The current tenant's deployed applications (the `Application` model).
 * Distinct from /applications, which is the platform's application registry.
 */
const querySchema = z.object({
  status: z.enum(['RUNNING', 'STOPPED', 'DEPLOYING', 'ERROR']).optional(),
  environment: z.enum(['PRODUCTION', 'STAGING', 'DEVELOPMENT']).optional(),
  search: z.string().optional(),
});

export const deploymentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    config: { permission: 'applications:read' },
    schema: {
      tags: ['deployments'],
      summary: "List the current tenant's deployed applications",
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['RUNNING', 'STOPPED', 'DEPLOYING', 'ERROR'] },
          environment: { type: 'string', enum: ['PRODUCTION', 'STAGING', 'DEVELOPMENT'] },
          search: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { status, environment, search } = querySchema.parse(request.query);
    const tenantId = request.tenant.id;
    const searchFilter = search
      ? { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { description: { contains: search, mode: 'insensitive' as const } }] }
      : {};

    const [deployments, byStatus, byEnvironment] = await Promise.all([
      prisma.application.findMany({
        where: { tenantId, ...(status ? { status } : {}), ...(environment ? { environment } : {}), ...searchFilter },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
      }),
      // Counts ignore the status filter so the status chips stay meaningful
      prisma.application.groupBy({ by: ['status'], where: { tenantId, ...(environment ? { environment } : {}), ...searchFilter }, _count: true }),
      prisma.application.groupBy({ by: ['environment'], where: { tenantId }, _count: true }),
    ]);

    return {
      deployments,
      counts: { byStatus: countBy(byStatus, 'status'), byEnvironment: countBy(byEnvironment, 'environment') },
    };
  });

  fastify.get('/:id', {
    config: { permission: 'applications:read' },
    schema: {
      tags: ['deployments'],
      summary: 'Get a deployed application',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const deployment = await prisma.application.findFirst({ where: { id, tenantId: request.tenant.id } });
    if (!deployment) {
      throw new AppError('Application not found', 404);
    }
    const activity = await prisma.activity.findMany({
      where: { tenantId: request.tenant.id, target: deployment.name },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, action: true, type: true, createdAt: true },
    });
    return { deployment, activity };
  });
};
