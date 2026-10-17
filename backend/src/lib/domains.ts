/**
 * Custom domains: an organization reaches the app at its own address
 * (app.acme.com) instead of the platform's.
 *
 * 1. A tenant admin enters the domain (Settings). It's PENDING, with a token.
 * 2. They add two DNS records: a CNAME from the domain to the platform
 *    (CUSTOM_DOMAIN_TARGET), and a TXT record `_tenant-verify.<domain>`
 *    holding `tenant-verify=<token>`, which proves the domain is theirs.
 * 3. "Check now" looks the TXT record up; found, the domain is VERIFIED.
 *
 * Only then does anything work on it: the web server gets a certificate for
 * it (Caddy asks /internal/tls-allowed), the app opens straight to that
 * organization's sign-in page, emails link to it, and single sign-on can
 * return to it. A verified domain signs in to its own organization only, so
 * one tenant's domain can't be used to collect another's passwords.
 */
import crypto from 'node:crypto';
import { promises as dns } from 'node:dns';
import type { FastifyRequest } from 'fastify';
import { config } from '../config/env.js';
import { controlDb } from './prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { isPlatformSlug } from './platform.js';

export const VERIFY_PREFIX = '_tenant-verify';
export const verifyRecordName = (domain: string) => `${VERIFY_PREFIX}.${domain}`;
export const verifyRecordValue = (token: string) => `tenant-verify=${token}`;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** "https://App.Acme.com/path" -> "app.acme.com"; throws for anything that isn't a public hostname */
export function normalizeDomain(input: string): string {
  let host = input.trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels.at(-1)!)) {
    throw new AppError('Enter a domain name such as app.example.com', 400);
  }
  // The platform's own addresses (and anything under them) aren't anyone's to claim
  const own = [new URL(config.frontendUrl).hostname, new URL(config.bffUrl).hostname, config.customDomainTarget];
  if (own.some((o) => host === o || host.endsWith(`.${o}`))) {
    throw new AppError("That's one of the platform's own addresses", 400);
  }
  return host;
}

export const newDomainToken = () => crypto.randomBytes(18).toString('base64url');

/** The tenant a verified custom domain belongs to, if this hostname is one */
export async function tenantForDomain(hostname: string | undefined) {
  if (!config.customDomains || !hostname) return null;
  return controlDb.tenant.findFirst({
    where: { customDomain: hostname.toLowerCase(), customDomainStatus: 'VERIFIED' },
    select: { id: true, slug: true, name: true, status: true, provisioningStatus: true },
  });
}

/** The verified custom domain a request came in on, and its tenant */
export async function requestDomain(request: FastifyRequest) {
  const tenant = await tenantForDomain(request.hostname);
  return tenant ? { hostname: request.hostname.toLowerCase(), tenant } : null;
}

/**
 * On a custom domain, only that organization can be signed in to: refuse any
 * other (another tenant, or the platform portal).
 */
export async function assertSignInHost(request: FastifyRequest, slug: string | undefined) {
  const on = await requestDomain(request);
  if (!on) return;
  if (!slug || isPlatformSlug(slug) || slug !== on.tenant.slug) {
    throw new AppError(`This address is for signing in to ${on.tenant.name} only`, 403, true, 'WRONG_DOMAIN');
  }
}

/** The app's address as this request reached it: a verified custom domain, else FRONTEND_URL */
export async function appOriginFor(request: FastifyRequest): Promise<string> {
  const on = await requestDomain(request);
  return on ? `${request.protocol}://${on.hostname}` : config.frontendUrl.replace(/\/$/, '');
}

/** Where links in a tenant's emails point: its verified domain, else FRONTEND_URL */
export async function appOriginForTenant(tenantId: string | null | undefined): Promise<string> {
  if (tenantId && config.customDomains) {
    const t = await controlDb.tenant.findUnique({ where: { id: tenantId }, select: { customDomain: true, customDomainStatus: true } });
    if (t?.customDomain && t.customDomainStatus === 'VERIFIED') return `https://${t.customDomain}`;
  }
  return config.frontendUrl.replace(/\/$/, '');
}

/** The API's path under the app's address ("/api" behind the bundled Caddy; "" when the API has its own host) */
export function apiPathPrefix(): string {
  const api = new URL(config.bffUrl);
  return new URL(config.frontendUrl).host === api.host ? api.pathname.replace(/\/$/, '') : '';
}

async function lookupTxt(name: string): Promise<string[]> {
  const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
  if (config.dnsServers.length) resolver.setServers(config.dnsServers);
  try {
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
    throw new Error(`The DNS lookup failed (${code ?? (err as Error).message}). Try again in a few minutes.`);
  }
}

/** Look for the TXT record now; records the outcome on the tenant. */
export async function checkDomain(tenantId: string) {
  const t = await controlDb.tenant.findUnique({ where: { id: tenantId }, select: { customDomain: true, customDomainToken: true, customDomainStatus: true } });
  if (!t?.customDomain || !t.customDomainToken) throw new AppError('Add a domain first', 400);
  const expected = verifyRecordValue(t.customDomainToken);
  let error: string | null = null;
  try {
    const found = await lookupTxt(verifyRecordName(t.customDomain));
    if (!found.includes(expected)) {
      error = found.length
        ? `${verifyRecordName(t.customDomain)} has a TXT record, but not the one shown here. DNS changes can take a while to appear.`
        : `No TXT record at ${verifyRecordName(t.customDomain)} yet. DNS changes can take a while to appear.`;
    }
  } catch (err) {
    error = (err as Error).message;
  }
  const now = new Date();
  // A domain stays verified if a later check can't reach DNS; it's only
  // moved back by removing it
  return controlDb.tenant.update({
    where: { id: tenantId },
    data: error
      ? { customDomainCheckedAt: now, customDomainError: error }
      : { customDomainStatus: 'VERIFIED', customDomainVerifiedAt: t.customDomainStatus === 'VERIFIED' ? undefined : now, customDomainCheckedAt: now, customDomainError: null },
  });
}

/** What the tenant's Settings page shows */
export function domainView(t: {
  customDomain: string | null; customDomainStatus: string | null; customDomainToken: string | null;
  customDomainVerifiedAt: Date | null; customDomainCheckedAt: Date | null; customDomainError: string | null;
}) {
  if (!t.customDomain) return { enabled: config.customDomains, domain: null };
  return {
    enabled: config.customDomains,
    domain: t.customDomain,
    status: t.customDomainStatus,
    verifiedAt: t.customDomainVerifiedAt,
    checkedAt: t.customDomainCheckedAt,
    error: t.customDomainError,
    records: [
      { type: 'CNAME', name: t.customDomain, value: config.customDomainTarget, purpose: 'Sends visitors to the platform' },
      { type: 'TXT', name: verifyRecordName(t.customDomain), value: verifyRecordValue(t.customDomainToken ?? ''), purpose: 'Proves the domain is yours' },
    ],
  };
}
