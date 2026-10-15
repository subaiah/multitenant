import { config } from '../config/env.js';
import { sendMail } from './mailer.js';
import { inviteEmail } from './email-templates.js';
import { INVITE_TTL_DAYS, issueUserToken } from './user-tokens.js';
import { controlDb } from './prisma.js';
import { dbForTenant } from './tenant-db.js';

/**
 * Email a tenant user a link to set their password and activate their account.
 * The inviter is a tenant user or platform staff (who create tenants and may
 * work inside one); their name goes in the email.
 */
export async function sendInvitation(
  tenant: { id: string; name: string; slug: string },
  user: { id: string; email: string },
  inviterId: string,
) {
  const select = { name: true, email: true } as const;
  const inviter =
    (await (await dbForTenant(tenant.id)).user.findFirst({ where: { id: inviterId, tenantId: tenant.id }, select })) ??
    (await controlDb.platformUser.findUnique({ where: { id: inviterId }, select }));
  const owner = { tenantId: tenant.id, tenantSlug: tenant.slug };
  const token = await issueUserToken(owner, user.id, 'INVITE', INVITE_TTL_DAYS * 24 * 60 * 60 * 1000, inviterId);
  const link = `${config.frontendUrl}/accept-invite?token=${encodeURIComponent(token)}`;
  await sendMail(inviteEmail(user.email, link, tenant.name, inviter?.name || inviter?.email || 'An administrator', INVITE_TTL_DAYS));
}
