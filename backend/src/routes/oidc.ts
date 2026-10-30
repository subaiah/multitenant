/**
 * "Sign in with": the OpenID Connect provider (lib/oidc/provider.ts) mounted
 * at /oidc, and the step where a person signs in to an application
 * (/oidc/interaction/:uid). Public: applications and browsers reach it without
 * a session on the API; the interaction step reads the site's session itself.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Provider from 'oidc-provider';
import { config } from '../config/env.js';
import { createProvider, interactionPath, issuer, publicMountPath, type SiteSession } from '../lib/oidc/provider.js';
import { accountIdFor, checkAccount, type AccessProblem } from '../lib/oidc/accounts.js';
import { findSessionAccount, sessionProblem } from '../lib/sessions.js';
import { revokeRefreshTokenValue } from '../lib/auth-planes.js';
import { audit } from '../lib/audit.js';

const DENIED: Record<AccessProblem, string> = {
  NOT_ENTITLED: "Your organization doesn't have this application turned on. Ask an administrator to turn it on.",
  ORGANIZATION_UNAVAILABLE: "Your organization isn't available right now.",
  ACCOUNT_INACTIVE: 'Your account is not active.',
  APPLICATION_UNAVAILABLE: "This application isn't available for sign-in.",
};

export async function oidcRoutes(fastify: FastifyInstance) {
  // The site's session, from its access token cookie: the same checks as
  // every API request (lib/sessions.ts)
  const readSession = async (token: string | undefined): Promise<SiteSession | null> => {
    if (!token) return null;
    try {
      const claims = fastify.jwt.verify<{ userId?: string; tenantId?: string; type?: string; iat?: number; iatMs?: number }>(token);
      if (!claims.userId || claims.type !== 'access') return null;
      const user = await findSessionAccount({ userId: claims.userId, tenantId: claims.tenantId });
      if (sessionProblem(claims, user)) return null;
      return { tenantId: claims.tenantId ?? null, userId: claims.userId };
    } catch {
      return null;
    }
  };
  const provider = await createProvider({
    readSession,
    endSession: async (refreshToken) => {
      if (refreshToken) await revokeRefreshTokenValue(refreshToken);
    },
  });
  const callback = provider.callback();
  const mount = publicMountPath();
  const iss = new URL(issuer());

  // Everything else under /oidc is the provider's (discovery, authorize,
  // token, userinfo, JWKS, revocation, sign-out). It reads bodies itself.
  await fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, _payload, done) => done(null));
    scope.route({
      method: ['GET', 'HEAD', 'POST', 'OPTIONS'],
      url: '/*',
      // The provider answers CORS itself, per application (clientBasedCORS)
      config: { cors: false },
      handler: (request, reply) => {
        const tail = request.raw.url!.slice(request.raw.url!.indexOf('/oidc') + '/oidc'.length) || '/';
        const raw = request.raw as typeof request.raw & { originalUrl?: string };
        raw.originalUrl = mount + tail;
        raw.url = tail;
        // Every URL the provider builds is on the issuer, whatever the Host
        // header says: pin the forwarded headers it trusts (provider.proxy)
        raw.headers['x-forwarded-host'] = iss.host;
        raw.headers['x-forwarded-proto'] = iss.protocol.slice(0, -1);
        reply.hijack();
        reply.raw.setHeader('X-Request-ID', request.id);
        // What helmet would add (the provider's pages: sign-out, errors, form posts)
        reply.raw.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
        reply.raw.setHeader('X-Frame-Options', 'DENY');
        reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
        reply.raw.setHeader('Referrer-Policy', 'no-referrer');
        callback(raw, reply.raw);
      },
    });
  });

  // Signing in to an application: with the site's session (or after signing
  // in on the site), if the organization has the application turned on
  fastify.get('/interaction/:uid', async (request: FastifyRequest<{ Params: { uid: string } }>, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    let details: Awaited<ReturnType<Provider['interactionDetails']>>;
    try {
      details = await provider.interactionDetails(request.raw, reply.raw);
    } catch {
      return reply.status(400).type('text/html').send(errorPage('This sign-in link has expired. Go back to the application and try again.'));
    }
    if (details.uid !== request.params.uid) {
      return reply.status(400).type('text/html').send(errorPage('This sign-in link has expired. Go back to the application and try again.'));
    }
    const finish = async (result: Record<string, unknown>) => {
      const to = await provider.interactionResult(request.raw, reply.raw, result, { mergeWithLastSubmission: false });
      return reply.redirect(to, 303);
    };

    const session = await readSession(request.cookies.access_token);
    if (!session) {
      if (details.prompt.name === 'none' || details.params.prompt === 'none') return finish({ error: 'login_required' });
      // Sign in on the site, then come back here
      const back = `${config.frontendUrl.replace(/\/+$/, '')}/login?continue=${encodeURIComponent(`${iss.origin}${interactionPath(details.uid)}`)}`;
      return reply.redirect(back, 303);
    }
    if (!session.tenantId) {
      return finish({ error: 'access_denied', error_description: 'Platform accounts can\'t sign in to applications. Sign in with an organization account.' });
    }

    const clientId = details.params.client_id as string;
    const accountId = accountIdFor(session.tenantId, session.userId);
    const checked = await checkAccount(accountId, clientId);
    if ('problem' in checked) {
      return finish({ error: 'access_denied', error_description: DENIED[checked.problem] });
    }

    // No consent screen: the organization turned the application on. Grant
    // what it asked for (the provider only issues scopes it knows).
    const existing = details.grantId ? await provider.Grant.find(details.grantId) : undefined;
    const grant = existing && existing.accountId === accountId ? existing : new provider.Grant({ accountId, clientId });
    grant.addOIDCScope(String(details.params.scope ?? 'openid'));
    const missing = (details.prompt.details as { missingOIDCClaims?: string[] }).missingOIDCClaims;
    if (missing?.length) grant.addOIDCClaims(missing);
    const grantId = await grant.save();

    const { user } = checked.account;
    await audit(request, 'auth.application_signed_in', {
      resource: { type: 'Application', id: checked.applicationId, label: checked.applicationName },
    }, { actor: { type: 'USER', id: user.id, email: user.email }, tenantId: session.tenantId });

    return finish({ login: { accountId }, consent: { grantId } });
  });
}

function errorPage(message: string): string {
  const esc = message.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in problem</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px"><p>${esc}</p></body></html>`;
}
