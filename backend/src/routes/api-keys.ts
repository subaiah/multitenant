/**
 * The organization's API keys (Developers page). docs/API_ACCESS.md.
 *
 *   GET    /api-keys               the keys (never their secrets)
 *   GET    /api-keys/permissions   what you may put on a key
 *   POST   /api-keys               make one: { name, permissions, expiresInDays? } → the key, once
 *   DELETE /api-keys/:id           revoke it (works at once)
 *
 * Made by the organization's own people with api:manage, not by platform
 * staff in a support session (a key outlives the session).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler.js';
import { loadPermissions } from '../middleware/authorize.js';
import { audit } from '../lib/audit.js';
import { createApiKey, grantableBy } from '../lib/api-keys.js';
import { PERMISSION_INFO, RESOURCE_INFO } from '../utils/permissions.js';

const MAX_KEYS = 50;

const view = (k: { id: string; name: string; hint: string; permissions: string[]; createdByEmail: string | null; expiresAt: Date | null; lastUsedAt: Date | null; lastUsedIp: string | null; revokedAt: Date | null; createdAt: Date }) => ({
  id: k.id, name: k.name, hint: k.hint, permissions: k.permissions, createdBy: k.createdByEmail, expiresAt: k.expiresAt,
  lastUsedAt: k.lastUsedAt, lastUsedIp: k.lastUsedIp, revokedAt: k.revokedAt, createdAt: k.createdAt,
  status: k.revokedAt ? 'REVOKED' : k.expiresAt && k.expiresAt <= new Date() ? 'EXPIRED' : 'ACTIVE',
});

function assertPerson(request: FastifyRequest) {
  if (request.supportSession) throw new AppError("API keys are made by the organization's own people, not in a support session", 403);
}

export const apiKeyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    config: { permission: 'api:read' },
    schema: { tags: ['api-keys'], summary: "The organization's API keys (not their secrets)" },
  }, async (request) => {
    const keys = await request.db.apiKey.findMany({ where: { tenantId: request.tenant.id }, orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }] });
    return { keys: keys.map(view) };
  });

  fastify.get('/permissions', {
    config: { permission: 'api:manage' },
    schema: { tags: ['api-keys'], summary: 'Permissions you may give a key (your own, except making keys and paying)' },
  }, async (request) => {
    const grantable = grantableBy(await loadPermissions(request));
    const groups = new Map<string, { resource: string; label: string; permissions: { name: string; description: string }[] }>();
    for (const p of grantable) {
      const resource = p.split(':')[0];
      if (!groups.has(resource)) groups.set(resource, { resource, label: RESOURCE_INFO[resource]?.label ?? resource, permissions: [] });
      groups.get(resource)!.permissions.push({ name: p, description: PERMISSION_INFO[p] ?? p });
    }
    return { groups: [...groups.values()] };
  });

  fastify.post('/', {
    config: { permission: 'api:manage', rateLimit: { max: 20, timeWindow: '10 minutes' } },
    schema: { tags: ['api-keys'], summary: 'Make an API key: shown once, in the response' },
  }, async (request, reply) => {
    assertPerson(request);
    const body = z.object({
      name: z.string().trim().min(1).max(100),
      permissions: z.array(z.string().max(100)).min(1).max(200),
      expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
    }).parse(request.body);
    const grantable = new Set(grantableBy(await loadPermissions(request)));
    const refused = body.permissions.filter((p) => !grantable.has(p));
    if (refused.length) throw new AppError(`A key can't have: ${refused.join(', ')} (only permissions you hold yourself, apart from making keys and paying)`, 403, true, 'NOT_GRANTABLE');
    if ((await request.db.apiKey.count({ where: { tenantId: request.tenant.id, revokedAt: null } })) >= MAX_KEYS) {
      throw new AppError(`An organization can have at most ${MAX_KEYS} keys: revoke ones you don't use`, 409);
    }
    const me = await request.db.user.findFirst({ where: { id: request.user.userId, tenantId: request.tenant.id }, select: { email: true } });
    const created = await createApiKey(request.tenant.id, {
      name: body.name,
      permissions: [...new Set(body.permissions)].sort(),
      expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null,
      userType: request.user.userType,
      createdById: request.user.userId,
      createdByEmail: me?.email ?? null,
    });
    await audit(request, 'api_key.created', { resource: { type: 'api_key', id: created.id, label: created.name }, details: { permissions: created.permissions, expiresAt: created.expiresAt } });
    return reply.status(201).send({ ...view(created), key: created.key });
  });

  fastify.delete('/:id', {
    config: { permission: 'api:manage' },
    schema: { tags: ['api-keys'], summary: 'Revoke a key (refused from then on)' },
  }, async (request, reply) => {
    assertPerson(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const key = await request.db.apiKey.findFirst({ where: { id, tenantId: request.tenant.id } });
    if (!key) throw new AppError('API key not found', 404);
    if (!key.revokedAt) {
      await request.db.apiKey.updateMany({ where: { id, tenantId: request.tenant.id }, data: { revokedAt: new Date() } });
      await audit(request, 'api_key.revoked', { resource: { type: 'api_key', id, label: key.name } });
    }
    return reply.status(204).send();
  });
};
