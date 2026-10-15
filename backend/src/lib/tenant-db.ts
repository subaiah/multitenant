/**
 * The one place that decides which database a tenant's requests use.
 *
 * Each tenant has its own Postgres role; its connection string (encrypted) and
 * target live in the tenant's database config in the control plane. The config
 * is cached for about a minute; forgetTenant() drops it when it changes.
 * Clients themselves are cached by lib/prisma.ts.
 */
import { controlDb, tenantClient, type TenantDb } from './prisma.js';
import { decryptSecret, secretContext } from './secrets.js';
import { schemaOf, targetOf, type Target } from './tenant-targets.js';
import { AppError } from '../middleware/error-handler.js';

export type { TenantDb };

const TTL_MS = 60_000;
const configs = new Map<string, { expires: number; url: string; target: Target }>();

async function load(tenantId: string) {
  const hit = configs.get(tenantId);
  if (hit && hit.expires > Date.now()) return hit;
  const cfg = await controlDb.databaseConfig.findUnique({ where: { tenantId } });
  if (!cfg?.connectionString) {
    // Not provisioned (yet): nothing to connect to
    throw new AppError('This tenant is not set up yet', 503);
  }
  const entry = {
    expires: Date.now() + TTL_MS,
    url: decryptSecret(cfg.connectionString, secretContext('connectionString')),
    target: targetOf(cfg),
  };
  configs.set(tenantId, entry);
  return entry;
}

/** The tenant's own client: connected as its role, so it sees only its rows. */
export async function dbForTenant(tenantId: string): Promise<TenantDb> {
  const { url, target } = await load(tenantId);
  return tenantClient(url, schemaOf(target));
}

/** Where a tenant's data lives (for platform work on its target). */
export async function targetForTenant(tenantId: string): Promise<Target> {
  return (await load(tenantId)).target;
}

/** Forget the cached config after it changes (provisioning, deletion, password rotation). */
export function forgetTenant(tenantId: string) {
  configs.delete(tenantId);
}
