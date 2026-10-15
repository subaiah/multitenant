import { FastifyPluginAsync } from 'fastify';
import { controlDb } from '../lib/prisma.js';
import { platformDb } from '../lib/tenant-targets.js';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  // Basic health check
  fastify.get('/', {
    schema: {
      tags: ['health'],
      summary: 'Health check',
      description: 'Check if the API is running',
    },
  }, async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });

  // Detailed health check with database status
  fastify.get('/detailed', {
    schema: {
      tags: ['health'],
      summary: 'Detailed health check',
      description: 'Check API and database health',
    },
  }, async () => {
    const ping = async (db: { $queryRaw: (q: TemplateStringsArray) => Promise<unknown> }) => {
      const start = Date.now();
      try {
        await db.$queryRaw`SELECT 1`;
        return { status: 'healthy', latency: `${Date.now() - start}ms` };
      } catch {
        return { status: 'unhealthy', latency: `${Date.now() - start}ms` };
      }
    };
    // The control plane and the shared tenant database
    const [control, tenant] = await Promise.all([ping(controlDb), ping(platformDb({ kind: 'shared' }))]);
    const healthy = control.status === 'healthy' && tenant.status === 'healthy';

    return {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: { status: healthy ? 'healthy' : 'unhealthy', control, tenant },
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        unit: 'MB',
      },
    };
  });
};
