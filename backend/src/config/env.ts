import 'dotenv/config';
import { z } from 'zod';

// Environment variable schema
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),
  // The shared tenant database, connected as the migration owner (owns every
  // tenant table, runs tenant migrations). Holds tenants on SHARED_TABLES and the
  // schemas of tenants on SCHEMA_PER_TENANT. Must differ from DATABASE_URL.
  // Tenant requests never use it: they connect as the tenant's own role.
  TENANT_DATABASE_URL: z.string().url(),
  // Same server, as the provisioner (CREATEROLE, CREATEDB): creates and drops
  // tenant roles and databases. See prisma/tenant/setup-roles.sql.
  TENANT_PROVISIONER_URL: z.string().url().optional(),
  // Same server, as the platform role (BYPASSRLS): cross-tenant platform work
  // (usage snapshots, re-encrypting secrets) and tests. Database name is swapped per target.
  TENANT_PLATFORM_URL: z.string().url().optional(),
  // Tenant connections: max pool size per tenant role, how many tenant clients
  // stay open (least recently used are closed), and each role's connection limit
  TENANT_POOL_MAX: z.string().default('3').transform(Number),
  TENANT_CLIENT_CACHE_MAX: z.string().default('100').transform(Number),
  TENANT_ROLE_CONNECTION_LIMIT: z.string().default('10').transform(Number),
  // Prefix of every tenant role, schema and database name (tnt_<slug>). Use a
  // different one per environment sharing a database server (e.g. dev_, e2e_):
  // role names are server-wide.
  TENANT_ROLE_PREFIX: z.string().regex(/^[a-z][a-z0-9]{0,11}_$/, 'lowercase letters and digits, ending in _').default('tnt_'),
  // Where tenant migrations are read from (default prisma/tenant/migrations)
  TENANT_MIGRATIONS_DIR: z.string().optional(),
  // How often platform usage snapshots refresh (ms); 0 turns the job off
  TENANT_USAGE_REFRESH_MS: z.string().default('300000').transform(Number),

  // Server
  // Defaults to production so a deployment that forgets NODE_ENV gets secure behaviour.
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.string().default('4000').transform(Number),
  HOST: z.string().default('0.0.0.0'),

  // JWT
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('24h'),

  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Rate Limiting
  RATE_LIMIT_MAX: z.string().default('1000').transform(Number),
  RATE_LIMIT_TIME_WINDOW: z.string().default('60000').transform(Number),

  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Multi-tenancy
  DEFAULT_TENANT_STRATEGY: z.enum(['DATABASE_PER_TENANT', 'SCHEMA_PER_TENANT', 'SHARED_TABLES']).default('SHARED_TABLES'),
  TENANT_HEADER: z.string().default('x-tenant-id'),

  // BFF Configuration
  BFF_URL: z.string().default('http://localhost:4000'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  COOKIE_SECRET: z.string().min(32).optional(),
  ACCESS_TOKEN_EXPIRY: z.string().default('15m'), // Short-lived access tokens
  REFRESH_TOKEN_EXPIRY: z.string().default('7d'), // Longer-lived refresh tokens

  // Development only: return OTP codes in API responses instead of sending them.
  // Ignored unless NODE_ENV=development.
  DEV_EXPOSE_OTP: z.enum(['true', 'false']).default('false'),

  // Email: smtp (real delivery), log (print to the server log), file (append
  // JSON lines to MAIL_OUTBOX_FILE; used by tests)
  EMAIL_TRANSPORT: z.enum(['smtp', 'log', 'file']).default('log'),
  SMTP_URL: z.string().optional(), // e.g. smtps://user:pass@smtp.example.com:465
  MAIL_FROM: z.string().default('Multitenant Platform <no-reply@localhost>'),
  MAIL_OUTBOX_FILE: z.string().optional(),
}).superRefine((env, ctx) => {
  if (env.EMAIL_TRANSPORT === 'smtp' && !env.SMTP_URL) {
    ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'SMTP_URL is required when EMAIL_TRANSPORT=smtp' });
  }
  if (env.EMAIL_TRANSPORT === 'file' && !env.MAIL_OUTBOX_FILE) {
    ctx.addIssue({ code: 'custom', path: ['MAIL_OUTBOX_FILE'], message: 'MAIL_OUTBOX_FILE is required when EMAIL_TRANSPORT=file' });
  }
  if (env.TENANT_DATABASE_URL === env.DATABASE_URL) {
    ctx.addIssue({ code: 'custom', path: ['TENANT_DATABASE_URL'], message: 'TENANT_DATABASE_URL must be a different database from DATABASE_URL' });
  }
  if (env.NODE_ENV === 'production') {
    for (const key of ['TENANT_PROVISIONER_URL', 'TENANT_PLATFORM_URL'] as const) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required in production (see prisma/tenant/setup-roles.sql)` });
    }
  }
  if (env.NODE_ENV === 'production' && !env.COOKIE_SECRET) {
    ctx.addIssue({ code: 'custom', path: ['COOKIE_SECRET'], message: 'COOKIE_SECRET is required in production' });
  }
});

/**
 * Keys for encrypting stored secrets (lib/secrets.ts): SECRETS_KEY_V1,
 * SECRETS_KEY_V2, ... each 32 random bytes, base64. The highest version
 * encrypts new values; older ones stay to read what they encrypted until a
 * re-encrypt run has moved everything on. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
function readSecretKeys(nodeEnv: string): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  for (const [name, value] of Object.entries(process.env)) {
    const m = /^SECRETS_KEY_V([1-9]\d{0,3})$/.exec(name);
    if (!m || !value) continue;
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) {
      throw new Error(`${name} must be 32 bytes, base64-encoded (got ${key.length} bytes)`);
    }
    keys.set(Number(m[1]), key);
  }
  if (keys.size === 0) {
    if (nodeEnv === 'production') {
      throw new Error('SECRETS_KEY_V1 is required in production (32 random bytes, base64)');
    }
    // Development and tests only: a fixed, public key so local data stays readable
    keys.set(1, Buffer.from('ZGV2LW9ubHktc2VjcmV0cy1rZXktZG8tbm90LXVzZSE=', 'base64'));
  }
  return keys;
}

// Parse and validate environment variables
const env = envSchema.parse(process.env);

export const config = {
  // Database
  databaseUrl: env.DATABASE_URL,
  tenantDatabaseUrl: env.TENANT_DATABASE_URL,
  // Outside production these fall back to the owner connection, which works
  // when that account is a superuser (a local database)
  tenantProvisionerUrl: env.TENANT_PROVISIONER_URL ?? env.TENANT_DATABASE_URL,
  tenantPlatformUrl: env.TENANT_PLATFORM_URL ?? env.TENANT_DATABASE_URL,
  tenantPoolMax: env.TENANT_POOL_MAX,
  tenantClientCacheMax: env.TENANT_CLIENT_CACHE_MAX,
  tenantRoleConnectionLimit: env.TENANT_ROLE_CONNECTION_LIMIT,
  tenantRolePrefix: env.TENANT_ROLE_PREFIX,
  tenantMigrationsDir: env.TENANT_MIGRATIONS_DIR,
  tenantUsageRefreshMs: env.TENANT_USAGE_REFRESH_MS,

  // Server
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  host: env.HOST,

  // JWT
  jwtSecret: env.JWT_SECRET,
  jwtExpiresIn: env.JWT_EXPIRES_IN,

  // CORS
  corsOrigin: env.CORS_ORIGIN,

  // Rate Limiting
  rateLimitMax: env.RATE_LIMIT_MAX,
  rateLimitTimeWindow: env.RATE_LIMIT_TIME_WINDOW,

  // Logging
  logLevel: env.LOG_LEVEL,

  // Multi-tenancy
  defaultTenantStrategy: env.DEFAULT_TENANT_STRATEGY,
  tenantHeader: env.TENANT_HEADER,

  // BFF Configuration
  bffUrl: env.BFF_URL,
  frontendUrl: env.FRONTEND_URL,
  cookieSecret: env.COOKIE_SECRET ?? 'dev-only-cookie-secret-not-for-production-use',

  email: {
    transport: env.EMAIL_TRANSPORT,
    smtpUrl: env.SMTP_URL,
    from: env.MAIL_FROM,
    outboxFile: env.MAIL_OUTBOX_FILE,
  },

  // Dev convenience: expose OTPs / user-not-found details. Never true outside development.
  devExposeOtp: env.NODE_ENV === 'development' && env.DEV_EXPOSE_OTP === 'true',
  accessTokenExpiry: env.ACCESS_TOKEN_EXPIRY,
  refreshTokenExpiry: env.REFRESH_TOKEN_EXPIRY,

  /** Encryption keys for stored secrets, by version; see readSecretKeys */
  secretKeys: readSecretKeys(env.NODE_ENV),
} as const;

export type Config = typeof config;
