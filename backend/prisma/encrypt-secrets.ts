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
import { controlDb, tenantDb, disconnectDatabases } from '../src/lib/prisma.js';
import { SECRET_FIELDS, activeKeyVersion, decryptSecret, isEncrypted, secretContext, secretKeyVersion, type SecretField } from '../src/lib/secrets.js';

// Prisma delegate for each secret field's model. SSO secrets are tenant data:
// this covers the shared tenant database; tenants with their own schema or
// database are covered when those modes land (the tenant migration runner).
const delegates: Record<SecretField, { findMany: Function; update: Function }> = {
  connectionString: controlDb.databaseConfig,
  clientSecret: tenantDb.authProvider,
};

/** `only` limits the run to the given row ids per field (used by tests, which share a database). */
export async function encryptStoredSecrets({ check = false, only }: { check?: boolean; only?: Partial<Record<SecretField, string[]>> } = {}) {
  const active = activeKeyVersion();
  const report: Record<string, { plain: number; oldKey: number; current: number; fixed: number }> = {};

  for (const field of Object.keys(SECRET_FIELDS) as SecretField[]) {
    const counts = { plain: 0, oldKey: 0, current: 0, fixed: 0 };
    const rows: { id: string; [k: string]: string | null }[] = await delegates[field].findMany({
      where: { [field]: { not: null }, ...(only && { id: { in: only[field] ?? [] } }) },
      select: { id: true, [field]: true },
    });
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
      await delegates[field].update({ where: { id: row.id }, data: { [field]: plaintext } });
      counts.fixed++;
    }
    report[`${SECRET_FIELDS[field].table}.${SECRET_FIELDS[field].column}`] = counts;
  }
  return { activeKey: `v${active}`, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  encryptStoredSecrets({ check })
    .then(({ activeKey, report }) => {
      console.log(`Active key: ${activeKey}${check ? ' (check only, nothing changed)' : ''}`);
      let pending = 0;
      for (const [column, c] of Object.entries(report)) {
        console.log(`  ${column}: ${c.current} current, ${c.plain} plain text, ${c.oldKey} on an older key${check ? '' : `, ${c.fixed} fixed`}`);
        pending += c.plain + c.oldKey - c.fixed;
      }
      process.exitCode = check && pending > 0 ? 1 : 0;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await disconnectDatabases();
    });
}
