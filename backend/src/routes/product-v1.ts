/**
 * API v1 for external products calling as themselves, with a service access
 * token (lib/product-service.ts; docs/PRODUCT_INTEGRATION.md). Every route
 * declares the scope it needs (config.serviceScope; null: any valid token).
 * Organizations are checked against current entitlements on every call.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticateService } from '../lib/product-service.js';
import { reportOperationResult } from '../lib/product-lifecycle.js';
import { recordAudit } from '../lib/audit.js';
import { AppError } from '../middleware/error-handler.js';
import { limitSchema, pageSchema } from '../lib/pagination.js';
import { RateLimited, sendProductNotification, writeProductAuditEvent } from '../lib/product-services.js';
import { brandingOf, embedsFor, launcherFor } from '../lib/product-embeds.js';
import { getProductOrganization, listProductEvents, listProductGroups, listProductMembers, listProductOrgUnits, listProductOrganizations } from '../lib/product-data.js';

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
  orgUnitId: z.string().uuid().optional(),
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

  // Its own organizations and units (the tree scoped permissions refer to): docs/hub/HUB_GAPS.md G7
  fastify.get('/product-integrations/organizations/:organizationId/org-units', { config: { serviceScope: 'members.read' }, schema: { params: orgParams } }, async (request) => {
    const { organizationId } = request.params as { organizationId: string };
    return listProductOrgUnits(request.service!.applicationId, organizationId);
  });

  // Applications inside each other's pages (docs/hub/HUB_GAPS.md G5): what others offer, the organization's look, and the launcher
  fastify.get('/product-integrations/organizations/:organizationId/embeds', { config: { serviceScope: 'organizations.read' }, schema: { params: orgParams } }, async (request) => {
    const { organizationId } = request.params as { organizationId: string };
    return embedsFor(request.service!.applicationId, organizationId);
  });
  fastify.get('/product-integrations/organizations/:organizationId/branding', { config: { serviceScope: 'organizations.read' }, schema: { params: orgParams } }, async (request) => {
    const { organizationId } = request.params as { organizationId: string };
    return brandingOf(request.service!.applicationId, organizationId);
  });
  fastify.get('/product-integrations/organizations/:organizationId/members/:subject/applications', {
    config: { serviceScope: 'launcher.read' },
    schema: { params: { type: 'object', required: ['organizationId', 'subject'], properties: { organizationId: { type: 'string', maxLength: 100 }, subject: { type: 'string', maxLength: 200 } } } },
  }, async (request) => {
    const { organizationId, subject } = request.params as { organizationId: string; subject: string };
    return launcherFor(request.service!.applicationId, organizationId, subject);
  });

  // The product's own lifecycle events, oldest first: to catch up on any it missed
  fastify.get('/product-integrations/events', { config: { serviceScope: 'organizations.read' } }, async (request) => {
    const q = eventsQuery.parse(request.query);
    return listProductEvents(request.service!.applicationId, q, q.limit);
  });

  // The platform's own services (docs/hub/HUB_GAPS.md G3): the product's declared notification and audit event types
  const throttled = (reply: FastifyReply, err: unknown) => {
    if (err instanceof RateLimited) reply.header('Retry-After', String(err.retryAfter));
    throw err;
  };
  fastify.post('/product-integrations/organizations/:organizationId/notifications', { config: { serviceScope: 'notifications.send' }, schema: { params: orgParams } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    const sent = await sendProductNotification(request.service!, organizationId, request.body).catch((err) => throttled(reply, err));
    return reply.status(202).send(sent);
  });
  fastify.post('/product-integrations/organizations/:organizationId/audit-events', { config: { serviceScope: 'audit.write' }, schema: { params: orgParams } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    const written = await writeProductAuditEvent(request.service!, organizationId, request.body, { ip: request.ip, requestId: request.id }).catch((err) => throttled(reply, err));
    return reply.status(201).send(written);
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
