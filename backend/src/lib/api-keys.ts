/**
 * API keys: other systems calling the API as an organization. docs/API_ACCESS.md.
 *
 *   mtk_<tenant>_<key>_<secret>
 *
 * The tenant and key ids (base64url of their UUIDs) say where to look; only
 * a SHA-256 of the secret is stored, and the whole key is shown once. Sent
 * as `Authorization: Bearer mtk_...` (or `X-API-Key`).
 *
 * A key holds a fixed set of permissions, no more than its maker had when
 * making it, and a user type (its maker's) for the rules about whom it may
 * manage. It works only on routes that take a permission: not the routes
 * for a signed-in person's own account, and not platform routes.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { controlDb } from './prisma.js';
import { dbForTenant } from './tenant-db.js';
import { AppError } from '../middleware/error-handler.js';
import { permissionMatches, PLATFORM_RESOURCES, PERMISSIONS } from '../utils/permissions.js';

export const KEY_PREFIX = 'mtk_';
/** Permissions a key can't have: making keys and webhooks, and paying */
export const NOT_FOR_KEYS = new Set(['api:manage', 'billing:manage']);

const uuidToB64 = (uuid: string) => Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url');
const b64ToUuid = (s: string) => {
  const hex = Buffer.from(s, 'base64url').toString('hex');
  return hex.length === 32 ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null;
};
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function formatKey(tenantId: string, keyId: string, secret: string) {
  return `${KEY_PREFIX}${uuidToB64(tenantId)}_${uuidToB64(keyId)}_${secret}`;
}

export function parseKey(key: string): { tenantId: string; keyId: string; secret: string } | null {
  if (!key.startsWith(KEY_PREFIX) || key.length > 200) return null;
  const parts = key.slice(KEY_PREFIX.length).split('_');
  // The secret is base64url too, and may contain "_": everything after the second separator
  if (parts.length < 3) return null;
  const [t, k, ...rest] = parts;
  const tenantId = b64ToUuid(t);
  const keyId = b64ToUuid(k);
  const secret = rest.join('_');
  if (!tenantId || !keyId || secret.length < 32) return null;
  return { tenantId, keyId, secret };
}

/** The key in a request, if it carries one (not yet checked) */
export function keyFromRequest(request: { headers: Record<string, string | string[] | undefined> }): string | null {
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith(`Bearer ${KEY_PREFIX}`)) return auth.slice(7).trim();
  const header = request.headers['x-api-key'];
  return typeof header === 'string' && header.startsWith(KEY_PREFIX) ? header.trim() : null;
}

/** For per-key rate limits: the key's id, read without checking it */
export function keyIdFromRequest(request: { headers: Record<string, string | string[] | undefined> }): string | null {
  const key = keyFromRequest(request);
  return key ? (parseKey(key)?.keyId ?? null) : null;
}

/** Which permissions someone may put on a key: their own (tenant-wide), minus the ones keys can't have */
export function grantableBy(effective: Set<string>): string[] {
  return PERMISSIONS.filter((p) => !NOT_FOR_KEYS.has(p) && !PLATFORM_RESOURCES.has(p.split(':')[0]) && permissionMatches(effective, p));
}

export async function createApiKey(tenantId: string, input: { name: string; permissions: string[]; expiresAt: Date | null; userType: string; createdById: string; createdByEmail: string | null }) {
  const secret = randomBytes(24).toString('base64url');
  const db = await dbForTenant(tenantId);
  const row = await db.apiKey.create({
    data: {
      tenantId, name: input.name, permissions: input.permissions, userType: input.userType as never, expiresAt: input.expiresAt,
      createdById: input.createdById, createdByEmail: input.createdByEmail, secretHash: sha256(secret), hint: '',
    },
  });
  const key = formatKey(tenantId, row.id, secret);
  const hint = key.slice(-4);
  await db.apiKey.update({ where: { id: row.id }, data: { hint } });
  return { ...row, hint, key };
}

export interface ApiKeyPrincipal {
  id: string;
  name: string;
  tenantId: string;
  permissions: string[];
  userType: string;
}

/**
 * Check a key: right secret, not revoked or expired, organization usable.
 * Throws 401 with a reason that doesn't say which part was wrong.
 */
export async function verifyApiKey(key: string, ip?: string): Promise<ApiKeyPrincipal> {
  const parsed = parseKey(key);
  const refuse = () => new AppError('Invalid API key', 401, true, 'INVALID_API_KEY');
  if (!parsed) throw refuse();
  const tenant = await controlDb.tenant.findUnique({ where: { id: parsed.tenantId }, select: { id: true, provisioningStatus: true } });
  if (!tenant || tenant.provisioningStatus !== 'READY') throw refuse();
  const db = await dbForTenant(tenant.id);
  const row = await db.apiKey.findFirst({ where: { id: parsed.keyId, tenantId: tenant.id } });
  if (!row) throw refuse();
  const given = Buffer.from(sha256(parsed.secret), 'hex');
  const stored = Buffer.from(row.secretHash, 'hex');
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) throw refuse();
  if (row.revokedAt) throw new AppError('This API key was revoked', 401, true, 'API_KEY_REVOKED');
  if (row.expiresAt && row.expiresAt <= new Date()) throw new AppError('This API key has expired', 401, true, 'API_KEY_EXPIRED');
  // When it was last used: at most once a minute, not on every request
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db.apiKey.updateMany({ where: { id: row.id, tenantId: tenant.id }, data: { lastUsedAt: new Date(), lastUsedIp: ip ?? null } }).catch(() => {});
  }
  return { id: row.id, name: row.name, tenantId: tenant.id, permissions: row.permissions, userType: row.userType };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when the request is authenticated by an API key rather than a person's session */
    apiKey?: ApiKeyPrincipal;
  }
}

export const isApiKeyRequest = (request: FastifyRequest) => !!request.apiKey;

/** The pseudo user id a key acts as (request.user.userId): never a real user's */
export const apiKeyUserId = (keyId: string) => `api-key:${keyId}`;
