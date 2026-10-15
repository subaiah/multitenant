import 'dotenv/config';
import { z } from 'zod';

// Environment variable schema
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

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
  if (env.NODE_ENV === 'production' && !env.COOKIE_SECRET) {
    ctx.addIssue({ code: 'custom', path: ['COOKIE_SECRET'], message: 'COOKIE_SECRET is required in production' });
  }
});

// Parse and validate environment variables
const env = envSchema.parse(process.env);

export const config = {
  // Database
  databaseUrl: env.DATABASE_URL,

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
} as const;

export type Config = typeof config;
