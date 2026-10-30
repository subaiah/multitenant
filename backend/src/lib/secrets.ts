/**
 * Encryption for secrets stored in the database (tenant connection strings,
 * SSO client secrets, ...). AES-256-GCM with a versioned key from the
 * environment (config.secretKeys), so keys can be rotated.
 *
 * Stored form: `enc:v<key version>:<iv>:<ciphertext>:<auth tag>` (base64url).
 * The `context` (e.g. "database_configs.connection_string") is bound in as
 * additional authenticated data: a value copied into another column won't
 * decrypt there.
 *
 * Values are encrypted on write by the Prisma extension in lib/prisma.ts and
 * decrypted only where they're used, with decryptSecret().
 */
import crypto from 'node:crypto';
import { config } from '../config/env.js';

const PREFIX = 'enc:';
const FORMAT = /^enc:v(\d+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]*):([A-Za-z0-9_-]+)$/;

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

export function isEncrypted(value: string): boolean {
  return FORMAT.test(value);
}

/** The key version a stored value was encrypted with, or null for plain text. */
export function secretKeyVersion(value: string): number | null {
  const m = FORMAT.exec(value);
  return m ? Number(m[1]) : null;
}

export function activeKeyVersion(keys: Map<number, Buffer> = config.secretKeys): number {
  return Math.max(...keys.keys());
}

export function encryptSecret(plaintext: string, context: string, keys: Map<number, Buffer> = config.secretKeys): string {
  const version = activeKeyVersion(keys);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.get(version)!, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}v${version}:${iv.toString('base64url')}:${ciphertext.toString('base64url')}:${tag.toString('base64url')}`;
}

/**
 * Decrypt a stored value. Plain text written before encryption was turned on
 * is returned as is (run `npm run secrets:encrypt` to convert it).
 * Throws SecretDecryptionError if the key is missing, or the value was
 * tampered with or belongs to a different context. The message never
 * contains the value.
 */
export function decryptSecret(stored: string, context: string, keys: Map<number, Buffer> = config.secretKeys): string {
  if (!isEncrypted(stored)) return stored;
  const m = FORMAT.exec(stored);
  if (!m) throw new SecretDecryptionError(`Malformed encrypted value for ${context}`);
  const [, version, iv, ciphertext, tag] = m;
  const key = keys.get(Number(version));
  if (!key) throw new SecretDecryptionError(`No key for version v${version} (set SECRETS_KEY_V${version})`);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptionError(`Could not decrypt ${context}: wrong key, or the value was altered`);
  }
}

/**
 * Every column that holds a secret, by field name (each name is used by one
 * model only; test/secrets.test.ts checks that against the schema). The Prisma
 * extension in lib/prisma.ts encrypts these on every write, nested writes
 * included; src/cli/encrypt-secrets.ts (npm run secrets:encrypt) converts and re-keys existing rows.
 */
export const SECRET_FIELDS = {
  connectionString: { model: 'DatabaseConfig', table: 'database_configs', column: 'connection_string' },
  clientSecret: { model: 'AuthProvider', table: 'auth_providers', column: 'client_secret' },
  totpSecret: { model: 'User', table: 'users', column: 'totp_secret' },
  platformTotpSecret: { model: 'PlatformUser', table: 'platform_users', column: 'totp_secret' },
  signingSecret: { model: 'WebhookEndpoint', table: 'webhook_endpoints', column: 'signing_secret' },
  oidcClientSecret: { model: 'ApplicationSignIn', table: 'application_sign_ins', column: 'client_secret' },
  privateJwk: { model: 'OidcSigningKey', table: 'oidc_signing_keys', column: 'private_jwk' },
} as const;

export type SecretField = keyof typeof SECRET_FIELDS;
export const secretContext = (field: SecretField) => `${SECRET_FIELDS[field].table}.${SECRET_FIELDS[field].column}`;

const isSecretField = (key: string): key is SecretField => Object.prototype.hasOwnProperty.call(SECRET_FIELDS, key);

/**
 * Walk a Prisma write payload (data / create / update, nested relation writes
 * and arrays included) and encrypt every secret field in place. Values that
 * are already encrypted, empty or null are left alone.
 */
export function encryptSecretsIn(payload: unknown): void {
  if (Array.isArray(payload)) {
    for (const item of payload) encryptSecretsIn(item);
    return;
  }
  if (payload === null || typeof payload !== 'object' || payload instanceof Date) return;
  const obj = payload as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (isSecretField(key)) {
      // Scalar updates may also be written as { set: value }
      const wrapped = value !== null && typeof value === 'object' && 'set' in (value as object);
      const raw = wrapped ? (value as { set: unknown }).set : value;
      if (typeof raw === 'string' && raw !== '' && !isEncrypted(raw)) {
        const encrypted = encryptSecret(raw, secretContext(key));
        obj[key] = wrapped ? { set: encrypted } : encrypted;
      }
    } else if (value !== null && typeof value === 'object') {
      encryptSecretsIn(value);
    }
  }
}
