/**
 * Database clients, one per plane (see the tenant isolation design):
 *
 * - controlDb: the control plane (prisma/control): platform users, tenants and
 *   how to reach their data, the app catalogue, menus, support sessions.
 * - tenantDb: the tenant plane (prisma/tenant): everything a tenant owns.
 *   Today every tenant is on the shared tenant database (SHARED_TABLES); per-
 *   tenant schemas and databases come later and will be resolved per request.
 *   Route handlers use `request.db` (set by authenticate) for tenant data, not
 *   tenantDb directly, so that change stays in one place.
 *
 * test/plane-guard.test.ts fails the build if a control model is used through
 * tenantDb or the reverse.
 */
import { PrismaClient as ControlClient } from '../generated/control/index.js';
import { PrismaClient as TenantClient } from '../generated/tenant/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { config } from '../config/env.js';
import { encryptSecretsIn } from './secrets.js';

const WRITES = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert']);

// Secrets (lib/secrets.ts SECRET_FIELDS) are encrypted on every write, on any
// model, including nested relation writes, so no code path stores them in
// plain text. Reading them back needs an explicit decryptSecret().
const encryptSecrets = {
  name: 'encrypt-secrets',
  query: {
    $allModels: {
      async $allOperations({ operation, args, query }: { operation: string; args: unknown; query: (args: unknown) => Promise<unknown> }) {
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
};

const log = config.nodeEnv === 'development' ? (['query', 'error', 'warn'] as const) : (['error'] as const);

function createControl(pool: pg.Pool) {
  return new ControlClient({ adapter: new PrismaPg(pool), log: [...log] }).$extends(encryptSecrets);
}
function createTenant(pool: pg.Pool) {
  return new TenantClient({ adapter: new PrismaPg(pool), log: [...log] }).$extends(encryptSecrets);
}

export type ControlDb = ReturnType<typeof createControl>;
export type TenantDb = ReturnType<typeof createTenant>;

const g = globalThis as unknown as {
  planes?: { controlPool: pg.Pool; tenantPool: pg.Pool; controlDb: ControlDb; tenantDb: TenantDb };
};

if (!g.planes) {
  const controlPool = new pg.Pool({ connectionString: config.databaseUrl });
  const tenantPool = new pg.Pool({ connectionString: config.tenantDatabaseUrl });
  g.planes = { controlPool, tenantPool, controlDb: createControl(controlPool), tenantDb: createTenant(tenantPool) };
}

export const controlDb: ControlDb = g.planes.controlDb;
export const tenantDb: TenantDb = g.planes.tenantDb;

/** Close both planes (scripts and tests). */
export async function disconnectDatabases() {
  const planes = g.planes!;
  await Promise.all([planes.controlDb.$disconnect(), planes.tenantDb.$disconnect()]);
  await Promise.all([planes.controlPool.end(), planes.tenantPool.end()]);
  g.planes = undefined;
}
