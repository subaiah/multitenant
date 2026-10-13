import 'dotenv/config';
import { z } from 'zod';

// Environment variable schema
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
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
} as const;

export type Config = typeof config;
