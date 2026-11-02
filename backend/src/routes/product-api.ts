/**
 * What external products call on the platform themselves (not on behalf of a
 * person). They authenticate with their sign-in client ID and secret (HTTP
 * Basic), so confidential clients only. docs/PRODUCT_INTEGRATION.md.
 *
 * POST /product-api/organizations/:tenantId/provisioning
 *   { "status": "READY" | "FAILED", "message"?: string }
 *   After answering organization.entitled with 202: the organization is set
 *   up (or couldn't be). Can be sent again, e.g. READY after fixing a failure.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { decryptSecret, secretContext } from '../lib/secrets.js';
import { reportProvisioning } from '../lib/product-lifecycle.js';
import { recordAudit } from '../lib/audit.js';
import { AppError } from '../middleware/error-handler.js';

const reportSchema = z.object({
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
  fastify.post('/organizations/:tenantId/provisioning', {
    schema: { params: { type: 'object', required: ['tenantId'], properties: { tenantId: { type: 'string', format: 'uuid' } } } },
  }, async (request, reply) => {
    const app = await productOf(request);
    const { tenantId } = request.params as { tenantId: string };
    const body = reportSchema.parse(request.body);
    if (!(await reportProvisioning(app.id, tenantId, body.status, body.message))) {
      throw new AppError("That organization doesn't have this application turned on", 404);
    }
    await recordAudit({ actor: { type: 'SYSTEM' }, ip: request.ip, requestId: request.id }, 'application.organization_provisioning_reported', {
      tenantId,
      resource: { type: 'application', id: app.id, label: app.name },
      outcome: body.status === 'READY' ? 'SUCCESS' : 'FAILURE',
      details: { status: body.status, ...(body.message && { message: body.message }) },
    }).catch((err) => request.log.warn({ err }, 'Recording a provisioning report failed'));
    return reply.status(204).send();
  });
}
