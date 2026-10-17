/**
 * An organization's data, exported: a ZIP with one CSV file per tenant table,
 * a manifest.json (tables, columns, row counts) and a README.txt.
 *
 * - Read as the tenant's own database role, inside one read-only, repeatable-
 *   read transaction: row-level security applies, and every table is from the
 *   same moment. Rows stream through a cursor, so size isn't limited by memory.
 * - Every tenant table is included, the product's too, except secrets and
 *   short-lived machinery: sign-in tokens and codes, password hashes, 2FA
 *   secrets, SSO client secrets (and what the product excludes, kit/product.ts).
 * - Files go in EXPORT_DIR/<tenant>/<export>.zip and can be downloaded for
 *   EXPORT_RETENTION_DAYS; the lifecycle job removes them after that.
 */
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { config } from '../config/env.js';
import { controlDb } from './prisma.js';
import { tenantConnection } from './tenant-db.js';
import { tenantTables } from './tenant-migrations.js';
import { ZipWriter } from './zip.js';
import { sendMail } from './mailer.js';
import { dataExportReadyEmail } from './email-templates.js';
import { appOriginForTenant } from './domains.js';
import { product } from '../product/index.js';

/** Never exported: secrets and short-lived sign-in machinery */
const KIT_EXCLUDED_TABLES = ['refresh_tokens', 'user_tokens', 'otp_codes', 'oauth_sessions', 'notification_outbox'];
const KIT_EXCLUDED_COLUMNS: Record<string, string[]> = {
  users: ['password_hash', 'totp_secret', 'mfa_recovery_codes'],
  auth_providers: ['client_secret'],
};

function exclusions() {
  const extra = product.exportExclusions ?? {};
  const columns: Record<string, string[]> = { ...KIT_EXCLUDED_COLUMNS };
  for (const [table, cols] of Object.entries(extra.columns ?? {})) columns[table] = [...(columns[table] ?? []), ...cols];
  return { tables: new Set([...KIT_EXCLUDED_TABLES, ...(extra.tables ?? [])]), columns };
}

export const exportDir = (tenantId: string) => join(resolve(config.exportDir), tenantId);
export const exportFile = (e: { id: string; tenantId: string }) => join(exportDir(e.tenantId), `${e.id}.zip`);

/** Timestamps as stored (UTC), not shifted to the server's time zone */
const types = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') => {
    if (oid === 1114) return (v: string) => `${v.replace(' ', 'T')}Z`; // timestamp: Prisma stores UTC
    if (oid === 1184) return (v: string) => new Date(v).toISOString(); // timestamptz
    if (oid === 1082) return (v: string) => v; // date
    return pg.types.getTypeParser(oid, format as 'text');
  },
};

