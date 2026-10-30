/**
 * Error tracking: unexpected errors go to a Sentry project when SENTRY_DSN is
 * set (and browsers' errors, through POST /bff/errors, when
 * SENTRY_FRONTEND_DSN is). Anything that speaks Sentry's protocol works,
 * GlitchTip (self-hosted) included.
 *
 * A small client of our own rather than the SDK: we only send errors, and
 * this way we decide exactly what leaves the server. An event carries the
 * error and its stack, the route (its pattern, never the URL with its query
 * string), the request ID, and the tenant's and user's IDs. Never bodies,
 * headers, cookies, email addresses or IP addresses.
 *
 * Sending never blocks or fails a request: it runs in the background, gives
 * up after a few seconds, and stops for the rest of the minute after
 * MAX_PER_MINUTE events (an outage would otherwise send thousands).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config/env.js';

const MAX_PER_MINUTE = 30;
const SEND_TIMEOUT_MS = 5000;

interface Target { url: string; dsn: string; key: string }

export function parseDsn(dsn: string | null): Target | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const parts = u.pathname.split('/').filter(Boolean);
    const project = parts.pop();
    if (!u.username || !project) return null;
    const prefix = parts.length ? `/${parts.join('/')}` : '';
    return { url: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/`, dsn, key: decodeURIComponent(u.username) };
  } catch {
    return null;
  }
}

const serverTarget = parseDsn(config.sentry.dsn);
const browserTarget = parseDsn(config.sentry.frontendDsn);

export const errorReportingEnabled = () => ({ server: !!serverTarget, browser: !!browserTarget });

interface Frame { function?: string; filename?: string; lineno?: number; colno?: number; in_app?: boolean }

/** V8 stack lines ("at fn (file:line:col)", "at file:line:col"), oldest call first as Sentry wants them */
export function framesOf(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  // (V8 starts with the message line, which matches neither pattern; Firefox doesn't)
  for (const line of stack.split('\n').slice(0, 60)) {
    const m = line.match(/^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/) // Node and Chrome
      ?? line.match(/^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/); // Firefox and Safari
    if (!m) continue;
    const filename = m[2].replace(/^file:\/\//, '');
    frames.push({
      function: m[1] || undefined,
      filename,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !/node_modules|node:internal|^node:/.test(filename),
    });
  }
  return frames.reverse();
}

let windowStart = 0;
let sentInWindow = 0;
const pending = new Set<Promise<void>>();

function send(target: Target, event: Record<string, unknown>) {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    sentInWindow = 0;
  }
  if (++sentInWindow > MAX_PER_MINUTE) return;
  const envelope = [
    JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString(), dsn: target.dsn }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n');
  const p = fetch(target.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-sentry-envelope',
      'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=multitenant/1.0`,
    },
    body: `${envelope}\n`,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  })
    .then(() => undefined)
    .catch(() => undefined) // error tracking must never cause errors
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Wait for events still being sent (shutdown, tests) */
export async function flushErrorReports(timeoutMs = 2000) {
  await Promise.race([Promise.all([...pending]), new Promise((r) => setTimeout(r, timeoutMs))]);
}

function baseEvent(platform: 'node' | 'javascript', level: 'error' | 'warning') {
  return {
    event_id: randomUUID().replace(/-/g, ''),
    timestamp: Date.now() / 1000,
    platform,
    level,
    environment: config.sentry.environment,
    ...(config.sentry.release && { release: config.sentry.release }),
  };
}

export interface ErrorContext {
  request?: FastifyRequest;
  /** A background job's description, when it's not a request */
  job?: string;
  level?: 'error' | 'warning';
}

/** An unexpected server error: to Sentry, when it's set up */
export function reportError(error: unknown, ctx: ErrorContext = {}) {
  if (!serverTarget) return;
  const err = error instanceof Error ? error : new Error(String(error));
  const r = ctx.request;
  const tenantId = r?.tenant?.id ?? (r?.user as { tenantId?: string } | undefined)?.tenantId;
  const userId = (r?.user as { userId?: string } | undefined)?.userId;
  send(serverTarget, {
    ...baseEvent('node', ctx.level ?? 'error'),
    exception: { values: [{ type: err.name, value: err.message.slice(0, 2000), stacktrace: { frames: framesOf(err.stack) } }] },
    ...(r && { transaction: `${r.method} ${r.routeOptions?.url ?? 'unknown route'}` }),
    tags: {
      ...(r && { method: r.method, route: r.routeOptions?.url ?? 'unknown', request_id: r.id }),
      ...(tenantId && { tenant_id: tenantId }),
      ...(ctx.job && { job: ctx.job.slice(0, 200) }),
      ...((err as { code?: unknown }).code !== undefined && { code: String((err as { code?: unknown }).code).slice(0, 100) }),
    },
    ...(userId && { user: { id: userId } }),
  });
}

export interface BrowserError { message: string; type?: string; stack?: string; path?: string; release?: string }

/** An error from someone's browser, sent by the app to /bff/errors */
export function reportBrowserError(e: BrowserError, request: FastifyRequest) {
  if (!browserTarget) return false;
  send(browserTarget, {
    ...baseEvent('javascript', 'error'),
    exception: { values: [{ type: e.type || 'Error', value: e.message, stacktrace: { frames: framesOf(e.stack) } }] },
    ...(e.path && { transaction: e.path }),
    ...(e.release && { release: e.release }),
    tags: { request_id: request.id, ...(e.path && { path: e.path }) },
    // The browser family only (Sentry reads it from this header), not the IP address
    request: { headers: { 'User-Agent': String(request.headers['user-agent'] ?? '').slice(0, 300) } },
  });
  return true;
}
