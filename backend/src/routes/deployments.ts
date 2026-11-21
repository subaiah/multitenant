import { FastifyPluginAsync } from 'fastify';
import { AppError } from '../middleware/error-handler.js';
import { applicationDetail, applicationFigures, databaseFigures } from '../lib/app-figures.js';

/**
 * How the organization's applications are doing (Deployments) and what its
 * data takes up (Infrastructure): real figures from the platform's health
 * checks, the applications' usage reports and the organization's database
 * (lib/app-figures.ts).
 */
export const deploymentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    config: { permission: 'applications:read' },
    schema: { tags: ['deployments'], summary: "The organization's applications: whether each is up, uptime over 1, 7 and 30 days, and this month's usage" },
  }, async (request) => ({ applications: await applicationFigures(request.tenant.id) }));

  fastify.get('/:applicationId', {
    config: { permission: 'applications:read' },
    schema: {
      tags: ['deployments'],
      summary: 'One application: daily uptime for 30 days, and usage this month and last',
      params: { type: 'object', required: ['applicationId'], properties: { applicationId: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => {
    const { applicationId } = request.params as { applicationId: string };
    const detail = await applicationDetail(request.tenant.id, applicationId);
    if (!detail) throw new AppError('Your organization does not have that application on', 404);
    return detail;
  });
};

export const infrastructureRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    config: { permission: 'infrastructure:read' },
    schema: { tags: ['infrastructure'], summary: "The organization's data: room taken, rows in its main tables, open connections" },
  }, async (request) => databaseFigures(request.tenant.id, request.tenant.slug));
};
