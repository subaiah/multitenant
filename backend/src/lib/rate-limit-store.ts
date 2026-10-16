/**
 * Where @fastify/rate-limit keeps its counters.
 *
 * Limits marked `shared: true` (lib/rate-limits.ts: sign-in, one-time and
 * two-factor codes) count in the control-plane database, so every server sees
 * the same count: with two servers an attacker still gets five guesses at a
 * code, not ten. Everything else (the per-IP flood limit) counts in memory,
 * which is cheaper and good enough for its purpose.
 *
 * Keys are hashed before they're stored (they contain email addresses).
 * Expired rows are removed every few minutes; a row past its expiry also
 * restarts its window on the next hit, so cleanup timing never matters.
 */
import crypto from 'node:crypto';
import { controlDb } from './prisma.js';

type Result = { current: number; ttl: number };
type Callback = (err: Error | null, res?: Result) => void;

interface StoreParams {
  shared?: boolean;
  continueExceeding?: boolean;
}

/** Counters in this server's memory (same behaviour as the plugin's own store, minus the extras we don't use). */
class MemoryCounters {
  private readonly hits = new Map<string, { count: number; startMs: number }>();
  private readonly max = 10_000;

  incr(key: string, cb: Callback, timeWindow: number) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.startMs + timeWindow <= now) {
      entry = { count: 0, startMs: now };
      // Oldest first: Map keeps insertion order
      if (this.hits.size >= this.max) this.hits.delete(this.hits.keys().next().value!);
    }
    this.hits.delete(key);
    entry.count += 1;
    this.hits.set(key, entry);
    cb(null, { current: entry.count, ttl: entry.startMs + timeWindow - now });
  }

  read(key: string, cb: Callback, timeWindow: number) {
    const entry = this.hits.get(key);
    if (!entry || entry.startMs + timeWindow <= Date.now()) return cb(null, { current: 0, ttl: 0 });
    cb(null, { current: entry.count, ttl: entry.startMs + timeWindow - Date.now() });
  }
}

const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('base64url');

/** Counters in the control-plane database, shared by every server. */
class DatabaseCounters {
  incr(key: string, cb: Callback, timeWindow: number) {
    const k = hashKey(key);
    controlDb
      .$queryRaw<{ count: number; ttl: number }[]>`
        INSERT INTO rate_limit_hits (key, count, expires_at)
        VALUES (${k}, 1, now() + make_interval(secs => ${timeWindow / 1000}))
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN rate_limit_hits.expires_at <= now() THEN 1 ELSE rate_limit_hits.count + 1 END,
          expires_at = CASE WHEN rate_limit_hits.expires_at <= now() THEN EXCLUDED.expires_at ELSE rate_limit_hits.expires_at END
        RETURNING count, (extract(epoch FROM expires_at - now()) * 1000)::float8 AS ttl`
      .then(([row]) => cb(null, { current: row.count, ttl: Math.max(0, Math.round(row.ttl)) }))
      .catch((err: Error) => cb(err));
  }

  read(key: string, cb: Callback) {
    controlDb
      .$queryRaw<{ count: number; ttl: number }[]>`
        SELECT count, (extract(epoch FROM expires_at - now()) * 1000)::float8 AS ttl
          FROM rate_limit_hits WHERE key = ${hashKey(key)} AND expires_at > now()`
      .then(([row]) => cb(null, row ? { current: row.count, ttl: Math.round(row.ttl) } : { current: 0, ttl: 0 }))
      .catch((err: Error) => cb(err));
  }
}

let cleanup: NodeJS.Timeout | undefined;

/** Remove expired counters now and then (every server does it; it's one cheap DELETE). */
export function startRateLimitCleanup(onError: (err: unknown) => void, everyMs = 10 * 60_000) {
  cleanup ??= setInterval(() => {
    controlDb.rateLimitHit.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(onError);
  }, everyMs);
  cleanup.unref();
}

export function stopRateLimitCleanup() {
  clearInterval(cleanup);
  cleanup = undefined;
}

/** The `store` option of @fastify/rate-limit: in memory, or shared for limits marked `shared: true`. */
export class RateLimitStore {
  private readonly counters: MemoryCounters | DatabaseCounters;

  constructor(params: StoreParams = {}) {
    this.counters = params.shared ? new DatabaseCounters() : new MemoryCounters();
  }

  // The plugin always passes the window in milliseconds (it resolves functions first)
  incr(key: string, cb: Callback, timeWindow: number) {
    this.counters.incr(key, cb, timeWindow);
  }

  read(key: string, cb: Callback, timeWindow: number) {
    this.counters.read(key, cb, timeWindow);
  }

  /** Called with a route's merged limit options (which carry `shared` through) */
  child(routeParams: object) {
    return new RateLimitStore(routeParams as StoreParams);
  }
}
