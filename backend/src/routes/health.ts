/**
 * Health checks.
 *
 * - `GET /health`: liveness, no database access (container health checks).
 * - `GET /health/ready`: are the databases reachable? 200 or 503, and nothing
 *   else (uptime monitors). Public, so it says no more than that, and it is
 *   rate limited: each call queries the databases.
 * - `GET /health/detailed`: latencies, memory, uptime. Platform staff only
 *   (`platform:read`); registered with the signed-in routes (server.ts).
 */
import { FastifyPluginAsync } from 'fastify';
import { controlDb } from '../lib/prisma.js';
import { platformDb } from '../lib/tenant-targets.js';

type Pingable = { $queryRaw: (q: TemplateStringsArray) => Promise<unknown> };

async function ping(db: Pingable) {
  const start = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    return { status: 'healthy', latency: `${Date.now() - start}ms` };
  } catch {
    return { status: 'unhealthy', latency: `${Date.now() - start}ms` };
  }
}

/** The control plane and the shared tenant database */
async function databases() {
  const [control, tenant] = await Promise.all([ping(controlDb), ping(platformDb({ kind: 'shared' }))]);
  return { control, tenant, healthy: control.status === 'healthy' && tenant.status === 'healthy' };
}

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    schema: { tags: ['health'], summary: 'Liveness: the API is running (no database access)' },
  }, async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  fastify.get('/ready', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['health'], summary: 'Readiness: the databases are reachable (200, or 503 if not)' },
  }, async (_request, reply) => {
    const { healthy } = await databases();
    return reply.status(healthy ? 200 : 503).send({ status: healthy ? 'ok' : 'degraded' });
  });
};

export const healthDetailRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/detailed', {
    config: { permission: 'platform:read' },
    schema: { tags: ['health'], summary: 'Detailed health: database latency, memory and uptime (platform staff)' },
  }, async () => {
    const { control, tenant, healthy } = await databases();
    const memory = process.memoryUsage();
    return {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: { status: healthy ? 'healthy' : 'unhealthy', control, tenant },
      memory: { used: Math.round(memory.heapUsed / 1024 / 1024), total: Math.round(memory.heapTotal / 1024 / 1024), unit: 'MB' },
    };
  });
};
