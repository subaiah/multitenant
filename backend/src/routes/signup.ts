/**
 * Self-service sign-up: anyone can create an organization (SELF_SIGNUP, on by
 * default).
 *
 *   POST /bff/signup          the form: organization, address, name, email, password.
 *                             Nothing is created yet; a link is emailed.
 *   POST /bff/signup/verify   the link: creates the tenant (a trial on
 *                             SIGNUP_PLAN) and starts setting it up.
 *   GET  /bff/signup/status   the page after the link follows the setup.
 *
 * When the tenant is ready, provisioning makes the person its administrator
 * with the password they chose (lib/provisioning.ts) and emails them. Until
 * the email is confirmed, only a row in signup_requests exists: no database
 * role, schema or database is made for an address nobody has proven.
 */
import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env.js';
import { controlDb } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { checkPasswordPolicy, hashPassword } from '../utils/auth.js';
import { sendMail } from '../lib/mailer.js';
import { signupConfirmEmail } from '../lib/email-templates.js';
import { assertSlugAvailable, createTenantRecord, slugSchema } from '../lib/new-tenant.js';
import { startProvisioning } from '../lib/provisioning.js';
import { audit } from '../lib/audit.js';
import { logPlatformActivity } from '../lib/activity.js';
import { signupRateLimit } from '../lib/rate-limits.js';
import { requestDomain, tenantForDomain } from '../lib/domains.js';
import { isBlockedEmail } from '../lib/disposable-email.js';

/** Organization admins choose a strong password */
export const SIGNUP_PASSWORD_POLICY = 'STRONG' as const;
const LINK_HOURS = 24;

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const startSchema = z.object({
  organization: z.string().trim().min(2).max(100),
  slug: slugSchema,
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
  // The bot check's answer (when TURNSTILE_* is set)
  captchaToken: z.string().max(4096).optional(),
});

