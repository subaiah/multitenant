/**
 * Audit log: a tamper-evident record of who did what, to which record, when
 * and from where. Separate from the activity feed (lib/activity.ts), which is
 * for people to skim; this is for accountability.
 *
 * Chains. Each tenant has one (its audit_events rows, in the tenant's own
 * data, whatever its isolation mode), and the platform has one
 * (platform_audit_events in the control plane). Each entry has a sequence
 * number and an HMAC-SHA256 over its content and the previous entry's hash,
 * made with a key from the environment (AUDIT_KEY_V<n>), not the database.
 * Editing, removing or reordering entries breaks the chain, and without the
 * key it can't be rebuilt. The latest entry of each chain is also kept in the
 * control plane (audit_heads), so cutting entries off the end shows too.
 *
 * Append-only. Tenant roles may only insert and read audit rows (the
 * migration runner grants nothing else), and a trigger refuses updates.
 *
 * Retention. Entries older than AUDIT_RETENTION_DAYS are moved to gzipped
 * JSON-lines files under AUDIT_ARCHIVE_DIR (audit_archives lists them) and
 * removed from the live table; verification continues across them. A
 * tenant's whole log is archived before the tenant is deleted.
 *
 * Recording never fails the action it records: the action has already
 * happened, so a failure to record is logged loudly instead.
 */
import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createGzip, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import { config } from '../config/env.js';
import { controlDb } from './prisma.js';
import { dbForTenant, targetForTenant } from './tenant-db.js';
import { platformDb } from './tenant-targets.js';
import { SECRET_FIELDS } from './secrets.js';
import { KIT_AUDIT_EVENTS, type AuditCategory, type AuditEventDefinition } from '../kit/audit-events.js';
import { product } from '../product/index.js';
import { isPlatformUser } from '../utils/authorization.js';

export const GENESIS = '0'.repeat(64);
export const PLATFORM_CHAIN = 'platform';

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** Kit and product events together. */
export function auditCatalog(): Record<string, AuditEventDefinition> {
  const productEvents = product.auditEvents ?? {};
  for (const key of Object.keys(productEvents)) {
    if (key in KIT_AUDIT_EVENTS) throw new Error(`Product audit event "${key}" reuses a kit event key`);
  }
  return { ...KIT_AUDIT_EVENTS, ...productEvents };
}

// ---------------------------------------------------------------------------
// Entries and hashing
// ---------------------------------------------------------------------------

export type AuditOutcome = 'SUCCESS' | 'FAILURE';
export type AuditActorType = 'USER' | 'PLATFORM' | 'SYSTEM' | 'ANONYMOUS';

export interface AuditActor {
  type: AuditActorType;
  id?: string | null;
  email?: string | null;
}

export interface AuditInput {
  /** What it was done to */
  resource?: { type: string; id?: string | null; label?: string | null };
  /** Field changes, { field: [before, after] } (see diff()) */
  changes?: Record<string, [unknown, unknown]>;
  /** Anything else worth keeping */
  details?: Record<string, unknown>;
  outcome?: AuditOutcome;
  /** Platform entries: the tenant the action concerned */
  tenantId?: string | null;
}

export interface AuditContext {
  actor: AuditActor;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  /** The tenant whose log tenant-scoped entries go in */
  tenantId?: string | null;
}

