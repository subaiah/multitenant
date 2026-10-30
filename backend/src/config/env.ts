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
  // Proxies in front of the server (load balancer, Caddy/nginx, Cloudflare),
  // whose X-Forwarded-For the server believes: how many hops ("1"), or which
  // addresses ("10.0.0.0/8,172.16.0.0/12"). Without it every request seems to
  // come from the proxy, so per-IP limits and audit addresses are wrong.
  // "false" (the default) when clients connect directly.
  TRUST_PROXY: z.string().default('false'),
  // The interactive API reference at /docs: always outside production, and in
  // production only when turned on here
  API_DOCS: z.enum(['true', 'false']).optional(),
  // Pages that show sample data rather than real measurements (deployed
  // applications and their resource use, the API gateway settings, backup and
  // encryption switches). Shown outside production unless turned off; hidden
  // in production unless turned on.
  PREVIEW_FEATURES: z.enum(['true', 'false']).optional(),

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
  // Platform users' sessions (tenants set their own in Authentication settings):
  // signed out after this many idle minutes, and after this many hours in all
  PLATFORM_SESSION_IDLE_MINUTES: z.string().default('30').transform(Number),
  PLATFORM_SESSION_MAX_HOURS: z.string().default('12').transform(Number),
  // Require two-factor sign-in for every platform user
  PLATFORM_MFA_REQUIRED: z.enum(['true', 'false']).default('false'),

  // Audit log (lib/audit.ts): entries older than this move to archive files
  AUDIT_RETENTION_DAYS: z.string().default('365').transform(Number),
  AUDIT_ARCHIVE_DIR: z.string().default('./audit-archive'),
  // How often to archive (0 = never automatically; run npm run audit:archive)
  AUDIT_ARCHIVE_INTERVAL_MS: z.string().default('86400000').transform(Number),
  // Organizations' data exports (lib/data-export.ts): where the files go
  // (shared storage when running several API servers), and for how many days
  // each can be downloaded
  EXPORT_DIR: z.string().default('./exports'),
  EXPORT_RETENTION_DAYS: z.string().default('7').transform(Number).pipe(z.number().int().min(1)),

  // Self-service sign-up (routes/signup.ts): anyone can create an organization
  // after confirming their email. "false" leaves creating tenants to platform staff.
  SELF_SIGNUP: z.enum(['true', 'false']).default('true'),
  // The plan an organization that signed itself up starts on (as a trial)
  SIGNUP_PLAN: z.enum(['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE']).default('FREE'),
  // A bot check on the sign-up form (Cloudflare Turnstile): both keys, or neither
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  TURNSTILE_VERIFY_URL: z.string().url().default('https://challenges.cloudflare.com/turnstile/v0/siteverify'),
  // Refuse throwaway email addresses (a built-in list, lib/disposable-email.ts),
  // plus any domains listed here ("example.com,example.org")
  SIGNUP_BLOCK_DISPOSABLE: z.enum(['true', 'false']).default('true'),
  SIGNUP_BLOCKED_EMAIL_DOMAINS: z.string().optional(),

  // Trials (lib/tenant-lifecycle.ts): how long a new trial lasts (0 = no end),
  // and how many days before the end its admins are reminded. When it ends the
  // organization is read-only until platform staff change its status.
  TRIAL_DAYS: z.string().default('14').transform(Number).pipe(z.number().int().min(0)),
  TRIAL_REMINDER_DAYS: z.string().default('3').transform(Number).pipe(z.number().int().min(0)),
  // An organization its admins close is kept (suspended) this many days, so
  // platform staff can restore it, then deleted
  CLOSE_GRACE_DAYS: z.string().default('30').transform(Number).pipe(z.number().int().min(0)),
  // How often trials, closures and old sign-up requests are checked (0 = never)
  TENANT_LIFECYCLE_INTERVAL_MS: z.string().default('3600000').transform(Number),

  // Custom domains (lib/domains.ts): organizations can use their own web
  // address. Tenants point it (CNAME) at CUSTOM_DOMAIN_TARGET, by default
  // FRONTEND_URL's host, and prove it with a TXT record.
  CUSTOM_DOMAINS: z.enum(['true', 'false']).default('true'),
  CUSTOM_DOMAIN_TARGET: z.string().optional(),
  // DNS servers for checking those records ("1.1.1.1,8.8.8.8"; port allowed).
  // Default: the system's resolver.
  DNS_SERVERS: z.string().optional(),
  // How often a verified domain is checked again (hours; 0 = never). One that
  // no longer points here, and no longer has its TXT record, twice in a row,
  // goes back to pending, so emails stop linking to it.
  DOMAIN_RECHECK_HOURS: z.string().default('24').transform(Number).pipe(z.number().min(0)),

  // Support sessions (lib/support.ts): longest a session may last, and whether
  // someone with support:manage may approve their own (one-person teams)
  SUPPORT_MAX_HOURS: z.string().default('8').transform(Number),
  SUPPORT_SELF_APPROVAL: z.enum(['true', 'false']).default('false'),

  // Notifications (lib/notifications.ts): how often to look for due work
  // (retries, work left by a stopped server; 0 = only right after events)
  NOTIFICATION_POLL_MS: z.string().default('15000').transform(Number),
  // In-app notifications older than this are removed
  NOTIFICATION_RETENTION_DAYS: z.string().default('90').transform(Number),

  // Background jobs (lib/jobs.ts): notifications, data exports, audit
  // archiving, usage snapshots, trials and closures, rate-limit cleanup. On by
  // default; turn off on API servers when a separate worker runs them
  // (node dist/worker.js; the `worker` service in deploy/docker-compose.yml).
  RUN_JOBS: z.enum(['true', 'false']).default('true'),
  // How often the job runner looks for data exports to build
  EXPORT_POLL_MS: z.string().default('10000').transform(Number),

  // Error tracking (lib/error-reporting.ts), optional: a Sentry project's DSN
  // for server errors, and one for errors in people's browsers (can be the
  // same project). Browsers send theirs through the API (/bff/errors), so no
  // other address has to be allowed in the content policy.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_FRONTEND_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  // Which build is running (a git commit, say): shown with each error
  APP_VERSION: z.string().optional(),

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
  if (!env.TURNSTILE_SITE_KEY !== !env.TURNSTILE_SECRET_KEY) {
    ctx.addIssue({ code: 'custom', path: ['TURNSTILE_SECRET_KEY'], message: 'Set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or neither' });
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
function readKeys(prefix: string, nodeEnv: string, devKey: string): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  for (const [name, value] of Object.entries(process.env)) {
    const m = new RegExp(`^${prefix}_V([1-9]\\d{0,3})$`).exec(name);
    if (!m || !value) continue;
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) {
      throw new Error(`${name} must be 32 bytes, base64-encoded (got ${key.length} bytes)`);
    }
    keys.set(Number(m[1]), key);
  }
  if (keys.size === 0) {
    if (nodeEnv === 'production') {
      throw new Error(`${prefix}_V1 is required in production (32 random bytes, base64)`);
    }
    // Development and tests only: a fixed, public key so local data stays readable
    keys.set(1, Buffer.from(devKey, 'base64'));
  }
  return keys;
}

