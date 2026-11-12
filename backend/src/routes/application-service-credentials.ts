/**
 * An external product's service credentials (platform staff): make one (the
 * secret is shown once), list them, revoke one. lib/product-service.ts;
 * docs/PRODUCT_INTEGRATION.md.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { audit, withPlatformAudit } from '../lib/audit.js';
import { AppError } from '../middleware/error-handler.js';
import { API_RESOURCE, SERVICE_SCOPES, SERVICE_TOKEN_TTL_SECONDS, isServiceScope, newServiceClientId, newServiceSecret } from '../lib/product-service.js';
import { issuer } from '../lib/oidc/provider.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  scopes: z.array(z.string()).min(1).refine((list) => list.every(isServiceScope), `Scopes: ${Object.keys(SERVICE_SCOPES).join(', ')}`),
});
const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

const view = (c: { id: string; name: string; clientId: string; scopes: string[]; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }) => ({
  id: c.id, name: c.name, clientId: c.clientId, scopes: c.scopes, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt, revokedAt: c.revokedAt,
});

export const applicationServiceCredentialRoutes: FastifyPluginAsync = async (fastify) => {
  const findApp = async (id: string) => {
    const app = await controlDb.applicationRegistry.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!app) throw new AppError('Application not found', 404);
    return app;
  };

  fastify.get('/:id/service-credentials', {
    config: { permission: 'app-registry:manage' },
    schema: { tags: ['applications'], summary: "An application's service credentials (for calling API v1 itself)", params },
  }, async (request) => {
    const app = await findApp((request.params as { id: string }).id);
    const list = await controlDb.productServiceCredential.findMany({ where: { applicationId: app.id }, orderBy: { createdAt: 'desc' } });
    return {
      tokenUrl: `${issuer()}/token`,
      audience: API_RESOURCE,
      tokenLifetimeSeconds: SERVICE_TOKEN_TTL_SECONDS,
      scopes: Object.entries(SERVICE_SCOPES).map(([name, description]) => ({ name, description })),
      credentials: list.map(view),
    };
  });

  fastify.post('/:id/service-credentials', {
    config: { permission: 'app-registry:manage' },
    schema: { tags: ['applications'], summary: 'Make a service credential (the secret is returned once)', params },
  }, async (request, reply) => {
    const app = await findApp((request.params as { id: string }).id);
    const data = createSchema.parse(request.body);
    const secret = newServiceSecret();
    const created = await withPlatformAudit(request, async (tx, record) => {
      const created = await tx.productServiceCredential.create({
        data: { applicationId: app.id, name: data.name, clientId: newServiceClientId(), serviceClientSecret: secret, scopes: [...new Set(data.scopes)], createdBy: request.user.userId },
      });
      await record('application.service_credential_created', {
        resource: { type: 'application', id: app.id, label: app.name },
        details: { credential: created.name, clientId: created.clientId, scopes: created.scopes },
      });
      return created;
    });
    return reply.status(201).send({ ...view(created), clientSecret: secret });
  });

  fastify.delete('/:id/service-credentials/:credentialId', {
    config: { permission: 'app-registry:manage' },
    schema: {
      tags: ['applications'],
      summary: 'Revoke a service credential (it stops working at once, tokens included)',
      params: { type: 'object', required: ['id', 'credentialId'], properties: { id: { type: 'string', format: 'uuid' }, credentialId: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const { id, credentialId } = request.params as { id: string; credentialId: string };
    const app = await findApp(id);
    const { count } = await controlDb.productServiceCredential.updateMany({ where: { id: credentialId, applicationId: app.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!count) throw new AppError('No such active credential', 404);
    const c = await controlDb.productServiceCredential.findUniqueOrThrow({ where: { id: credentialId } });
    await audit(request, 'application.service_credential_revoked', { resource: { type: 'application', id: app.id, label: app.name }, details: { credential: c.name, clientId: c.clientId } });
    return reply.status(204).send();
  });
};
