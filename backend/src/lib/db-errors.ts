/**
 * What kind of database failure an error is, for the error handler:
 * - unavailable: the database can't be reached or refused the login (its
 *   server is down, the tenant's database or role is gone, credentials were
 *   rotated under us). The request may work again shortly: 503.
 * - read-only: a write on a read-only connection (a read-only support session): 403.
 * - denied: Postgres refused on privilege grounds, which for a tenant client
 *   means row-level security or a grant stopped it from touching rows or
 *   tables outside its tenant. Never expected from correct app code: 403, and
 *   logged as a security event.
 */
export type DatabaseErrorKind = 'unavailable' | 'denied' | 'read-only' | null;

// Prisma: can't reach (P1001), timeout (P1002), database missing (P1003),
// operation timed out (P1008), access denied (P1010), TLS (P1011), server closed (P1017), auth failed (P1000)
const UNAVAILABLE = new Set(['P1000', 'P1001', 'P1002', 'P1003', 'P1008', 'P1010', 'P1011', 'P1017']);

export function classifyDatabaseError(error: unknown): DatabaseErrorKind {
  if (!error || typeof error !== 'object') return null;
  const e = error as { name?: string; code?: string; message?: string; meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } };
  if (e.name === 'PrismaClientInitializationError') return 'unavailable';
  if (!e.name?.startsWith('PrismaClient')) return null;
  if (e.code && UNAVAILABLE.has(e.code)) return 'unavailable';
  const pgCode = e.meta?.driverAdapterError?.cause?.originalCode ?? /Code: `(\w{5})`/.exec(e.message ?? '')?.[1];
  if (pgCode === '25006') return 'read-only'; // read_only_sql_transaction
  if (pgCode === '42501') return 'denied'; // insufficient_privilege, incl. row-level security
  if (pgCode && ['57P01', '57P02', '57P03', '08000', '08003', '08006', '08001', '08004', '3D000', '28000', '28P01'].includes(pgCode)) return 'unavailable';
  return null;
}
