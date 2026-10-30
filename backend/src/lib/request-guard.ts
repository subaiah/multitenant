/**
 * Two request-level safeguards registered in server.ts.
 *
 * Request IDs: every request gets one, used in log lines and audit entries.
 * An `X-Request-ID` from the proxy in front (deploy/Caddyfile sets one) is
 * kept, so a request can be followed from the proxy's logs into the API's;
 * anything that doesn't look like an ID is replaced. The response carries it
 * back, so a user reporting a problem can quote it.
 *
 * Origin check (cross-site request forgery): the session cookies are
 * SameSite=Lax, so browsers don't send them with another site's POST/PUT/
 * PATCH/DELETE. As a second line of defence, a state-changing request that
 * carries cookies must come from an allowed origin: one in CORS_ORIGIN, or
 * the address the request itself was sent to (a tenant's custom domain,
 * where the API is reached through the same address). Requests without
 * cookies (API clients with a bearer token) and without an Origin or Referer
 * header (not from a browser page) are left alone.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestIdFor(req: IncomingMessage): string {
  const given = req.headers['x-request-id'];
  return typeof given === 'string' && REQUEST_ID.test(given) ? given : randomUUID();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  if (origin && origin !== 'null') return origin;
  if (origin === 'null') return 'null'; // sandboxed frames, file:// pages: never allowed
  const referer = request.headers.referer;
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return 'null';
  }
}

export function originGuard(allowed: string[]) {
  const allowedSet = new Set(allowed.map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean));
  return async function checkOrigin(request: FastifyRequest, reply: FastifyReply) {
    if (SAFE_METHODS.has(request.method) || !request.headers.cookie) return;
    const origin = originOf(request);
    if (origin === null) return;
    if (allowedSet.has(origin)) return;
    try {
      if (origin !== 'null' && new URL(origin).host === request.host) return;
    } catch {
      // not a URL: refused below
    }
    request.log.warn({ securityEvent: 'bad-origin', origin, method: request.method, url: request.url }, 'State-changing request from another site refused');
    return reply.status(403).send({ error: 'Forbidden', code: 'BAD_ORIGIN', message: 'This request came from another website, so it was refused.' });
  };
}