const readSecretKeys = (nodeEnv: string) => readKeys('SECRETS_KEY', nodeEnv, 'ZGV2LW9ubHktc2VjcmV0cy1rZXktZG8tbm90LXVzZSE=');
/**
 * Keys that sign audit entries (lib/audit.ts): AUDIT_KEY_V1, AUDIT_KEY_V2, ...
 * like SECRETS_KEY_V*. Kept apart from the database, so whoever can write to
 * the database still can't forge a consistent audit chain. Never remove an
 * old version while entries signed with it remain (live or archived).
 */
const readAuditKeys = (nodeEnv: string) => readKeys('AUDIT_KEY', nodeEnv, 'ZGV2LW9ubHktYXVkaXQta2V5LWRvLW5vdC11c2UtISE=');

/** TRUST_PROXY as Fastify's trustProxy option: false, the nearest N hops, or addresses */
function parseTrustProxy(value: string): false | string[] | ((address: string, hop: number) => boolean) {
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'false') return false;
  if (v === 'true') {
    throw new Error('TRUST_PROXY=true would believe any client that sends X-Forwarded-For; give the number of proxies (e.g. 1) or their addresses');
  }
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_address, hop) => hop < hops;
  }
  return v.split(',').map((s) => s.trim()).filter(Boolean);
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
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  apiDocs: env.API_DOCS ? env.API_DOCS === 'true' : env.NODE_ENV !== 'production',
  previewFeatures: env.PREVIEW_FEATURES ? env.PREVIEW_FEATURES === 'true' : env.NODE_ENV !== 'production',

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
  platformSessionIdleMinutes: env.PLATFORM_SESSION_IDLE_MINUTES,
  platformSessionMaxHours: env.PLATFORM_SESSION_MAX_HOURS,
  platformMfaRequired: env.PLATFORM_MFA_REQUIRED === 'true',
  auditRetentionDays: env.AUDIT_RETENTION_DAYS,
  auditArchiveDir: env.AUDIT_ARCHIVE_DIR,
  exportDir: env.EXPORT_DIR,
  exportRetentionDays: env.EXPORT_RETENTION_DAYS,
  auditArchiveIntervalMs: env.AUDIT_ARCHIVE_INTERVAL_MS,
  notificationPollMs: env.NOTIFICATION_POLL_MS,
  supportMaxHours: env.SUPPORT_MAX_HOURS,
  selfSignup: env.SELF_SIGNUP === 'true',
  signupPlan: env.SIGNUP_PLAN,
  turnstile: env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY
    ? { siteKey: env.TURNSTILE_SITE_KEY, secretKey: env.TURNSTILE_SECRET_KEY, verifyUrl: env.TURNSTILE_VERIFY_URL }
    : null,
  signupBlockDisposable: env.SIGNUP_BLOCK_DISPOSABLE === 'true',
  signupBlockedDomains: (env.SIGNUP_BLOCKED_EMAIL_DOMAINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  trialDays: env.TRIAL_DAYS,
  trialReminderDays: env.TRIAL_REMINDER_DAYS,
  closeGraceDays: env.CLOSE_GRACE_DAYS,
  tenantLifecycleIntervalMs: env.TENANT_LIFECYCLE_INTERVAL_MS,
  customDomains: env.CUSTOM_DOMAINS === 'true',
  customDomainTarget: env.CUSTOM_DOMAIN_TARGET || new URL(env.FRONTEND_URL).hostname,
  domainRecheckHours: env.DOMAIN_RECHECK_HOURS,
  dnsServers: env.DNS_SERVERS ? env.DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean) : [],
  supportSelfApproval: env.SUPPORT_SELF_APPROVAL === 'true',
  notificationRetentionDays: env.NOTIFICATION_RETENTION_DAYS,
  runJobs: env.RUN_JOBS === 'true',
  exportPollMs: env.EXPORT_POLL_MS,
  sentry: {
    dsn: env.SENTRY_DSN ?? null,
    frontendDsn: env.SENTRY_FRONTEND_DSN ?? null,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    release: env.APP_VERSION ?? null,
  },

  /** Encryption keys for stored secrets, by version; see readSecretKeys */
  secretKeys: readSecretKeys(env.NODE_ENV),
  auditKeys: readAuditKeys(env.NODE_ENV),
} as const;

export type Config = typeof config;
