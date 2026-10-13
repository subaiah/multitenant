import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { config } from '../config/env.js';

// Create PostgreSQL connection pool
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

// Create Prisma adapter for PostgreSQL
const adapter = new PrismaPg(pool);

// Prisma client singleton with adapter
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: config.nodeEnv === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (config.nodeEnv !== 'production') {
  globalForPrisma.prisma = prisma;
}
