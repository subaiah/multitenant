import crypto from 'crypto';

/**
 * Generate a 6-digit OTP code
 */
export function generateOtp(): string {
  // The upper bound is exclusive
  return crypto.randomInt(100000, 1000000).toString();
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
//
// scrypt (memory-hard, built into Node), run off the event loop. Stored as
//   scrypt$<N>$<r>$<p>$<salt>$<hash>      (salt and hash base64)
// so the cost travels with each hash and can be raised later: a password
// that verifies against an older or cheaper hash is hashed again at sign-in
// (passwordNeedsRehash). Hashes made before this, `<salt hex>:<hash hex>`
// (PBKDF2-SHA512, 10,000 rounds), still verify and are replaced the same way.

interface ScryptCost { N: number; r: number; p: number }

// OWASP's scrypt recommendation with the smallest memory (32 MiB a hash), so
// a few sign-ins at once fit on a small server. Tests hash hundreds of
// passwords: a light cost there, which the stored parameters make verifiable
// anywhere.
const COST: ScryptCost = process.env.NODE_ENV === 'test' ? { N: 2 ** 12, r: 8, p: 1 } : { N: 2 ** 15, r: 8, p: 3 };
const KEY_BYTES = 64;

function scrypt(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_BYTES, { ...cost, maxmem: 256 * cost.N * cost.r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function pbkdf2(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 10000, 64, 'sha512', (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** The parts of a stored scrypt hash, or null if it isn't one (or its cost is not one we'd ever have written) */
function parseScrypt(stored: string): { cost: ScryptCost; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const powerOfTwo = Number.isInteger(N) && N >= 2 ** 10 && N <= 2 ** 20 && (N & (N - 1)) === 0;
  if (!powerOfTwo || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (!salt.length || hash.length !== KEY_BYTES) return null;
  return { cost: { N, r, p }, salt, hash };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Verify a password against a stored hash (either format).
 */
export async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  const modern = parseScrypt(hashedPassword);
  if (modern) {
    const actual = await scrypt(password, modern.salt, modern.cost);
    return crypto.timingSafeEqual(modern.hash, actual);
  }
  if (hashedPassword.startsWith('scrypt$')) return false;
  const [salt, hash] = hashedPassword.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = await pbkdf2(password, salt);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Whether a hash that just verified should be replaced with one at today's cost */
export function passwordNeedsRehash(hashedPassword: string): boolean {
  const modern = parseScrypt(hashedPassword);
  return !modern || modern.cost.N !== COST.N || modern.cost.r !== COST.r || modern.cost.p !== COST.p;
}

let decoy: Promise<string> | undefined;

/**
 * Check a password at sign-in. With no account, or an account without a
 * password, the work of a check is still done (against a throwaway hash), so
 * how long the answer takes doesn't tell which email addresses have accounts.
 */
export async function checkSignInPassword(password: string, hashedPassword: string | null | undefined): Promise<boolean> {
  if (hashedPassword) return verifyPassword(password, hashedPassword);
  decoy ??= hashPassword(crypto.randomBytes(32).toString('hex'));
  await verifyPassword(password, await decoy);
  return false;
}

/**
 * Check if OTP has expired
 */
export function isOtpExpired(expiresAt: Date): boolean {
  return new Date() > expiresAt;
}

/**
 * Calculate OTP expiration time
 */
export function getOtpExpiration(minutes: number = 5): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

export type PasswordPolicy = 'STANDARD' | 'STRONG' | 'VERY_STRONG';

/** Returns a message describing what's missing, or null if the password meets the policy. */
export function checkPasswordPolicy(password: string, policy: PasswordPolicy = 'STANDARD'): string | null {
  const rules: [boolean, string][] = [];
  const min = policy === 'VERY_STRONG' ? 12 : policy === 'STRONG' ? 10 : 8;
  rules.push([password.length >= min, `at least ${min} characters`]);
  if (policy !== 'STANDARD') {
    rules.push([/[a-z]/.test(password) && /[A-Z]/.test(password), 'upper- and lower-case letters']);
    rules.push([/\d/.test(password), 'a number']);
  }
  if (policy === 'VERY_STRONG') rules.push([/[^A-Za-z0-9]/.test(password), 'a symbol']);
  if (password.length > 200) return 'Password must be at most 200 characters';
  const missing = rules.filter(([ok]) => !ok).map(([, label]) => label);
  return missing.length ? `Password needs ${missing.join(', ')}` : null;
}
