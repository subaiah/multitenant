/**
 * Email addresses as people type them.
 *
 * Addresses are stored and compared in lower case. Every route that takes one
 * parses it with emailInput(), so "Alice@Acme.com" and "alice@acme.com" are
 * the same person whichever way they were invited and however they sign in.
 *
 * Accounts invited before that rule may still be stored with capitals;
 * findUserByEmail() finds those too.
 */
import { z } from 'zod';
import type { TenantDb } from './tenant-db.js';

/** A trimmed, lower-cased email address */
export const emailInput = () => z.string().trim().toLowerCase().email();

/**
 * A tenant's user by email address (already lower-cased by emailInput()).
 *
 * The exact match is the normal case. The second look is for accounts stored
 * with capitals: the database compares without case, and the result is
 * checked again here, because that comparison is a pattern match in which
 * `_` and `%` stand for other characters ("a_b@x.com" would also find
 * "axb@x.com").
 */
export async function findUserByEmail(db: TenantDb, tenantId: string, email: string) {
  const exact = await db.user.findFirst({ where: { tenantId, email } });
  if (exact) return exact;
  const loose = await db.user.findMany({ where: { tenantId, email: { equals: email, mode: 'insensitive' } }, orderBy: { createdAt: 'asc' } });
  return loose.find((u) => u.email.toLowerCase() === email) ?? null;
}
