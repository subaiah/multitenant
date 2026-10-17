/**
 * The organization's own web address (lib/domains.ts), from its Settings page.
 *
 *   GET    /custom-domain         the domain, its status and the DNS records to add
 *   PUT    /custom-domain         set (or change) it: pending until checked
 *   POST   /custom-domain/check   look for the TXT record now
 *   DELETE /custom-domain         stop using it
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env.js';
import { controlDb } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { audit } from '../lib/audit.js';
import { logActivity } from '../lib/activity.js';
import { checkDomain, domainView, newDomainToken, normalizeDomain } from '../lib/domains.js';

const select = {
  customDomain: true, customDomainStatus: true, customDomainToken: true,
  customDomainVerifiedAt: true, customDomainCheckedAt: true, customDomainError: true,
} as const;

export const customDomainRoutes: FastifyPluginAsync = async (fastify) => {
  const current = async (tenantId: string) => domainView(await controlDb.tenant.findUniqueOrThrow({ where: { id: tenantId }, select }));
  const assertEnabled = () => {
    if (!config.customDomains) throw new AppError('Custom domains are not available on this platform', 404);
  };

  fastify.get('/', {
    config: { permission: 'settings:read' },
    schema: { tags: ['custom-domain'], summary: "The organization's custom domain and the DNS records it needs" },
  }, async (request) => current(request.tenant.id));

  fastify.put('/', {
    config: { permission: 'settings:manage' },
    schema: { tags: ['custom-domain'], summary: 'Use a custom domain (pending until its DNS record is found)' },
  }, async (request) => {
    assertEnabled();
    const domain = normalizeDomain(z.object({ domain: z.string().max(300) }).parse(request.body).domain);
    const before = await controlDb.tenant.findUniqueOrThrow({ where: { id: request.tenant.id }, select });
    if (before.customDomain === domain) return domainView(before);
    const taken = await controlDb.tenant.findFirst({ where: { customDomain: domain, id: { not: request.tenant.id } }, select: { id: true } });
    if (taken) throw new AppError('Another organization already uses that domain', 409);

    await controlDb.tenant.update({
      where: { id: request.tenant.id },
      data: { customDomain: domain, customDomainStatus: 'PENDING', customDomainToken: newDomainToken(), customDomainVerifiedAt: null, customDomainCheckedAt: null, customDomainError: null },
    });
    await audit(request, 'custom_domain.added', { resource: { type: 'custom_domain', label: domain }, changes: before.customDomain ? { domain: [before.customDomain, domain] } : undefined });
    await logActivity({ tenantId: request.tenant.id, userId: request.user.userId, action: 'set the custom domain', target: domain, type: 'CONFIG' });
    return current(request.tenant.id);
  });

  fastify.post('/check', {
    config: { permission: 'settings:manage' },
    schema: { tags: ['custom-domain'], summary: 'Look for the TXT record that proves the domain now' },
  }, async (request) => {
    assertEnabled();
    const before = await controlDb.tenant.findUniqueOrThrow({ where: { id: request.tenant.id }, select });
    const after = await checkDomain(request.tenant.id);
    if (before.customDomainStatus !== 'VERIFIED' && after.customDomainStatus === 'VERIFIED') {
      await audit(request, 'custom_domain.verified', { resource: { type: 'custom_domain', label: after.customDomain } });
      await logActivity({ tenantId: request.tenant.id, userId: request.user.userId, action: 'verified the custom domain', target: after.customDomain ?? '', type: 'CONFIG' });
    }
    return current(request.tenant.id);
  });

  fastify.delete('/', {
    config: { permission: 'settings:manage' },
    schema: { tags: ['custom-domain'], summary: 'Stop using the custom domain' },
  }, async (request) => {
    const before = await controlDb.tenant.findUniqueOrThrow({ where: { id: request.tenant.id }, select });
    if (!before.customDomain) return current(request.tenant.id);
    await controlDb.tenant.update({
      where: { id: request.tenant.id },
      data: { customDomain: null, customDomainStatus: null, customDomainToken: null, customDomainVerifiedAt: null, customDomainCheckedAt: null, customDomainError: null },
    });
    await audit(request, 'custom_domain.removed', { resource: { type: 'custom_domain', label: before.customDomain } });
    await logActivity({ tenantId: request.tenant.id, userId: request.user.userId, action: 'removed the custom domain', target: before.customDomain, type: 'CONFIG' });
    return current(request.tenant.id);
  });
};
