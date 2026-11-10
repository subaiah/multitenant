/**
 * Scripts applications load into their own pages (docs/hub/HUB_GAPS.md G5):
 * public, cacheable, and allowed cross-origin (helmet's default
 * Cross-Origin-Resource-Policy would keep other sites from using them).
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { LAUNCHER_JS } from '../embed/launcher.js';

const etag = `"${createHash('sha256').update(LAUNCHER_JS).digest('base64url').slice(0, 22)}"`;

export async function embedRoutes(fastify: FastifyInstance) {
  fastify.get('/v1/launcher.js', async (request, reply) => {
    reply
      .header('Content-Type', 'text/javascript; charset=utf-8')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .header('Access-Control-Allow-Origin', '*')
      .header('Cache-Control', 'public, max-age=3600')
      .header('ETag', etag);
    if (request.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.send(LAUNCHER_JS);
  });
}
