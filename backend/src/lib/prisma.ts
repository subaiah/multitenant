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

import { encryptSecretsIn } from './secrets.js';

const WRITES = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert']);

function createClient() {
  const base = new PrismaClient({
    adapter,
    log: config.nodeEnv === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });
  // Secrets (lib/secrets.ts SECRET_FIELDS) are encrypted on every write, on any
  // model, including nested relation writes, so no code path stores them in
  // plain text. Reading them back needs an explicit decryptSecret().
  return base.$extends({
    name: 'encrypt-secrets',
    query: {
      $allModels: {
        async $allOperations({ operation, args, query }) {
          if (WRITES.has(operation) && args && typeof args === 'object') {
            const a = args as Record<string, unknown>;
            encryptSecretsIn(a.data);
            encryptSecretsIn(a.create);
            encryptSecretsIn(a.update);
          }
          return query(args);
        },
      },
    },
  });
}

export type DbClient = ReturnType<typeof createClient>;

// Prisma client singleton with adapter
const globalForPrisma = globalThis as unknown as {
  prisma: DbClient | undefined;
};

export const prisma: DbClient = globalForPrisma.prisma ?? createClient();

if (config.nodeEnv !== 'production') {
  globalForPrisma.prisma = prisma;
}
