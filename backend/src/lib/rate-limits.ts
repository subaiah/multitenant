import type { FastifyRequest } from 'fastify';
import type { RateLimitOptions } from '@fastify/rate-limit';

/**
 * Per-account limits for credential endpoints. Keyed on the account being
 * targeted (tenant + email), not on IP or headers, so an attacker can't get
 * more guesses by rotating either. Runs in preHandler so the body is parsed.
 */
function accountKey(prefix: string) {
  return (request: FastifyRequest) => {
    const body = (request.body ?? {}) as { email?: unknown; tenantSlug?: unknown; tenantId?: unknown };
    const tenant = String(body.tenantSlug ?? body.tenantId ?? '');
    const email = String(body.email ?? '').toLowerCase();
    return `${prefix}:${tenant}:${email}`;
  };
}

export const loginRateLimit = (route: string): RateLimitOptions => ({
  max: 10,
  timeWindow: '15 minutes',
  hook: 'preHandler',
  keyGenerator: accountKey(`login:${route}`),
});

/** 6-digit codes: keep guesses per account very low. */
export const otpVerifyRateLimit = (route: string): RateLimitOptions => ({
  max: 5,
  timeWindow: '15 minutes',
  hook: 'preHandler',
  keyGenerator: accountKey(`otp-verify:${route}`),
});

/** Stops OTP spam to a single address. */
export const otpRequestRateLimit = (route: string): RateLimitOptions => ({
  max: 5,
  timeWindow: '15 minutes',
  hook: 'preHandler',
  keyGenerator: accountKey(`otp-request:${route}`),
});
