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
