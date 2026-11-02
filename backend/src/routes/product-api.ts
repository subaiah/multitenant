/**
 * What external products call on the platform themselves (not on behalf of a
 * person). They authenticate with their sign-in client ID and secret (HTTP
 * Basic), so confidential clients only. docs/PRODUCT_INTEGRATION.md.
 *
 * POST /product-api/operations/:operationId/result
 *   { "generation": 3, "status": "READY" | "FAILED", "message"?: string }
 *   After answering organization.entitled with 202: the organization is set
 *   up (or couldn't be), for that operation (lib/product-lifecycle.ts). Only
 *   the current operation counts; sending the same result again is fine.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { decryptSecret, secretContext } from '../lib/secrets.js';
import { reportOperationResult } from '../lib/product-lifecycle.js';
import { recordAudit } from '../lib/audit.js';
import { AppError } from '../middleware/error-handler.js';

const resultSchema = z.object({
  generation: z.number().int().min(1),
  status: z.enum(['READY', 'FAILED']),
  message: z.string().max(500).optional(),
});

/** The product calling, from HTTP Basic with its client ID and secret */
async function productOf(request: FastifyRequest) {
  const header = request.headers.authorization ?? '';
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (!m) throw new AppError('Authenticate with the application\'s client ID and secret (HTTP Basic)', 401);
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  const clientId = decodeURIComponent(decoded.slice(0, i));
  const secret = decodeURIComponent(decoded.slice(i + 1));
  const signIn = i > 0 ? await controlDb.applicationSignIn.findUnique({ where: { clientId }, include: { application: { select: { id: true, key: true, name: true, status: true } } } }) : null;
  const stored = signIn?.oidcClientSecret ? decryptSecret(signIn.oidcClientSecret, secretContext('oidcClientSecret')) : null;
  const ok = !!stored && stored.length === secret.length && timingSafeEqual(Buffer.from(stored), Buffer.from(secret));
  if (!ok || !signIn) throw new AppError('Unknown client, or wrong secret', 401);
  if (signIn.application.status !== 'ACTIVE') throw new AppError('This application is not active', 403);
  return signIn.application;
}

export async function productApiRoutes(fastify: FastifyInstance) {
  fastify.post('/operations/:operationId/result', {
    schema: { params: { type: 'object', required: ['operationId'], properties: { operationId: { type: 'string', maxLength: 100 } } } },
  }, async (request, reply) => {
    const app = await productOf(request);
    const { operationId } = request.params as { operationId: string };
    const body = resultSchema.parse(request.body);
    // The operation must be this product's own: another product's id is "not found"
    const outcome = await reportOperationResult(app.id, operationId, body.generation, body.status, body.message);
    if (!outcome.ok) {
      throw new AppError(outcome.message, outcome.reason === 'NOT_FOUND' ? 404 : 409, true, outcome.reason === 'STALE' ? 'STALE_OPERATION' : outcome.reason);
    }
    if (outcome.changed) {
      await recordAudit({ actor: { type: 'SYSTEM' }, ip: request.ip, requestId: request.id }, 'application.organization_provisioning_reported', {
        tenantId: outcome.tenantId,
        resource: { type: 'application', id: app.id, label: app.name },
        outcome: body.status === 'READY' ? 'SUCCESS' : 'FAILURE',
        details: { operationId, generation: body.generation, status: body.status, ...(body.message && { message: body.message }) },
      }).catch((err) => request.log.warn({ err }, 'Recording a provisioning report failed'));
    }
    return reply.status(204).send();
  });
}
