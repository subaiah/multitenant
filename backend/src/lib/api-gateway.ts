/**
 * An organization's API settings, enforced (Developers → API settings):
 *
 * - Rate limit: requests per minute for the organization's API traffic,
 *   counted across every server (lib/rate-limit-store.ts). Its API keys share
 *   one allowance; each application calling the hub about the organization
 *   (its service credentials, routes/product-v1.ts) gets its own, so one
 *   busy integration can't use up the others'. Over it: 429 with
 *   Retry-After. Headers on every counted response say where it stands
 *   (RateLimit-Limit, -Remaining, -Reset).
 * - CORS: a web page on another site may call the API with one of the
 *   organization's API keys only if CORS is on and the page's origin is in
 *   the organization's list. Such calls never carry cookies. A preflight
 *   just says what may be sent; the real request is checked here, once the
 *   key (and so the organization) is known, and refused before it runs.
 *
 * The hub's own pages (CORS_ORIGIN) are not affected by either.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { dbForTenant } from './tenant-db.js';
import { RateLimitStore } from './rate-limit-store.js';

export interface ApiSettings {
  rateLimit: number;
  corsEnabled: boolean;
  allowedOrigins: string[];
}

const DEFAULTS: ApiSettings = { rateLimit: 1000, corsEnabled: false, allowedOrigins: [] };
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; settings: ApiSettings }>();

/** The organization's settings, kept for half a minute (a change on this server applies at once: forgetApiSettings) */
export async function apiSettingsOf(tenantId: string): Promise<ApiSettings> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.settings;
  const db = await dbForTenant(tenantId);
  const row = await db.apiConfig.findUnique({ where: { tenantId }, select: { rateLimit: true, corsEnabled: true, allowedOrigins: true } });
  const settings: ApiSettings = row
    ? { rateLimit: row.rateLimit, corsEnabled: row.corsEnabled, allowedOrigins: row.allowedOrigins.map(normalOrigin) }
    : DEFAULTS;
  cache.set(tenantId, { at: Date.now(), settings });
  return settings;
}

export function forgetApiSettings(tenantId?: string) {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

const normalOrigin = (origin: string) => origin.trim().replace(/\/+$/, '').toLowerCase();

const counters = new RateLimitStore({ shared: true });
const MINUTE = 60_000;

function count(key: string): Promise<{ current: number; ttl: number }> {
  return new Promise((resolve, reject) => counters.incr(key, (err, res) => (err ? reject(err) : resolve(res!)), MINUTE));
}

/**
 * Count a request against the organization's allowance (`bucket`: 'keys' or
 * an application's id). False when over it; the 429 has been sent.
 */
export async function withinRateLimit(request: FastifyRequest, reply: FastifyReply, tenantId: string, bucket: string): Promise<boolean> {
  const { rateLimit } = await apiSettingsOf(tenantId);
  const { current, ttl } = await count(`org-api:${tenantId}:${bucket}`);
  const reset = Math.max(1, Math.ceil(ttl / 1000));
  reply.header('RateLimit-Limit', rateLimit);
  reply.header('RateLimit-Remaining', Math.max(0, rateLimit - current));
  reply.header('RateLimit-Reset', reset);
  if (current <= rateLimit) return true;
  request.log.warn({ tenantId, bucket, rateLimit }, 'Organization API rate limit reached');
  reply.header('Retry-After', reset);
  reply.status(429).send({
    error: 'Too Many Requests',
    code: 'ORGANIZATION_RATE_LIMITED',
    message: `This organization's API allows ${rateLimit} requests a minute. Try again in ${reset} seconds.`,
  });
  return false;
}

/**
 * A call from a web page on another site (an Origin the hub doesn't serve)
 * with one of the organization's API keys: allowed only by its CORS
 * settings. Sets the CORS headers when allowed; false (403 sent) otherwise.
 * Calls without an Origin (servers, scripts) and from the hub's own pages
 * pass untouched.
 */
export async function corsAllows(request: FastifyRequest, reply: FastifyReply, tenantId: string, appOrigins: Set<string>): Promise<boolean> {
  const raw = request.headers.origin;
  if (typeof raw !== 'string' || !raw) return true;
  const origin = normalOrigin(raw);
  if (appOrigins.has(origin)) return true;
  const { corsEnabled, allowedOrigins } = await apiSettingsOf(tenantId);
  if (corsEnabled && allowedOrigins.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', raw);
    reply.header('Access-Control-Expose-Headers', 'X-Request-ID, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After');
    reply.header('Vary', 'Origin');
    return true;
  }
  reply.status(403).send({
    error: 'Forbidden',
    code: 'CORS_ORIGIN_NOT_ALLOWED',
    message: corsEnabled
      ? `${raw} isn't one of this organization's allowed origins (Developers → API settings)`
      : "This organization doesn't allow calls from web pages on other sites (Developers → API settings)",
  });
  return false;
}

/** The hub's own pages, as CORS_ORIGIN lists them */
export const appOriginsOf = (corsOrigin: string) => new Set(corsOrigin.split(',').map(normalOrigin).filter(Boolean));