/** The stored fields covered by the hash (everything but id, hashes and key version). */
interface Content {
  chain: string;
  seq: number;
  occurredAt: string;
  event: string;
  category: string;
  outcome: AuditOutcome;
  actorType: AuditActorType;
  actorId: string | null;
  actorEmail: string | null;
  tenantId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  resourceLabel: string | null;
  changes: unknown;
  details: unknown;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/** JSON with keys sorted at every level, so the same content always hashes the same. */
export function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function activeAuditKeyVersion(keys = config.auditKeys): number {
  return Math.max(...keys.keys());
}

export function hashEntry(prevHash: string, content: Content, keyVersion: number, keys = config.auditKeys): string {
  const key = keys.get(keyVersion);
  if (!key) throw new Error(`AUDIT_KEY_V${keyVersion} is not configured`);
  return crypto.createHmac('sha256', key).update(`${prevHash}\n${canonical(content)}`).digest('hex');
}

/** A row as stored, back to the content that was hashed. */
function contentOf(chain: string, row: StoredEntry): Content {
  return {
    chain,
    seq: row.seq,
    occurredAt: new Date(row.occurredAt).toISOString(),
    event: row.event,
    category: row.category,
    outcome: row.outcome,
    actorType: row.actorType,
    actorId: row.actorId ?? null,
    actorEmail: row.actorEmail ?? null,
    tenantId: chain === PLATFORM_CHAIN ? (row.tenantId ?? null) : chain,
    resourceType: row.resourceType ?? null,
    resourceId: row.resourceId ?? null,
    resourceLabel: row.resourceLabel ?? null,
    changes: row.changes ?? null,
    details: row.details ?? null,
    ip: row.ip ?? null,
    userAgent: row.userAgent ?? null,
    requestId: row.requestId ?? null,
  };
}

export interface StoredEntry {
  id: string;
  tenantId?: string | null;
  seq: number;
  occurredAt: Date | string;
  event: string;
  category: string;
  outcome: AuditOutcome;
  actorType: AuditActorType;
  actorId: string | null;
  actorEmail: string | null;
  resourceType: string | null;
  resourceId: string | null;
  resourceLabel: string | null;
  changes: unknown;
  details: unknown;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  prevHash: string;
  hash: string;
  keyVersion: number;
}

// Field names whose values never go in the audit log
const SENSITIVE = new Set<string>([
  ...Object.keys(SECRET_FIELDS),
  'password', 'passwordHash', 'token', 'tokenHash', 'codeVerifier', 'mfaRecoveryCodes', 'recoveryCodes', 'secret', 'code',
]);

const MASKED = ['[redacted]', '[changed]'];
const isMasked = (v: unknown) => (Array.isArray(v) ? v.every((x) => typeof x === 'string' && MASKED.includes(x)) : typeof v === 'string' && MASKED.includes(v));

/** Copy with sensitive values replaced. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.has(k) && v != null && !isMasked(v) ? '[redacted]' : redact(v)]),
    );
  }
  return value;
}

/** The fields of `after` that differ from `before`, as { field: [before, after] }. */
export function diff<T extends Record<string, unknown>>(before: T | null | undefined, after: Partial<T>, fields?: (keyof T)[]) {
  const changes: Record<string, [unknown, unknown]> = {};
  for (const key of fields ?? (Object.keys(after) as (keyof T)[])) {
    const a = before?.[key] ?? null;
    const b = after[key] === undefined ? a : (after[key] ?? null);
    if (canonical(redact(a)) !== canonical(redact(b))) {
      changes[key as string] = SENSITIVE.has(key as string) ? ['[redacted]', '[changed]'] : [redact(a), redact(b)];
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

type Listener = (entry: { chain: string; event: string; definition: AuditEventDefinition; entry: Content }) => void | Promise<void>;
const listeners: Listener[] = [];
/** Run something for every recorded entry (e.g. notifications). Errors are logged, not thrown. */
export function onAudit(listener: Listener) {
  listeners.push(listener);
}

/**
 * Run something inside the transaction that records an entry, so it is saved
 * if and only if the entry is (the notification outbox). `tx` is the control
 * plane's transaction for the platform chain, the tenant's otherwise.
 */
type TxHook = (args: { tx: unknown; chain: string; entry: Content }) => Promise<void>;
const txHooks: TxHook[] = [];
export function onAuditInTransaction(hook: TxHook) {
  txHooks.push(hook);
}
export type AuditContent = Content;
let extensionsLoaded: Promise<unknown> | null = null;

let warn: (msg: string, err?: unknown) => void = (msg, err) => console.error(msg, err);
export function setAuditLogger(fn: typeof warn) {
  warn = fn;
}

/** Who made the request, for the audit log (emails looked up once per request). */
async function actorOf(request: FastifyRequest): Promise<AuditActor> {
  const cached = (request as unknown as { auditActor?: AuditActor }).auditActor;
  if (cached) return cached;
  const user = (request as { user?: { userId?: string; tenantId?: string; userType?: string } }).user;
  let actor: AuditActor = { type: 'ANONYMOUS' };
  if (user?.userId) {
    if (isPlatformUser(user.userType as never)) {
      const u = await controlDb.platformUser.findUnique({ where: { id: user.userId }, select: { email: true } });
      actor = { type: 'PLATFORM', id: user.userId, email: u?.email ?? null };
    } else if (user.tenantId) {
      const u = await (await dbForTenant(user.tenantId)).user.findFirst({ where: { id: user.userId, tenantId: user.tenantId }, select: { email: true } });
      actor = { type: 'USER', id: user.userId, email: u?.email ?? null };
    }
  }
  (request as unknown as { auditActor?: AuditActor }).auditActor = actor;
  return actor;
}

/** A platform user (or the system, without one) as an actor, for work done outside a request. */
export async function platformActor(userId?: string | null): Promise<AuditActor> {
  if (!userId) return { type: 'SYSTEM' };
  const u = await controlDb.platformUser.findUnique({ where: { id: userId }, select: { email: true } });
  return { type: 'PLATFORM', id: userId, email: u?.email ?? null };
}

export async function contextOf(request: FastifyRequest, actor?: AuditActor): Promise<AuditContext> {
  return {
    actor: actor ?? (await actorOf(request)),
    ip: request.ip,
    userAgent: (request.headers['user-agent'] as string | undefined)?.slice(0, 500) ?? null,
    requestId: request.id,
    tenantId: (request as { tenant?: { id?: string } }).tenant?.id ?? null,
  };
}

/**
 * Record an audit entry for a request. Tenant-scoped events go in the
 * request's tenant's log; platform-scoped ones in the platform's.
 */
export async function audit(
  request: FastifyRequest,
  event: string,
  input: AuditInput = {},
  /** Before there's a session (signing in): who, and which tenant's log */
  as?: { actor?: AuditActor; tenantId?: string | null },
): Promise<void> {
  try {
    const ctx = await contextOf(request, as?.actor);
    if (as && 'tenantId' in as) ctx.tenantId = as.tenantId ?? null;
    await recordAudit(ctx, event, input);
  } catch (err) {
    request.log.error({ err, event }, 'AUDIT ENTRY NOT RECORDED');
  }
}

/** Record an entry outside a request (background jobs, scripts). Throws for an unknown event or missing tenant. */
export async function recordAudit(ctx: AuditContext, event: string, input: AuditInput = {}): Promise<{ chain: string; seq: number; hash: string }> {
  // Whatever reacts to entries (notifications) registers its hooks when loaded
  extensionsLoaded ??= import('./notifications.js');
  await extensionsLoaded;
  const definition = auditCatalog()[event];
  if (!definition) throw new Error(`Unknown audit event "${event}": add it to src/kit/audit-events.ts or the product's auditEvents`);
  const chain = definition.scope === 'platform' ? PLATFORM_CHAIN : ctx.tenantId;
  if (!chain) throw new Error(`Audit event "${event}" belongs in a tenant's log, but there is no tenant`);

  const base = {
    occurredAt: new Date(),
    event,
    category: definition.category as AuditCategory,
    outcome: input.outcome ?? 'SUCCESS',
    actorType: ctx.actor.type,
    actorId: ctx.actor.id ?? null,
    actorEmail: ctx.actor.email ?? null,
    resourceType: input.resource?.type ?? null,
    resourceId: input.resource?.id ?? null,
    resourceLabel: input.resource?.label?.slice(0, 500) ?? null,
    changes: input.changes && Object.keys(input.changes).length ? (redact(input.changes) as object) : undefined,
    details: input.details ? (redact(input.details) as object) : undefined,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    requestId: ctx.requestId ?? null,
  };
  const keyVersion = activeAuditKeyVersion();
  // Platform entries name the tenant they concern; tenant entries are their tenant's
  const tenantField = chain === PLATFORM_CHAIN ? (input.tenantId ?? null) : chain;

  const write = async (last: { seq: number; hash: string } | null) => {
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS;
    const content = contentOf(chain, { ...base, id: '', tenantId: tenantField, seq, prevHash, hash: '', keyVersion } as StoredEntry);
    return { seq, prevHash, hash: hashEntry(prevHash, content, keyVersion), content };
  };

  let result: { seq: number; hash: string; content: Content };
  if (chain === PLATFORM_CHAIN) {
    result = await controlDb.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`audit:${chain}`}))::text`;
      const last = (await tx.platformAuditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true, hash: true } })) ?? (await archivedTail(chain));
      const next = await write(last);
      await tx.platformAuditEvent.create({ data: { ...base, tenantId: tenantField, seq: next.seq, prevHash: next.prevHash, hash: next.hash, keyVersion } });
      for (const hook of txHooks) await hook({ tx, chain, entry: next.content });
      return next;
    });
  } else {
    const db = await dbForTenant(chain);
    result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`audit:${chain}`}))::text`;
      const last =
        (await tx.auditEvent.findFirst({ where: { tenantId: chain }, orderBy: { seq: 'desc' }, select: { seq: true, hash: true } })) ??
        (await archivedTail(chain));
      const next = await write(last);
      await tx.auditEvent.create({ data: { ...base, tenantId: chain, seq: next.seq, prevHash: next.prevHash, hash: next.hash, keyVersion } });
      for (const hook of txHooks) await hook({ tx, chain, entry: next.content });
      return next;
    });
  }

  // The chain's head, kept apart from the chain itself
  await moveHead(chain, result.seq, result.hash).catch((err) => warn(`Audit head for ${chain} not updated`, err));
  for (const listener of listeners) {
    try {
      await listener({ chain, event, definition, entry: result.content });
    } catch (err) {
      warn(`Audit listener failed for ${event}`, err);
    }
  }
  return { chain, seq: result.seq, hash: result.hash };
}

