/**
 * The platform's security baseline (Global policies → Security baseline):
 * minimums every organization meets (lib/security-baseline.ts).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler.js';
import { diff, withPlatformAudit } from '../lib/audit.js';
import { forgetSecurityBaseline, ipAllowed, ipList, securityBaseline } from '../lib/security-baseline.js';

const baselineSchema = z.object({
  minPasswordPolicy: z.enum(['STANDARD', 'STRONG', 'VERY_STRONG']),
  mfaRequiredFor: z.enum(['NONE', 'ADMINS', 'EVERYONE']),
  maxIdleMinutes: z.number().int().min(5).max(1440).nullable(),
  maxSessionHours: z.number().int().min(1).max(720).nullable(),
  emailedCodesAllowed: z.boolean(),
  staffIpAllowlist: z.array(z.string().trim().min(1).max(64)).max(100),
});

export const securityBaselineRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    config: { permission: 'policies:read' },
    schema: { tags: ['security-baseline'], summary: "The platform's security baseline: minimums every organization meets" },
  }, async (request) => ({ ...(await securityBaseline()), yourAddress: request.ip }));

  fastify.put('/', {
    config: { permission: 'policies:manage' },
    schema: { tags: ['security-baseline'], summary: "Change the platform's security baseline (organizations can be stricter, never looser)" },
  }, async (request) => {
    const body = baselineSchema.parse(request.body);
    const staffIpAllowlist = [...new Set(body.staffIpAllowlist)];
    try {
      ipList(staffIpAllowlist);
    } catch (err) {
      throw new AppError((err as Error).message, 400, true, 'INVALID_IP_RANGE');
    }
    // Saving a list that leaves you out would lock you out at once
    if (!ipAllowed(staffIpAllowlist, request.ip)) {
      throw new AppError(`Your own address (${request.ip}) isn't in the list: add it, or you'd be locked out`, 400, true, 'WOULD_LOCK_OUT');
    }
    const before = await securityBaseline();
    const data = { ...body, staffIpAllowlist };
    await withPlatformAudit(request, async (tx, record) => {
      await tx.securityBaseline.upsert({ where: { id: 'platform' }, create: { id: 'platform', ...data }, update: data });
      const changes = diff(before as unknown as Record<string, unknown>, data as Record<string, unknown>);
      if (Object.keys(changes).length) await record('platform.security_baseline_updated', { resource: { type: 'security_baseline', label: 'Security baseline' }, changes });
    });
    forgetSecurityBaseline();
    return { ...(await securityBaseline()), yourAddress: request.ip };
  });
};
