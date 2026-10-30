/**
 * GET /v1/openapi.json (also /openapi.json): the API v1 contract as an
 * OpenAPI 3.1 document (src/api/v1.ts). Public: it describes the API, not
 * any organization's data.
 */
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config/env.js';
import { openApiDocument } from '../api/v1.js';

let cached: string | null = null;

export const openApiRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/openapi.json', {
    schema: { hide: true },
  }, async (_request, reply) => {
    cached ??= JSON.stringify(openApiDocument(`${config.bffUrl.replace(/\/+$/, '')}/v1`), null, 2);
    return reply.header('content-type', 'application/json; charset=utf-8').header('cache-control', 'public, max-age=300').send(cached);
  });
};