const NUMBER = /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/** One CSV value. Text starting like a formula gets a leading ' so spreadsheets show it instead of running it. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (Buffer.isBuffer(v)) s = v.toString('base64');
  else if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

interface TableSummary { table: string; file: string; rows: number; columns: string[]; omittedColumns: string[] }

async function writeExport(tenantId: string, path: string): Promise<{ tables: TableSummary[]; omittedTables: string[] }> {
  const tenant = await controlDb.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, slug: true } });
  const { url, schema } = await tenantConnection(tenantId);
  const excluded = exclusions();
  const c = new pg.Client({ connectionString: url, types });
  c.on('error', () => {});
  await c.connect();
  const zip = new ZipWriter(path);
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const all = await tenantTables(c, schema);
    const tables: TableSummary[] = [];
    const tenantLiteral = c.escapeLiteral(tenantId);
    for (const table of all.filter((t) => !excluded.tables.has(t))) {
      const { rows: cols } = await c.query<{ attname: string }>(
        `SELECT a.attname FROM pg_attribute a
           JOIN pg_class r ON r.oid = a.attrelid JOIN pg_namespace n ON n.oid = r.relnamespace
          WHERE n.nspname = $1 AND r.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [schema, table],
      );
      const omit = excluded.columns[table] ?? [];
      const columns = cols.map((r) => r.attname).filter((n) => !omit.includes(n));
      const summary: TableSummary = { table, file: `${table}.csv`, rows: 0, columns, omittedColumns: omit.filter((o) => cols.some((r) => r.attname === o)) };
      const cursor = ident(`export_${tables.length}`);
      async function* csv() {
        // A byte-order mark, so spreadsheet apps read the file as UTF-8
        yield `﻿${columns.map(csvCell).join(',')}\r\n`;
        await c.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${columns.map(ident).join(', ')} FROM ${ident(schema)}.${ident(table)} WHERE tenant_id = ${tenantLiteral} ORDER BY 1`);
        for (;;) {
          const { rows } = await c.query({ text: `FETCH 1000 FROM ${cursor}`, rowMode: 'array' });
          if (!rows.length) break;
          summary.rows += rows.length;
          yield rows.map((r: unknown[]) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
        }
        await c.query(`CLOSE ${cursor}`);
      }
      await zip.addFile(`${table}.csv`, csv());
      tables.push(summary);
    }
    await c.query('COMMIT');

    const omittedTables = all.filter((t) => excluded.tables.has(t));
    const exportedAt = new Date().toISOString();
    await zip.addFile('manifest.json', [JSON.stringify({ organization: tenant.name, address: tenant.slug, exportedAt, format: 'CSV (UTF-8, comma-separated, RFC 4180)', tables, omittedTables }, null, 2)]);
    await zip.addFile('README.txt', [readme(tenant.name, exportedAt, tables, omittedTables)]);
    await zip.close();
    return { tables, omittedTables };
  } catch (err) {
    zip.abort();
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await c.end().catch(() => {});
  }
}

function readme(name: string, at: string, tables: TableSummary[], omitted: string[]) {
  return [
    `Data export of ${name}, taken at ${at} (UTC).`,
    '',
    'One CSV file per table: UTF-8, comma-separated, a header row with the column names.',
    'Times are in UTC (ISO 8601). Lists and structured values are written as JSON.',
    "Text that starts with = + - or @ has a ' in front, so spreadsheet apps show it instead of running it as a formula.",
    'Tables refer to each other by id (for example user_id in group_memberships is an id in users.csv).',
    '',
    'Left out on purpose: password hashes, two-factor secrets and recovery codes, single sign-on client secrets,',
    `and short-lived sign-in records (${omitted.join(', ') || 'none'}). manifest.json lists every file, its columns and row count.`,
    '',
    ...tables.map((t) => `${t.file.padEnd(36)} ${t.rows} rows`),
    '',
  ].join('\r\n');
}

/** Build an export that's PENDING. Safe to call from several servers: one claims it. */
export async function runExport(exportId: string): Promise<void> {
  const claimed = await controlDb.dataExport.updateMany({ where: { id: exportId, status: 'PENDING' }, data: { status: 'RUNNING', startedAt: new Date(), error: null } });
  if (!claimed.count) return;
  const e = await controlDb.dataExport.findUniqueOrThrow({ where: { id: exportId } });
  const final = exportFile(e);
  const part = `${final}.part`;
  try {
    await mkdir(exportDir(e.tenantId), { recursive: true });
    const { tables } = await writeExport(e.tenantId, part);
    await rename(part, final);
    const size = (await stat(final)).size;
    const expiresAt = new Date(Date.now() + config.exportRetentionDays * 86_400_000);
    await controlDb.dataExport.update({
      where: { id: e.id },
      data: { status: 'READY', sizeBytes: BigInt(size), tables: tables.map(({ table, rows }) => ({ table, rows })), finishedAt: new Date(), expiresAt },
    });
    if (e.requestedBy) {
      const tenant = await controlDb.tenant.findUnique({ where: { id: e.tenantId }, select: { name: true } });
      const link = `${await appOriginForTenant(e.tenantId)}/settings#data-export`;
      await sendMail(dataExportReadyEmail(e.requestedBy, tenant?.name ?? 'Your organization', link, expiresAt)).catch(() => {});
    }
  } catch (err) {
    await rm(part, { force: true }).catch(() => {});
    await controlDb.dataExport.update({ where: { id: e.id }, data: { status: 'FAILED', error: (err as Error).message.slice(0, 500), finishedAt: new Date() } }).catch(() => {});
  }
}

/**
 * For the lifecycle job: build exports nobody started (a server restarted
 * after taking the request) or that stopped part-way, and remove expired ones.
 */
export async function maintainExports(now = new Date()): Promise<{ resumed: number; removed: number }> {
  const stale = await controlDb.dataExport.findMany({
    where: {
      OR: [
        { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - 2 * 60_000) } },
        { status: 'RUNNING', startedAt: { lt: new Date(now.getTime() - 2 * 3_600_000) } },
      ],
    },
    select: { id: true, status: true },
  });
  for (const s of stale) {
    if (s.status === 'RUNNING') await controlDb.dataExport.updateMany({ where: { id: s.id, status: 'RUNNING' }, data: { status: 'PENDING' } });
    await runExport(s.id);
  }
  const old = await controlDb.dataExport.findMany({
    where: { OR: [{ status: 'READY', expiresAt: { lt: now } }, { status: 'FAILED', createdAt: { lt: new Date(now.getTime() - 30 * 86_400_000) } }] },
    select: { id: true, tenantId: true },
  });
  for (const e of old) {
    await rm(exportFile(e), { force: true }).catch(() => {});
    await controlDb.dataExport.delete({ where: { id: e.id } }).catch(() => {});
  }
  return { resumed: stale.length, removed: old.length };
}

/** When a tenant is deleted: its export files and records */
export async function removeTenantExports(tenantId: string) {
  await rm(exportDir(tenantId), { recursive: true, force: true }).catch(() => {});
  await controlDb.dataExport.deleteMany({ where: { tenantId } });
}
