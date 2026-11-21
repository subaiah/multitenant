/**
 * The platform's security baseline (Global policies → Security baseline):
 * minimums every organization meets. An organization can be stricter in its
 * own sign-in settings, never looser: saving looser settings is refused, and
 * if the baseline is raised later the stricter value applies anyway.
 *
 * - Password policy: the weakest allowed (STANDARD < STRONG < VERY_STRONG).
 * - Two-factor: required for nobody, administrators (organization admins and
 *   platform staff), or everyone.
 * - Sessions: the longest idle timeout and the longest session allowed.
 * - Emailed sign-in codes: allowed or not, everywhere.
 * - Staff addresses: where platform staff may work from (addresses or CIDR
 *   ranges). Empty: anywhere.
 */
import { BlockList, isIP } from 'node:net';
import { controlDb } from './prisma.js';
import type { PasswordPolicy } from '../utils/auth.js';

export type MfaRequirement = 'NONE' | 'ADMINS' | 'EVERYONE';
export interface SecurityBaseline {
  minPasswordPolicy: PasswordPolicy;
  mfaRequiredFor: MfaRequirement;
  maxIdleMinutes: number | null;
  maxSessionHours: number | null;
  emailedCodesAllowed: boolean;
  staffIpAllowlist: string[];
  updatedAt: Date | null;
}

export const PASSWORD_ORDER: PasswordPolicy[] = ['STANDARD', 'STRONG', 'VERY_STRONG'];
const DEFAULT: SecurityBaseline = { minPasswordPolicy: 'STANDARD', mfaRequiredFor: 'NONE', maxIdleMinutes: null, maxSessionHours: null, emailedCodesAllowed: true, staffIpAllowlist: [], updatedAt: null };
const CACHE_MS = 30_000;
let cached: { at: number; value: SecurityBaseline } | null = null;

/** The baseline, kept for half a minute (a change on this server applies at once) */
export async function securityBaseline(): Promise<SecurityBaseline> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const row = await controlDb.securityBaseline.findUnique({ where: { id: 'platform' } });
  const value: SecurityBaseline = row
    ? {
        minPasswordPolicy: row.minPasswordPolicy as PasswordPolicy,
        mfaRequiredFor: row.mfaRequiredFor as MfaRequirement,
        maxIdleMinutes: row.maxIdleMinutes,
        maxSessionHours: row.maxSessionHours,
        emailedCodesAllowed: row.emailedCodesAllowed,
        staffIpAllowlist: row.staffIpAllowlist,
        updatedAt: row.updatedAt,
      }
    : DEFAULT;
  cached = { at: Date.now(), value };
  return value;
}

export function forgetSecurityBaseline() {
  cached = null;
}

/** The stricter of two password policies */
export function stricterPolicy(a: PasswordPolicy, b: PasswordPolicy): PasswordPolicy {
  return PASSWORD_ORDER.indexOf(a) >= PASSWORD_ORDER.indexOf(b) ? a : b;
}

const ADMIN_TYPES = new Set(['TENANT_ADMIN', 'PLATFORM_ADMIN', 'PLATFORM_USER']);

/** Whether the baseline requires two-factor for someone of this type */
export function baselineRequiresMfa(b: SecurityBaseline, userType: string | undefined): boolean {
  return b.mfaRequiredFor === 'EVERYONE' || (b.mfaRequiredFor === 'ADMINS' && !!userType && ADMIN_TYPES.has(userType));
}

/** An organization's sign-in settings as they apply: its own, or the baseline where that's stricter */
export function effectiveSignIn(b: SecurityBaseline, own: { passwordPolicy?: string | null; sessionTimeout?: number | null; maxSessionHours?: number | null; otpEnabled?: boolean | null }) {
  const cap = (value: number, max: number | null) => (max === null ? value : Math.min(value, max));
  return {
    passwordPolicy: stricterPolicy((own.passwordPolicy as PasswordPolicy | null) ?? 'STANDARD', b.minPasswordPolicy),
    sessionTimeout: cap(own.sessionTimeout ?? 60, b.maxIdleMinutes),
    maxSessionHours: cap(own.maxSessionHours ?? 12, b.maxSessionHours),
    otpEnabled: Boolean(own.otpEnabled ?? true) && b.emailedCodesAllowed,
  };
}

/**
 * What in an organization's new sign-in settings is looser than the
 * baseline, in words (empty: nothing). Only fields being changed are checked.
 */
export function looserThanBaseline(b: SecurityBaseline, change: { passwordPolicy?: string; sessionTimeout?: number; maxSessionHours?: number; otpEnabled?: boolean; mfaEnabled?: boolean }): string[] {
  const problems: string[] = [];
  if (change.passwordPolicy && PASSWORD_ORDER.indexOf(change.passwordPolicy as PasswordPolicy) < PASSWORD_ORDER.indexOf(b.minPasswordPolicy)) {
    problems.push(`The platform requires at least the ${b.minPasswordPolicy.replace('_', ' ').toLowerCase()} password policy`);
  }
  if (change.sessionTimeout !== undefined && b.maxIdleMinutes !== null && change.sessionTimeout > b.maxIdleMinutes) {
    problems.push(`The platform allows an idle timeout of at most ${b.maxIdleMinutes} minutes`);
  }
  if (change.maxSessionHours !== undefined && b.maxSessionHours !== null && change.maxSessionHours > b.maxSessionHours) {
    problems.push(`The platform allows sessions of at most ${b.maxSessionHours} hours`);
  }
  if (change.otpEnabled === true && !b.emailedCodesAllowed) problems.push("The platform doesn't allow emailed sign-in codes");
  if (change.mfaEnabled === false && b.mfaRequiredFor === 'EVERYONE') problems.push('The platform requires two-factor for everyone');
  return problems;
}

/** A list of addresses and CIDR ranges, checked; throws on one that isn't */
export function ipList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    const [address, bits] = entry.split('/');
    const family = isIP(address);
    if (!family) throw new Error(`"${entry}" is not an IP address or CIDR range`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(address, type);
    else {
      const prefix = Number(bits);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) throw new Error(`"${entry}" has an invalid prefix length`);
      list.addSubnet(address, prefix, type);
    }
  }
  return list;
}

/** Whether an address is in the list (IPv4-mapped IPv6 addresses count as their IPv4 address) */
export function ipAllowed(entries: string[], ip: string): boolean {
  if (!entries.length) return true;
  const list = ipList(entries);
  const v4 = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : null;
  if (v4) return list.check(v4, 'ipv4');
  return list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}
