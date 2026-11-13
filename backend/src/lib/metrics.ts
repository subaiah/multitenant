/**
 * Metrics, in the Prometheus text format, at GET /internal/metrics.
 *
 * What is measured:
 * - the process (CPU, memory, event-loop lag, garbage collection): prom-client's defaults;
 * - http_request_duration_seconds, by method, route pattern and status;
 * - tenant_database_clients: tenant database clients held open, each with its own small pool;
 * - background_job_failures_total: failures the job runner logged, by job.
 *
 * Who can read it. /internal is not reachable through the bundled web server
 * (deploy/Caddyfile), only on the API's own port. With METRICS_TOKEN set,
 * the request must also carry it (Authorization: Bearer ...); set it wherever
 * that port is reachable by more than the collector.
 *
 * Each API server reports its own numbers; the collector adds them up.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { config } from '../config/env.js';
import { tenantClientCount } from './prisma.js';

const registry = new Registry();
collectDefaultMetrics({ register: registry });

const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Time to answer a request, by method, route pattern and status',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

new Gauge({
  name: 'tenant_database_clients',
  help: 'Tenant database clients held open by this server (each has its own pool of up to TENANT_POOL_MAX connections)',
  registers: [registry],
  collect() {
    this.set(tenantClientCount());
  },
});

const jobFailures = new Counter({
  name: 'background_job_failures_total',
  help: 'Failures logged by the background job runner, by job',
  labelNames: ['job'] as const,
  registers: [registry],
});

/** A background job failed (lib/jobs.ts). The label is the message without its variable part. */
export function countJobFailure(message: string) {
  jobFailures.inc({ job: message.replace(/\s*\(.*$/, '').slice(0, 80) });
}

/** Time every request. The route pattern (not the URL) is the label, so ids don't multiply the series. */
export function measureRequests(fastify: FastifyInstance) {
  fastify.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url ?? 'unmatched';
    if (route === '/internal/metrics') return;
    httpDuration.observe({ method: request.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
  });
}

function tokenMatches(header: string | undefined): boolean {
  const expected = Buffer.from(`Bearer ${config.metricsToken}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export const metricsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/metrics', {
    config: { rateLimit: false },
    schema: { hide: true },
  }, async (request, reply) => {
    if (config.metricsToken && !tokenMatches(request.headers.authorization)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    return reply.header('Content-Type', registry.contentType).send(await registry.metrics());
  });
};