/** The last archived entry of a chain whose live table is empty (all archived). */
async function archivedTail(chain: string): Promise<{ seq: number; hash: string } | null> {
  const a = await controlDb.auditArchive.findFirst({ where: { chain }, orderBy: { toSeq: 'desc' }, select: { toSeq: true, lastHash: true } });
  return a ? { seq: a.toSeq, hash: a.lastHash } : null;
}

async function moveHead(chain: string, seq: number, hash: string) {
  const moved = await controlDb.auditHead.updateMany({ where: { chain, seq: { lt: seq } }, data: { seq, hash } });
  if (moved.count === 0) {
    await controlDb.auditHead.create({ data: { chain, seq, hash } }).catch(() => {
      /* already there with a later entry */
    });
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface AuditFilter {
  event?: string;
  category?: string;
  outcome?: AuditOutcome;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  /** Platform log: entries concerning this tenant */
  tenantId?: string;
  from?: Date;
  to?: Date;
  /** Text in the actor's email, the record's name or the event key */
  q?: string;
  /** Entries before this sequence number (paging, newest first) */
  beforeSeq?: number;
}

function whereOf(f: AuditFilter) {
  return {
    ...(f.event && { event: f.event }),
    ...(f.category && { category: f.category }),
    ...(f.outcome && { outcome: f.outcome }),
    ...(f.actorId && { actorId: f.actorId }),
    ...(f.resourceType && { resourceType: f.resourceType }),
    ...(f.resourceId && { resourceId: f.resourceId }),
    ...((f.from || f.to) && { occurredAt: { ...(f.from && { gte: f.from }), ...(f.to && { lte: f.to }) } }),
    ...(f.beforeSeq && { seq: { lt: f.beforeSeq } }),
    ...(f.q && {
      OR: [
        { actorEmail: { contains: f.q, mode: 'insensitive' as const } },
        { resourceLabel: { contains: f.q, mode: 'insensitive' as const } },
        { event: { contains: f.q, mode: 'insensitive' as const } },
      ],
    }),
  };
}

/** Newest first. */
export async function listAudit(chain: string, filter: AuditFilter, limit: number): Promise<StoredEntry[]> {
  const take = Math.min(Math.max(limit, 1), 1000);
  if (chain === PLATFORM_CHAIN) {
    return (await controlDb.platformAuditEvent.findMany({
      where: { ...whereOf(filter), ...(filter.tenantId && { tenantId: filter.tenantId }) },
      orderBy: { seq: 'desc' },
      take,
    })) as unknown as StoredEntry[];
  }
  const db = await dbForTenant(chain);
  return (await db.auditEvent.findMany({ where: { tenantId: chain, ...whereOf(filter) }, orderBy: { seq: 'desc' }, take })) as unknown as StoredEntry[];
}

const CSV_COLUMNS = [
  'seq', 'occurredAt', 'event', 'category', 'outcome', 'actorType', 'actorEmail', 'actorId',
  'resourceType', 'resourceId', 'resourceLabel', 'changes', 'details', 'ip', 'userAgent', 'requestId', 'hash',
] as const;

const csvCell = (v: unknown) => {
  const s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Quote everything; neutralise spreadsheet formulas
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/** CSV of the matching entries, oldest first, in pages (for large exports). */
export async function* auditCsv(chain: string, filter: AuditFilter, max = 100_000): AsyncGenerator<string> {
  yield `${[...CSV_COLUMNS, ...(chain === PLATFORM_CHAIN ? ['tenantId'] : [])].join(',')}\n`;
  let afterSeq = 0;
  let sent = 0;
  for (;;) {
    const where = { ...whereOf({ ...filter, beforeSeq: undefined }), seq: { gt: afterSeq } };
    const rows = (chain === PLATFORM_CHAIN
      ? await controlDb.platformAuditEvent.findMany({ where: { ...where, ...(filter.tenantId && { tenantId: filter.tenantId }) }, orderBy: { seq: 'asc' }, take: 1000 })
      : await (await dbForTenant(chain)).auditEvent.findMany({ where: { tenantId: chain, ...where }, orderBy: { seq: 'asc' }, take: 1000 })) as unknown as StoredEntry[];
    if (rows.length === 0) return;
    let page = '';
    for (const r of rows) {
      const cells = CSV_COLUMNS.map((c) => csvCell((r as unknown as Record<string, unknown>)[c]));
      if (chain === PLATFORM_CHAIN) cells.push(csvCell(r.tenantId));
      page += `${cells.join(',')}\n`;
      if (++sent >= max) break;
    }
    yield page;
    if (sent >= max) return;
    afterSeq = rows.at(-1)!.seq;
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyReport {
  chain: string;
  ok: boolean;
  /** Live entries checked */
  entries: number;
  firstSeq: number | null;
  lastSeq: number | null;
  /** Archive files checked, and the entries in them */
  archives: number;
  archivedEntries: number;
  problems: { seq?: number; problem: string }[];
  verifiedAt: string;
}

/**
 * Walk a chain and check every link: sequence, previous hash and HMAC; then
 * the head kept in the control plane, and (with `archives`) the archive files
 * and how they join up.
 */
export async function verifyChain(chain: string, { archives = true } = {}): Promise<VerifyReport> {
  const problems: VerifyReport['problems'] = [];
  const add = (problem: string, seq?: number) => {
    if (problems.length < 100) problems.push(seq === undefined ? { problem } : { seq, problem });
  };
  const checkRow = (row: StoredEntry, expected: { seq: number; hash: string }) => {
    if (row.seq !== expected.seq + 1) add(`entries ${expected.seq + 1}–${row.seq - 1} are missing`, row.seq);
    if (row.prevHash !== expected.hash) add('does not follow the entry before it (previous hash differs)', row.seq);
    if (!config.auditKeys.has(row.keyVersion)) {
      add(`signed with AUDIT_KEY_V${row.keyVersion}, which is not configured`, row.seq);
      return;
    }
    if (hashEntry(row.prevHash, contentOf(chain, row), row.keyVersion) !== row.hash) add('content was changed after it was recorded', row.seq);
  };

  // Archived part first
  const manifests = await controlDb.auditArchive.findMany({ where: { chain }, orderBy: { fromSeq: 'asc' } });
  let expected = { seq: 0, hash: GENESIS };
  let archivedEntries = 0;
  for (const m of manifests) {
    if (m.fromSeq !== expected.seq + 1) add(`archive ${m.file} starts at ${m.fromSeq}, expected ${expected.seq + 1}`);
    if (m.firstPrevHash !== expected.hash && m.fromSeq === expected.seq + 1) add(`archive ${m.file} does not follow the entries before it`);
    if (archives) {
      const path = resolve(config.auditArchiveDir, m.file);
      const bytes = await readFile(path).catch(() => null);
      if (!bytes) add(`archive file ${m.file} is missing`);
      else if (crypto.createHash('sha256').update(bytes).digest('hex') !== m.sha256) add(`archive file ${m.file} was changed`);
      else {
        let e = { seq: m.fromSeq - 1, hash: m.firstPrevHash };
        for (const line of gunzipSync(bytes).toString('utf8').split('\n')) {
          if (!line) continue;
          const row = JSON.parse(line) as StoredEntry;
          checkRow(row, e);
          e = { seq: row.seq, hash: row.hash };
          archivedEntries++;
        }
        if (e.seq !== m.toSeq || e.hash !== m.lastHash) add(`archive file ${m.file} does not end where its record says`);
      }
    }
    expected = { seq: m.toSeq, hash: m.lastHash };
  }

  // Live entries, in pages
  let entries = 0;
  let firstSeq: number | null = null;
  const db = chain === PLATFORM_CHAIN ? null : await dbForTenant(chain);
  for (;;) {
    const rows = (db
      ? await db.auditEvent.findMany({ where: { tenantId: chain, seq: { gt: expected.seq } }, orderBy: { seq: 'asc' }, take: 1000 })
      : await controlDb.platformAuditEvent.findMany({ where: { seq: { gt: expected.seq } }, orderBy: { seq: 'asc' }, take: 1000 })) as unknown as StoredEntry[];
    if (rows.length === 0) break;
    for (const row of rows) {
      firstSeq ??= row.seq;
      checkRow(row, expected);
      expected = { seq: row.seq, hash: row.hash };
      entries++;
    }
  }

  // Nothing cut off the end
  const head = await controlDb.auditHead.findUnique({ where: { chain } });
  if (head) {
    if (head.seq > expected.seq) add(`entries ${expected.seq + 1}–${head.seq} are missing from the end`);
    else if (head.seq === expected.seq && head.hash !== expected.hash) add('the latest entry is not the one recorded', head.seq);
  }

  return {
    chain,
    ok: problems.length === 0,
    entries,
    firstSeq,
    lastSeq: entries ? expected.seq : null,
    archives: manifests.length,
    archivedEntries,
    problems,
    verifiedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Archiving
// ---------------------------------------------------------------------------

export interface ArchiveResult {
  chain: string;
  archived: number;
  file?: string;
  skipped?: string;
}

const chainDir = (chain: string) => (chain === PLATFORM_CHAIN ? 'platform' : `tenant-${chain}`);

/**
 * Move a chain's entries older than `before` to an archive file and remove
 * them from the live table. The newest entry always stays (it anchors the
 * next one), unless `everything` (a tenant about to be deleted).
 */
export async function archiveChain(chain: string, { before, everything = false }: { before: Date; everything?: boolean }): Promise<ArchiveResult> {
  return controlDb.$transaction(
    async (tx) => {
      // One archive run per chain at a time, across servers
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`audit-archive:${chain}`})) AS locked`;
      if (!locked) return { chain, archived: 0, skipped: 'another archive run is in progress' };

      // The platform role on the tenant's target: it may delete archived rows
      const tenantData = chain === PLATFORM_CHAIN ? null : platformDb(await targetForTenant(chain));
      const newest = tenantData
        ? await tenantData.auditEvent.findFirst({ where: { tenantId: chain }, orderBy: { seq: 'desc' }, select: { seq: true } })
        : await controlDb.platformAuditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true } });
      if (!newest) return { chain, archived: 0 };
      const where = { occurredAt: { lt: before }, ...(everything ? {} : { seq: { lt: newest.seq } }) };

      const read = async (afterSeq: number) =>
        (tenantData
          ? await tenantData.auditEvent.findMany({ where: { tenantId: chain, ...where, seq: { gt: afterSeq, ...(everything ? {} : { lt: newest.seq }) } }, orderBy: { seq: 'asc' }, take: 1000 })
          : await controlDb.platformAuditEvent.findMany({ where: { ...where, seq: { gt: afterSeq, ...(everything ? {} : { lt: newest.seq }) } }, orderBy: { seq: 'asc' }, take: 1000 })) as unknown as StoredEntry[];

      const first = (await read(0))[0];
      if (!first) return { chain, archived: 0 };

      // Entries must be archived in order, from the oldest kept
      const lastArchive = await tx.auditArchive.findFirst({ where: { chain }, orderBy: { toSeq: 'desc' } });
      if (lastArchive && first.seq !== lastArchive.toSeq + 1) {
        throw new Error(`Audit chain ${chain}: archive would start at ${first.seq}, but the last archive ended at ${lastArchive.toSeq}`);
      }

      const dir = resolve(config.auditArchiveDir, chainDir(chain));
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.writing-${crypto.randomUUID()}`);
      let count = 0;
      let last = first;
      async function* lines() {
        let after = first.seq - 1;
        for (;;) {
          const rows = await read(after);
          if (rows.length === 0) return;
          let chunk = '';
          for (const r of rows) {
            // A gap means entries were removed: archive up to it, not past it
            if (r.seq !== after + 1) throw new Error(`Audit chain ${chain}: entry ${after + 1} is missing; not archiving past it`);
            chunk += `${JSON.stringify(r)}\n`;
            last = r;
            after = r.seq;
            count++;
          }
          yield chunk;
        }
      }
      try {
        await pipeline(Readable.from(lines()), createGzip(), createWriteStream(tmp));
        const file = join(chainDir(chain), `${String(first.seq).padStart(10, '0')}-${String(last.seq).padStart(10, '0')}.jsonl.gz`);
        const finalPath = resolve(config.auditArchiveDir, file);
        await mkdir(dirname(finalPath), { recursive: true });
        await rename(tmp, finalPath);
        const bytes = await readFile(finalPath);
        await tx.auditArchive.create({
          data: {
            chain,
            tenantId: chain === PLATFORM_CHAIN ? null : chain,
            fromSeq: first.seq,
            toSeq: last.seq,
            fromAt: new Date(first.occurredAt),
            toAt: new Date(last.occurredAt),
            rows: count,
            firstPrevHash: first.prevHash,
            lastHash: last.hash,
            file,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            bytes: (await stat(finalPath)).size,
          },
        });
        const range = { seq: { gte: first.seq, lte: last.seq } };
        if (tenantData) await tenantData.auditEvent.deleteMany({ where: { tenantId: chain, ...range } });
        else await controlDb.platformAuditEvent.deleteMany({ where: range });
        return { chain, archived: count, file };
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    },
    { timeout: 10 * 60_000, maxWait: 30_000 },
  );
}

/** Archive every chain's entries older than the retention period, recording each run in that chain. */
export async function archiveExpired(now = new Date()): Promise<ArchiveResult[]> {
  const before = new Date(now.getTime() - config.auditRetentionDays * 86_400_000);
  const tenants = await controlDb.tenant.findMany({ where: { provisioningStatus: 'READY' }, select: { id: true } });
  const results: ArchiveResult[] = [];
  for (const chain of [PLATFORM_CHAIN, ...tenants.map((t) => t.id)]) {
    try {
      const r = await archiveChain(chain, { before });
      results.push(r);
      if (r.archived > 0) {
        await recordAudit(
          { actor: { type: 'SYSTEM' }, tenantId: chain === PLATFORM_CHAIN ? null : chain },
          chain === PLATFORM_CHAIN ? 'platform.audit.archived' : 'audit.archived',
          { details: { entries: r.archived, file: r.file, olderThan: before.toISOString() } },
        );
      }
    } catch (err) {
      results.push({ chain, archived: 0, skipped: (err as Error).message });
      warn(`Archiving the audit log of ${chain} failed`, err);
    }
  }
  return results;
}

let timer: NodeJS.Timeout | undefined;
export function startAuditArchiving(log: (msg: string, err?: unknown) => void) {
  setAuditLogger(log);
  if (!config.auditArchiveIntervalMs) return;
  const run = () => void archiveExpired().catch((err) => log('Audit archiving failed', err));
  timer = setInterval(run, config.auditArchiveIntervalMs);
  timer.unref();
  setTimeout(run, 60_000).unref();
}
export function stopAuditArchiving() {
  if (timer) clearInterval(timer);
}

/** Stream an archive file (for download). */
export function archiveStream(file: string) {
  const root = resolve(config.auditArchiveDir);
  const path = resolve(root, file);
  if (!path.startsWith(`${root}/`)) throw new Error('Invalid archive path');
  return createReadStream(path);
}