/** Ask Cloudflare whether the sign-up form's bot check was passed */
async function passedCaptcha(token: string | undefined, ip: string): Promise<boolean> {
  const turnstile = config.turnstile;
  if (!turnstile) return true;
  if (!token) return false;
  let res: Response;
  try {
    res = await fetch(turnstile.verifyUrl, {
      method: 'POST',
      body: new URLSearchParams({ secret: turnstile.secretKey, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new AppError("The bot check couldn't be confirmed just now. Try again in a minute.", 503, true, 'CAPTCHA_UNAVAILABLE');
  }
  const body = (await res.json().catch(() => ({}))) as { success?: boolean };
  return res.ok && body.success === true;
}

export const signupRoutes: FastifyPluginAsync = async (fastify) => {
  const assertOpen = async (request: Parameters<typeof requestDomain>[0]) => {
    // Not on an organization's own domain: that address belongs to it
    if (!config.selfSignup || (await requestDomain(request))) {
      throw new AppError('Signing up is not available here', 404, true, 'SIGNUP_DISABLED');
    }
  };

  fastify.post('/', {
    config: { rateLimit: signupRateLimit },
    schema: { tags: ['signup'], summary: 'Start signing up a new organization (emails a confirmation link)' },
  }, async (request, reply) => {
    await assertOpen(request);
    const data = startSchema.parse(request.body);
    await assertSlugAvailable(data.slug);
    const problem = checkPasswordPolicy(data.password, SIGNUP_PASSWORD_POLICY);
    if (problem) throw new AppError(problem, 400);
    if (isBlockedEmail(data.email)) {
      throw new AppError('Use your work email address. Temporary email services can’t be used to sign up.', 400, true, 'EMAIL_NOT_ALLOWED');
    }
    // Last, so a mistake in the form doesn't use up the check
    if (!(await passedCaptcha(data.captchaToken, request.ip))) {
      throw new AppError('Confirm you’re not a robot, then try again.', 400, true, 'CAPTCHA_FAILED');
    }

    const token = crypto.randomBytes(32).toString('base64url');
    await controlDb.$transaction([
      // Expired attempts, and this person's earlier unconfirmed one (the newest link is the one that works)
      controlDb.signupRequest.deleteMany({ where: { verifiedAt: null, OR: [{ expiresAt: { lt: new Date() } }, { email: data.email }] } }),
      controlDb.signupRequest.create({
        data: {
          email: data.email,
          name: data.name,
          organization: data.organization,
          slug: data.slug,
          passwordHash: await hashPassword(data.password),
          tokenHash: hash(token),
          expiresAt: new Date(Date.now() + LINK_HOURS * 3600_000),
          ip: request.ip,
        },
      }),
    ]);
    const link = `${config.frontendUrl.replace(/\/$/, '')}/signup/verify?token=${encodeURIComponent(token)}`;
    await sendMail(signupConfirmEmail(data.email, link, data.organization, LINK_HOURS));
    return reply.status(202).send({ message: `We sent a link to ${data.email}. Open it to create ${data.organization}.`, email: data.email });
  });

  fastify.post('/verify', {
    schema: { tags: ['signup'], summary: 'Confirm the email and create the organization' },
  }, async (request) => {
    await assertOpen(request);
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(request.body);
    const signup = await controlDb.signupRequest.findUnique({ where: { tokenHash: hash(token) } });
    if (!signup || (!signup.verifiedAt && signup.expiresAt < new Date())) {
      throw new AppError('This link is invalid or has expired. Sign up again to get a new one.', 404, true, 'SIGNUP_EXPIRED');
    }
    // Opened again (a reload, a second tab): show the same organization
    if (signup.verifiedAt) return { slug: signup.slug, organization: signup.organization, email: signup.email };

    // First one to open it carries on
    const claimed = await controlDb.signupRequest.updateMany({ where: { id: signup.id, verifiedAt: null }, data: { verifiedAt: new Date() } });
    if (claimed.count !== 1) return { slug: signup.slug, organization: signup.organization, email: signup.email };

    let tenant;
    try {
      tenant = await createTenantRecord({
        name: signup.organization,
        slug: signup.slug,
        plan: config.signupPlan,
        status: 'TRIAL',
        adminEmail: signup.email,
        adminName: signup.name,
        createdById: null,
      });
    } catch (err) {
      await controlDb.signupRequest.update({ where: { id: signup.id }, data: { verifiedAt: null } });
      if ((err as AppError).code === 'SLUG_TAKEN') {
        throw new AppError(`Someone took the address "${signup.slug}" in the meantime. Sign up again with another one.`, 409, true, 'SLUG_TAKEN');
      }
      throw err;
    }
    await controlDb.signupRequest.update({ where: { id: signup.id }, data: { tenantId: tenant.id } });

    await logPlatformActivity({ tenantId: tenant.id, userId: null, action: 'signed up', target: `${tenant.name} (${tenant.slug})`, type: 'CONFIG', metadata: { email: signup.email } });
    await audit(request, 'tenant.signed_up', {
      tenantId: tenant.id,
      resource: { type: 'tenant', id: tenant.id, label: tenant.slug },
      details: { organization: tenant.name, plan: tenant.plan, email: signup.email },
    }, { actor: { type: 'ANONYMOUS', email: signup.email } });
    void startProvisioning(tenant.id);
    return { slug: tenant.slug, organization: tenant.name, email: signup.email };
  });

  fastify.get('/status', {
    schema: { tags: ['signup'], summary: 'How setting up a signed-up organization is going' },
  }, async (request) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(request.query);
    const signup = await controlDb.signupRequest.findUnique({ where: { tokenHash: hash(token) }, select: { tenantId: true, slug: true, email: true, verifiedAt: true } });
    // Only for a couple of days after confirming
    if (!signup?.tenantId || !signup.verifiedAt || signup.verifiedAt.getTime() < Date.now() - 48 * 3600_000) {
      throw new AppError('This link is invalid or has expired.', 404);
    }
    const tenant = await controlDb.tenant.findUnique({ where: { id: signup.tenantId }, select: { provisioningStatus: true } });
    const status = tenant?.provisioningStatus === 'READY' ? 'READY' : tenant?.provisioningStatus === 'FAILED' ? 'FAILED' : 'SETTING_UP';
    return { status, slug: signup.slug, email: signup.email };
  });
};

/** What the public pages need to know about the address they're on */
export const siteRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/site', {
    schema: { tags: ['signup'], summary: 'This address: an organization’s own domain (which one), and whether signing up is open' },
  }, async (request) => {
    const on = await requestDomain(request);
    return {
      tenant: on ? { slug: on.tenant.slug, name: on.tenant.name } : null,
      signup: on || !config.selfSignup
        ? null
        : { passwordPolicy: SIGNUP_PASSWORD_POLICY, captchaSiteKey: config.turnstile?.siteKey ?? null, trialDays: config.trialDays },
    };
  });
};

/** For the web server: may it get a certificate for this name? (Caddy's on_demand_tls "ask") */
export const tlsAskRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/tls-allowed', {
    config: { rateLimit: false },
    schema: { tags: ['internal'], summary: 'Whether a hostname is a verified custom domain (200) or not (404)' },
  }, async (request, reply) => {
    const { domain } = z.object({ domain: z.string().max(253) }).parse(request.query);
    return (await tenantForDomain(domain)) ? { ok: true } : reply.status(404).send({ ok: false });
  });
};
