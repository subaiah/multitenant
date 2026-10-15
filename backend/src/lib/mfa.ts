/**
 * Two-factor sign-in with an authenticator app (TOTP, RFC 6238: SHA-1,
 * 30-second steps, 6 digits), plus single-use recovery codes.
 *
 * - The secret is stored encrypted (lib/secrets.ts) and never sent again
 *   after enrollment.
 * - A code is accepted for the current step and one step either side (clock
 *   drift), and never twice: the last accepted step is recorded.
 * - Recovery codes are stored as SHA-256 hashes and removed when used.
 */
import crypto from 'node:crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret (160 bits, base32), as authenticator apps expect. */
export function newTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, '0');
}

/**
 * The step a code matches (within the window), or null. Steps at or before
 * `lastStep` are refused, so a code can't be replayed.
 */
export function verifyTotp(secret: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const step = currentStep(now);
  for (let delta = -WINDOW; delta <= WINDOW; delta++) {
    const s = step + delta;
    if (lastStep !== null && s <= lastStep) continue;
    const expected = totpAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return s;
  }
  return null;
}

/** otpauth:// link for authenticator apps (shown as a QR code). */
export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

const hashCode = (code: string) => crypto.createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

/** Ten single-use recovery codes (shown once) and their hashes (stored). */
export function newRecoveryCodes(count = 10): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: count }, () => {
    const raw = base32Encode(crypto.randomBytes(6)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map(hashCode) };
}

/** The remaining hashes if `code` is one of the recovery codes, else null. */
export function useRecoveryCode(hashes: string[], code: string): string[] | null {
  const h = hashCode(code);
  const i = hashes.findIndex((x) => crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
  return i === -1 ? null : [...hashes.slice(0, i), ...hashes.slice(i + 1)];
}
