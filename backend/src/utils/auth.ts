import crypto from 'crypto';

/**
 * Generate a 6-digit OTP code
 */
export function generateOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Hash a password using bcrypt-like approach with crypto
 * In production, use bcrypt or argon2
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  const [salt, hash] = hashedPassword.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
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
