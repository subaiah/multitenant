import { randomBytes } from 'node:crypto';
/**
 * Addresses an application may register (redirect URIs, sign-out returns, its
 * base address): https, or http on this machine while developing it. Never
 * with a fragment or credentials in it.
 */
export function allowedUri(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** A new client ID (public) and secret for an application's sign-in */
export const newClientId = () => `mtc_${randomBytes(16).toString('base64url')}`;
export const newClientSecret = () => randomBytes(32).toString('base64url');
