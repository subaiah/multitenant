/**
 * JWT_SECRET, and rotating it without cutting anyone off.
 *
 * JWT_SECRET signs session access tokens and keys a few other things: the
 * two-factor step's token, emailed sign-in codes (kept as a keyed hash), and
 * the hashes the platform keeps of what each product was last told about
 * people. To rotate it, move the old value to JWT_SECRET_PREVIOUS and set a
 * new JWT_SECRET. Everything new uses the new secret; anything made with the
 * previous one is still accepted, so nobody is signed out, no code in flight
 * stops working, and products aren't told everyone changed. Remove
 * JWT_SECRET_PREVIOUS once the longest of those has run out: a day covers
 * access tokens (JWT_EXPIRES_IN) and every short-lived code (docs/DEPLOYMENT.md).
 */
import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';
import { config } from '../config/env.js';

/** The secrets accepted, the one that signs first */
export function jwtSecrets(): string[] {
  return config.jwtSecretPrevious ? [config.jwtSecret, config.jwtSecretPrevious] : [config.jwtSecret];
}

/** A key derived for one purpose from each accepted secret, the signing one first */
export function derivedKeys(derive: (secret: string) => Buffer): Buffer[] {
  return jwtSecrets().map(derive);
}

/** The access token a request carries: `Authorization: Bearer` first, then the cookie (as @fastify/jwt reads them) */
export function accessTokenOf(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || undefined;
  return (request.cookies as Record<string, string | undefined> | undefined)?.access_token;
}

/**
 * Claims of an access token signed with JWT_SECRET_PREVIOUS, while rotating.
 * Null when there's no previous secret or the token isn't valid under it
 * (signature, expiry, algorithm). Tokens under the current secret are
 * checked by @fastify/jwt first.
 */
export async function verifyWithPreviousSecret<T = Record<string, unknown>>(token: string | undefined): Promise<T | null> {
  if (!token || !config.jwtSecretPrevious) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.jwtSecretPrevious), { algorithms: ['HS256'] });
    return payload as T;
  } catch {
    return null;
  }
}

/** HMAC under each accepted secret's key for a purpose, the signing one first (to look up a stored hash) */
export function keyedHashes(purpose: string, value: string, encoding: 'hex' | 'base64url' = 'hex'): string[] {
  return jwtSecrets().map((secret) => crypto.createHmac('sha256', `${purpose}:${secret}`).update(value).digest(encoding));
}

/** One of the constant-time-compared strings equals `value` */
export function matchesAny(value: string | null | undefined, candidates: string[]): boolean {
  if (value == null) return false;
  const a = Buffer.from(value);
  return candidates.some((c) => {
    const b = Buffer.from(c);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}
