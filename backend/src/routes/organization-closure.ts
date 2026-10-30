/**
 * An organization's own admins close it (Settings).
 *
 *   GET  /organization/closure   what closing would do (grace period)
 *   POST /organization/close     close it: confirm with its address and your password
 *
 * Closing suspends it at once (nobody can sign in, sessions stop working)
 * and emails its admins. It is deleted CLOSE_GRACE_DAYS later
 * (lib/tenant-lifecycle.ts) unless platform staff restore it first
 * (POST /tenants/:id/restore).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env.js';
import { controlDb } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { organizationClosedEmail } from '../lib/email-templates.js';
import { tenantAdmins } from '../lib/tenant-lifecycle.js';
import { signedInCodeRateLimit } from '../lib/rate-limits.js';
import { verifyPassword } from '../utils/auth.js';
import { isTenantAdmin } from '../utils/authorization.js';
import { endBillingFor } from '../lib/billing/subscriptions.js';

export const closureRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/closure', {
    config: { permission: 'settings:manage' },
    schema: { tags: ['organization'], summary: 'What closing the organization would do' },
  }, async (request) => {
    const user = await request.db.user.findFirst({ where: { id: request.user.userId, tenantId: request.tenant.id }, select: { passwordHash: true } });
    return {
      canClose: isTenantAdmin(request.user.userType),
      graceDays: config.closeGraceDays,
      needsPassword: !!user?.passwordHash,
    };
  });

  fastify.post('/close', {
    // Wrong passwords count like wrong codes: a few per quarter hour
    config: { permission: 'settings:manage', allowWhenTrialEnded: true, rateLimit: signedInCodeRateLimit('close-organization') },
    schema: { tags: ['organization'], summary: 'Close the organization (deleted after the grace period)' },
  }, async (request) => {
    // Its own administrators only: not platform staff in a support session
    if (!isTenantAdmin(request.user.userType) || request.supportSession) {
      throw new AppError("Only the organization's administrators can close it", 403);
    }
    const { confirm, password } = z.object({ confirm: z.string().max(100), password: z.string().max(200).optional() }).parse(request.body);
    const tenant = await controlDb.tenant.findUniqueOrThrow({ where: { id: request.tenant.id } });
    if (confirm.trim().toLowerCase() !== tenant.slug) {
      throw new AppError(`Type the organization's address, ${tenant.slug}, to confirm`, 400, true, 'CONFIRMATION_MISMATCH');
    }
    const user = await request.db.user.findFirstOrThrow({ where: { id: request.user.userId, tenantId: tenant.id }, select: { email: true, name: true, passwordHash: true } });
    if (user.passwordHash && !(password && (await verifyPassword(password, user.passwordHash)))) {
      throw new AppError('That password is not right', 400, true, 'WRONG_PASSWORD');
    }

    const now = new Date();
    const deleteAfter = new Date(now.getTime() + config.closeGraceDays * 86_400_000);
    const closedBy = user.name ? `${user.name} (${user.email})` : user.email;
    // Admins to tell, read while the organization can still be read
    const admins = await tenantAdmins(tenant.id);
    await controlDb.tenant.update({
      where: { id: tenant.id },
      data: { status: 'SUSPENDED', statusBeforeClose: tenant.status, closedAt: now, closedBy, deleteAfter },
    });
    // No more renewals; what's paid for runs to the end of its period
    await endBillingFor(tenant.id, 'period_end');
    await audit(request, 'tenant.closed', {
      tenantId: tenant.id,
      resource: { type: 'tenant', id: tenant.id, label: tenant.slug },
      details: { name: tenant.name, deleteAfter: deleteAfter.toISOString() },
    });
    for (const admin of admins) await sendMail(organizationClosedEmail(admin.email, tenant.name, closedBy, deleteAfter)).catch(() => {});
    return { closedAt: now, deleteAfter };
  });
};
