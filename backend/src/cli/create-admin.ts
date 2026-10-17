/**
 * The first platform administrator of a new installation (the demo seed is
 * for development only and has well-known passwords).
 *
 * Creates the account without a password and emails an invitation to set one
 * (the link is printed too, for installations whose email isn't set up yet).
 * Running it again for the same email sends a fresh link while the account is
 * still waiting to be activated.
 *
 *   npm run platform:admin -- admin@example.com ["Their Name"]
 *   node dist/cli/create-admin.js admin@example.com ["Their Name"]   (the production image)
 */
import { z } from 'zod';
import { config } from '../config/env.js';
import { controlDb, disconnectDatabases } from '../lib/prisma.js';
import { sendMail } from '../lib/mailer.js';
import { inviteEmail } from '../lib/email-templates.js';
import { INVITE_TTL_DAYS, issueUserToken } from '../lib/user-tokens.js';
import { ensurePlatformRoles } from '../lib/platform-roles.js';

const [emailArg, name] = process.argv.slice(2);
let failed = false;
try {
  const email = z.string().trim().toLowerCase().email().safeParse(emailArg);
  if (!email.success) throw new Error('Usage: create-admin <email> ["Name"]');

  await ensurePlatformRoles();
  const existing = await controlDb.platformUser.findUnique({ where: { email: email.data } });
  if (existing && existing.status !== 'PENDING') {
    throw new Error(`${email.data} already has an active platform account. Use "Forgot password" on the platform sign-in page if they need a new password.`);
  }
  const user =
    existing ??
    (await controlDb.platformUser.create({
      data: { email: email.data, name: name || null, userType: 'PLATFORM_ADMIN', status: 'PENDING' },
    }));

  const token = await issueUserToken('platform', user.id, 'INVITE', INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const link = `${config.frontendUrl}/accept-invite?token=${encodeURIComponent(token)}`;
  await sendMail(inviteEmail(user.email, link, 'Platform Administration', 'The installer', INVITE_TTL_DAYS)).catch((err) => {
    console.warn(`Could not email the invitation (${(err as Error).message}); use the link below.`);
  });
  console.log(`${existing ? 'New invitation for' : 'Created platform administrator'} ${user.email}.`);
  console.log(`Set a password within ${INVITE_TTL_DAYS} days at:\n\n  ${link}\n`);
  console.log('Keep this link private: whoever opens it first sets the password.');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  failed = true;
} finally {
  await disconnectDatabases();
}
process.exit(failed ? 1 : 0);
