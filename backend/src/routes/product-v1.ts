/**
 * API v1 for external products calling as themselves, with a service access
 * token (lib/product-service.ts; docs/PRODUCT_INTEGRATION.md). Every route
 * declares the scope it needs (config.serviceScope; null: any valid token).
 * Organizations are checked against current entitlements on every call.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticateService } from '../lib/product-service.js';
import { reportOperationResult } from '../lib/product-lifecycle.js';
import { recordAudit } from '../lib/audit.js';
import { AppError } from '../middleware/error-handler.js';

const resultSchema = z.object({
  generation: z.number().int().min(1),
  status: z.enum(['READY', 'FAILED']),
  message: z.string().max(500).optional(),
});

export async function productV1Routes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', authenticateService);

  // Who the token belongs to, and what it may do
  fastify.get('/products/me', { config: { serviceScope: null } }, async (request) => {
    const s = request.service!;
    return {
      product: { id: s.applicationId, key: s.productKey, name: s.productName },
      credential: { id: s.credentialId, name: s.credentialName },
      scopes: [...s.scopes].sort(),
    };
  });

  // The result of setting an organization up, after answering organization.entitled with 202 (lib/product-lifecycle.ts)
  fastify.post('/product-integrations/operations/:operationId/result', {
    config: { serviceScope: 'lifecycle.report' },
    schema: { params: { type: 'object', required: ['operationId'], properties: { operationId: { type: 'string', maxLength: 100 } } } },
  }, async (request, reply) => {
    const s = request.service!;
    const { operationId } = request.params as { operationId: string };
    const body = resultSchema.parse(request.body);
    // Only this product's own operations: another product's id is "not found"
    const outcome = await reportOperationResult(s.applicationId, operationId, body.generation, body.status, body.message);
    if (!outcome.ok) {
      throw new AppError(outcome.message, outcome.reason === 'NOT_FOUND' ? 404 : 409, true, outcome.reason === 'STALE' ? 'STALE_OPERATION' : outcome.reason);
    }
    if (outcome.changed) {
      await recordAudit({ actor: { type: 'SYSTEM' }, ip: request.ip, requestId: request.id }, 'application.organization_provisioning_reported', {
        tenantId: outcome.tenantId,
        resource: { type: 'application', id: s.applicationId, label: s.productName },
        outcome: body.status === 'READY' ? 'SUCCESS' : 'FAILURE',
        details: { operationId, generation: body.generation, status: body.status, credential: s.credentialName, ...(body.message && { message: body.message }) },
      }).catch((err) => request.log.warn({ err }, 'Recording a provisioning report failed'));
    }
    return reply.status(204).send();
  });
}
