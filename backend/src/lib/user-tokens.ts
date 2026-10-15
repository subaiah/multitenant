import crypto from 'node:crypto';
import type { UserTokenType } from '@prisma/client';
import { prisma } from './prisma.js';

/**
 * Single-use tokens sent by email (invitations, password resets).
 * The raw token only ever exists in the emailed link; the database stores a
 * SHA-256 hash, so a database leak doesn't expose usable links.
 */
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export const INVITE_TTL_DAYS = 7;
export const RESET_TTL_MINUTES = 60;

/** Issue a new token, invalidating any earlier unused token of the same type for this user. */
export async function issueUserToken(userId: string, type: UserTokenType, ttlMs: number, createdById?: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.$transaction([
    prisma.userToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.userToken.create({
      data: { userId, type, tokenHash: hash(token), expiresAt: new Date(Date.now() + ttlMs), createdById },
    }),
  ]);
  return token;
}

/** Look up a valid (unused, unexpired) token without consuming it. */
export async function findValidUserToken(token: string, type: UserTokenType) {
  if (!token) return null;
  return prisma.userToken.findFirst({
    where: { tokenHash: hash(token), type, usedAt: null, expiresAt: { gt: new Date() } },
    include: { user: { include: { tenant: { include: { authConfig: true } } } } },
  });
}

/** Mark a token used. Returns false if it was already used (e.g. a concurrent request won). */
export async function consumeUserToken(id: string): Promise<boolean> {
  const { count } = await prisma.userToken.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } });
  return count === 1;
}
