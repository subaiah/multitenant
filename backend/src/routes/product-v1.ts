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
import { limitSchema, pageSchema } from '../lib/pagination.js';
import { getProductOrganization, listProductEvents, listProductGroups, listProductMembers, listProductOrganizations } from '../lib/product-data.js';

const paging = (defaultLimit: number) => ({ page: pageSchema.default(1), limit: limitSchema(defaultLimit) });
const pagination = (page: number, limit: number, total: number) => ({ page, limit, total, pages: Math.ceil(total / limit) });
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const organizationsQuery = z.object({
  ...paging(50),
  active: bool.optional(),
  setupStatus: z.enum(['NOT_REQUIRED', 'PENDING', 'READY', 'FAILED']).optional(),
  search: z.string().trim().max(100).optional(),
});
const membersQuery = z.object({
  ...paging(50),
  status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING']).optional(),
  groupId: z.string().uuid().optional(),
  updatedSince: z.coerce.date().optional(),
  search: z.string().trim().max(100).optional(),
});
const groupsQuery = z.object({ ...paging(50), status: z.enum(['ACTIVE', 'INACTIVE']).optional() });
const eventsQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  organizationId: z.string().uuid().optional(),
  type: z.string().max(100).optional(),
});
const orgParams = { type: 'object', required: ['organizationId'], properties: { organizationId: { type: 'string', maxLength: 100 } } } as const;

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

  // The organizations that have the product (any entitlement state), with their setup
  fastify.get('/product-integrations/organizations', { config: { serviceScope: 'organizations.read' } }, async (request) => {
    const q = organizationsQuery.parse(request.query);
    const { organizations, total } = await listProductOrganizations(request.service!.applicationId, q, { skip: (q.page - 1) * q.limit, limit: q.limit });
    return { organizations, pagination: pagination(q.page, q.limit, total) };
  });

  fastify.get('/product-integrations/organizations/:organizationId', { config: { serviceScope: 'organizations.read' }, schema: { params: orgParams } }, async (request) => {
    const { organizationId } = request.params as { organizationId: string };
    return getProductOrganization(request.service!.applicationId, organizationId);
  });

  // Its people, with their groups, roles and this product's permissions they hold
  fastify.get('/product-integrations/organizations/:organizationId/members', { config: { serviceScope: 'members.read' }, schema: { params: orgParams } }, async (request) => {
    const { organizationId } = request.params as { organizationId: string };
    const q = membersQuery.parse(request.query);
    const { members, total } = await listProductMembers(request.service!.applicationId, organizationId, q, { skip: (q.page - 1) * q.limit, limit: q.limit });
    return { members, pagination: pagination(q.page, q.limit, total) };
  });

  fastify.get('/product-integrations/organizations/:organizationId/groups', { config: { serviceScope: 'members.read' }, schema: { params: orgParams } }, async (request) => {
    const { organizationId } = request.params as { organizationId: string };
    const q = groupsQuery.parse(request.query);
    const { groups, total } = await listProductGroups(request.service!.applicationId, organizationId, q, { skip: (q.page - 1) * q.limit, limit: q.limit });
    return { groups, pagination: pagination(q.page, q.limit, total) };
  });

  // The product's own lifecycle events, oldest first: to catch up on any it missed
  fastify.get('/product-integrations/events', { config: { serviceScope: 'organizations.read' } }, async (request) => {
    const q = eventsQuery.parse(request.query);
    return listProductEvents(request.service!.applicationId, q, q.limit);
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
