/**
 * Encrypt stored secrets that are still plain text, and re-encrypt values
 * written with an older key under the newest one (SECRETS_KEY_V<highest>).
 * Safe to run any number of times.
 *
 *   npm run secrets:encrypt            convert and re-key
 *   npm run secrets:encrypt -- --check report only; exits 1 if anything needs work
 *
 * Rotating a key: add SECRETS_KEY_V2 next to V1, deploy, run this script, then
 * remove V1 once `--check` reports nothing left on it.
 */
import { pathToFileURL } from 'node:url';
import { controlDb, disconnectDatabases } from '../lib/prisma.js';
import { listTargets } from '../lib/tenant-migrations.js';
import { describeTarget, platformDb } from '../lib/tenant-targets.js';
import { SECRET_FIELDS, activeKeyVersion, decryptSecret, isEncrypted, secretContext, secretKeyVersion, type SecretField } from '../lib/secrets.js';

type Delegate = { name: string; findMany: Function; update: Function };

// Prisma delegates holding each secret field: connection strings, platform
// users' two-factor secrets and "Sign in with" secrets and keys in the control
// plane; the rest in every ready tenant target (as the platform role, which
// sees every tenant's rows)
const CONTROL_FIELDS = new Set<SecretField>(['connectionString', 'platformTotpSecret', 'oidcClientSecret', 'privateJwk']);

async function delegatesFor(field: SecretField): Promise<Delegate[]> {
  if (field === 'connectionString') return [{ name: 'control plane', ...bind(controlDb.databaseConfig) }];
  if (field === 'platformTotpSecret') return [{ name: 'control plane', ...bind(controlDb.platformUser) }];
  if (field === 'oidcClientSecret') return [{ name: 'control plane', ...bind(controlDb.applicationSignIn) }];
  if (field === 'privateJwk') return [{ name: 'control plane', ...bind(controlDb.oidcSigningKey) }];
  return (await listTargets(['READY'])).map(({ target }) => {
    const db = platformDb(target);
    const delegate = field === 'totpSecret' ? db.user : field === 'signingSecret' ? db.webhookEndpoint : db.authProvider;
    return { name: describeTarget(target), ...bind(delegate) };
  });
}

function bind(delegate: { findMany: Function; update: Function }) {
  return { findMany: delegate.findMany.bind(delegate), update: delegate.update.bind(delegate) };
}

/** `only` limits the run to the given row ids per field (used by tests, which share a database). */
export async function encryptStoredSecrets({ check = false, only }: { check?: boolean; only?: Partial<Record<SecretField, string[]>> } = {}) {
  const active = activeKeyVersion();
  const report: Record<string, { plain: number; oldKey: number; current: number; fixed: number }> = {};
  // Targets that couldn't be read (e.g. a tenant deleted during the run); run again later
  const skipped: string[] = [];

  for (const field of Object.keys(SECRET_FIELDS) as SecretField[]) {
    const counts = { plain: 0, oldKey: 0, current: 0, fixed: 0 };
    for (const delegate of await delegatesFor(field)) {
      let rows: { id: string; [k: string]: string | null }[];
      try {
        rows = await delegate.findMany({
          // Not '' rather than not null: some secret columns can't be null
          where: { [field]: { not: '' }, ...(only && { id: { in: only[field] ?? [] } }) },
          select: { id: true, [field]: true },
        });
      } catch (err) {
        if (CONTROL_FIELDS.has(field)) throw err;
        skipped.push(`${delegate.name}: ${(err as Error).message.split('\n').at(-1)}`);
        continue;
      }
      for (const row of rows) {
        const value = row[field];
        if (!value) continue;
        const version = secretKeyVersion(value);
        if (!isEncrypted(value)) counts.plain++;
        else if (version !== active) counts.oldKey++;
        else {
          counts.current++;
          continue;
        }
        if (check) continue;
        // Writing the plaintext back lets the Prisma extension encrypt it with the active key
        const plaintext = decryptSecret(value, secretContext(field));
        await delegate.update({ where: { id: row.id }, data: { [field]: plaintext } });
        counts.fixed++;
      }
    }
    report[`${SECRET_FIELDS[field].table}.${SECRET_FIELDS[field].column}`] = counts;
  }
  return { activeKey: `v${active}`, report, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  encryptStoredSecrets({ check })
    .then(({ activeKey, report, skipped }) => {
      console.log(`Active key: ${activeKey}${check ? ' (check only, nothing changed)' : ''}`);
      let pending = 0;
      for (const [column, c] of Object.entries(report)) {
        console.log(`  ${column}: ${c.current} current, ${c.plain} plain text, ${c.oldKey} on an older key${check ? '' : `, ${c.fixed} fixed`}`);
        pending += c.plain + c.oldKey - c.fixed;
      }
      for (const s of skipped) console.log(`  skipped ${s}`);
      process.exitCode = (check && pending > 0) || skipped.length > 0 ? 1 : 0;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await disconnectDatabases();
    });
}
