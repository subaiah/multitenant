/**
 * Database clients (see the tenant isolation design).
 *
 * - controlDb: the control plane (prisma/control), the app's own account:
 *   platform users, tenants and how to reach their data, the app catalogue,
 *   menus, support sessions.
 * - tenant clients (prisma/tenant): one per Postgres role and target, created
 *   on demand by tenantClient() and kept in a capped least-recently-used cache.
 *   Tenant requests get theirs from dbForTenant() (lib/tenant-db.ts), which
 *   connects as the tenant's own role, so row-level security applies.
 *
 * test/planes.test.ts fails the build if a control model is used through a
 * tenant client or the reverse.
 */
import { PrismaClient as ControlClient } from '../generated/control/index.js';
import { PrismaClient as TenantClient } from '../generated/tenant/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { config } from '../config/env.js';
import { encryptSecretsIn } from './secrets.js';

const AUDIT_MODELS = new Set(['AuditEvent', 'PlatformAuditEvent']);
const WRITES = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert']);

// Secrets (lib/secrets.ts SECRET_FIELDS) are encrypted on every write, on any
// model, including nested relation writes, so no code path stores them in
// plain text. Reading them back needs an explicit decryptSecret().
const encryptSecrets = {
  name: 'encrypt-secrets',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }: { model?: string; operation: string; args: unknown; query: (args: unknown) => Promise<unknown> }) {
        // Audit entries hold no secrets (lib/audit.ts redacts them) and must be stored exactly as hashed
        if (WRITES.has(operation) && args && typeof args === 'object' && !AUDIT_MODELS.has(model ?? '')) {
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
function createTenant(pool: pg.Pool, schema: string) {
  // The adapter's schema names the tables in every generated query, so a
  // schema-per-tenant client can only ever address its own schema
  return new TenantClient({ adapter: new PrismaPg(pool, { schema }), log: [...log] }).$extends(encryptSecrets);
}

export type ControlDb = ReturnType<typeof createControl>;
export type TenantDb = ReturnType<typeof createTenant>;

interface CachedClient {
  db: TenantDb;
  pool: pg.Pool;
}

const g = globalThis as unknown as {
  planes?: { controlPool: pg.Pool; controlDb: ControlDb; tenants: Map<string, CachedClient> };
};

if (!g.planes) {
  const controlPool = new pg.Pool({ connectionString: config.databaseUrl });
  g.planes = { controlPool, controlDb: createControl(controlPool), tenants: new Map() };
}

export const controlDb: ControlDb = g.planes.controlDb;

/**
 * A tenant-plane client for a connection string (a tenant role, or the
 * platform role on some target) and schema. Clients are cached; the least
 * recently used is closed once more than TENANT_CLIENT_CACHE_MAX are open.
 */
export function tenantClient(connectionString: string, schema = 'public', { readOnly = false } = {}): TenantDb {
  const tenants = g.planes!.tenants;
  const key = `${schema}\u0000${connectionString}${readOnly ? '\u0000ro' : ''}`;
  const hit = tenants.get(key);
  if (hit) {
    // Map keeps insertion order: re-insert to mark as most recently used
    tenants.delete(key);
    tenants.set(key, hit);
    return hit.db;
  }
  const pool = new pg.Pool({
    connectionString,
    max: config.tenantPoolMax,
    idleTimeoutMillis: 30_000,
    // Read-only support sessions: Postgres itself refuses any write on these connections
    ...(readOnly && { options: '-c default_transaction_read_only=on' }),
  });
  // A tenant database going away must not crash the server
  pool.on('error', () => {});
  const entry = { db: createTenant(pool, schema), pool };
  tenants.set(key, entry);
  while (tenants.size > config.tenantClientCacheMax) {
    const [oldestKey, oldest] = tenants.entries().next().value!;
    tenants.delete(oldestKey);
    void close(oldest);
  }
  return entry.db;
}

async function close(c: CachedClient) {
  await c.db.$disconnect().catch(() => {});
  await c.pool.end().catch(() => {});
}

/** Close cached clients matching a predicate on their connection string (e.g. before dropping a database or role). */
export async function closeTenantClients(match: (connectionString: string, schema: string) => boolean) {
  const tenants = g.planes!.tenants;
  const closing: Promise<void>[] = [];
  for (const [key, entry] of tenants) {
    const [schema, url] = key.split('\u0000');
    if (match(url, schema)) {
      tenants.delete(key);
      closing.push(close(entry));
    }
  }
  await Promise.all(closing);
}

/** Close every connection (scripts and tests). */
export async function disconnectDatabases() {
  const planes = g.planes;
  if (!planes) return;
  await Promise.all([...planes.tenants.values()].map(close));
  planes.tenants.clear();
  await planes.controlDb.$disconnect();
  await planes.controlPool.end();
  g.planes = undefined;
}
