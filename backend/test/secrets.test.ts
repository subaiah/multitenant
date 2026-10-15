/**
 * Stored secrets (tenant connection strings, SSO client secrets) are
 * encrypted at rest, on every write path, and the encrypt/re-key script
 * converts existing rows safely.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, db, loginSession, seedTenant, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';
import {
  SECRET_FIELDS, SecretDecryptionError, activeKeyVersion, decryptSecret, encryptSecret, isEncrypted, secretKeyVersion,
} from '../src/lib/secrets.js';
import { config } from '../src/config/env.js';

let A: TenantSeed;
let prisma: Awaited<ReturnType<typeof db>>['prisma'];
const key = () => crypto.randomBytes(32);
const CONN = 'database_configs.connection_string';
const SSO = 'auth_providers.client_secret';

/** Read a column straight from Postgres, bypassing the Prisma client and its extension. */
async function raw(table: string, column: string, id: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<{ v: string | null }[]>(`SELECT ${column} AS v FROM ${table} WHERE id = $1`, id);
  return rows[0]?.v ?? null;
}

before(async () => {
  ({ prisma } = await db());
  A = await seedTenant('sec');
  await prisma.databaseConfig.create({
    data: { tenantId: A.tenantId, strategy: 'SHARED_TABLES', provider: 'POSTGRESQL', region: 'ap-south-1', storageLimit: '10GB', tenantColumn: 'tenant_id' },
  });
  await startServer();
});

after(stopServerAndCleanUp);

test('encrypt and decrypt: round trip, random IV, tamper and context checks', () => {
  const a = encryptSecret('postgres://u:p@h/db', CONN);
  const b = encryptSecret('postgres://u:p@h/db', CONN);
  assert.match(a, /^enc:v\d+:/);
  assert.notEqual(a, b, 'a fresh IV each time');
  assert.ok(!a.includes('postgres'));
  assert.equal(decryptSecret(a, CONN), 'postgres://u:p@h/db');

  const parts = a.split(':');
  const flipped = parts[3].startsWith('A') ? `B${parts[3].slice(1)}` : `A${parts[3].slice(1)}`;
  const tampered = [...parts.slice(0, 3), flipped, parts[4]].join(':');
  assert.throws(() => decryptSecret(tampered, CONN), SecretDecryptionError);
  assert.throws(() => decryptSecret(a, SSO), SecretDecryptionError, 'bound to its column');
  try {
    decryptSecret(tampered, CONN);
  } catch (err) {
    assert.ok(!(err as Error).message.includes('postgres'), 'errors never contain the value');
  }

  assert.equal(decryptSecret('plain-old-value', CONN), 'plain-old-value', 'values from before encryption still read');
  assert.equal(isEncrypted('enc: not really'), false, 'only the exact format counts as encrypted');
});

test('key rotation: newest key encrypts, older keys still decrypt, missing keys are named', () => {
  const v1 = new Map([[1, key()]]);
  const v1v2 = new Map([[1, v1.get(1)!], [2, key()]]);
  const old = encryptSecret('s3cret', SSO, v1);
  assert.equal(secretKeyVersion(old), 1);
  const fresh = encryptSecret('s3cret', SSO, v1v2);
  assert.equal(secretKeyVersion(fresh), 2);
  assert.equal(decryptSecret(old, SSO, v1v2), 's3cret');
  assert.throws(() => decryptSecret(fresh, SSO, v1), /SECRETS_KEY_V2/);
  assert.throws(() => decryptSecret(old, SSO, new Map([[1, key()]])), /wrong key/);
});

test('SECRET_FIELDS matches the schema: each field belongs to one model and the right column', () => {
  const schema = readFileSync(join(import.meta.dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
  for (const [field, where] of Object.entries(SECRET_FIELDS)) {
    const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].filter((m) => new RegExp(`^\\s+${field}\\s`, 'm').test(m[2]));
    assert.deepEqual(models.map((m) => m[1]), [where.model], `${field} is only on ${where.model}`);
    assert.match(models[0][2], new RegExp(`${field}\\s.*@map\\("${where.column}"\\)`));
    assert.match(models[0][2], new RegExp(`@@map\\("${where.table}"\\)`));
  }
});

test('saving a connection string through the API stores it encrypted and never returns it', async () => {
  const { cookie } = await loginSession(A.slug, A.adminEmail);
  const conn = 'postgresql://tenant:hunter2@db.internal:5432/acme';
  const res = await api('PATCH', '/database', { cookie, body: { strategy: 'DATABASE_PER_TENANT', connectionString: conn } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.hasConnectionString, true);
  assert.ok(!JSON.stringify(res.json).includes('hunter2'));
  assert.ok(!JSON.stringify((await api('GET', '/database', { cookie })).json).includes('hunter2'));

  const cfg = await prisma.databaseConfig.findUniqueOrThrow({ where: { tenantId: A.tenantId } });
  const stored = await raw('database_configs', 'connection_string', cfg.id);
  assert.ok(stored && isEncrypted(stored), 'encrypted in the database');
  assert.ok(!stored!.includes('hunter2'));
  assert.equal(decryptSecret(stored!, CONN), conn);

  // A save that doesn't resend it keeps it
  assert.equal((await api('PATCH', '/database', { cookie, body: { backupEnabled: true } })).status, 200);
  assert.equal(decryptSecret((await raw('database_configs', 'connection_string', cfg.id))!, CONN), conn);
});

test('every write path encrypts: nested creates, upsert, updateMany with { set }', async () => {
  const authConfig = await prisma.authConfig.findUniqueOrThrow({ where: { tenantId: A.tenantId } });
  // Nested relation write
  const updated = await prisma.authConfig.update({
    where: { id: authConfig.id },
    data: { providers: { create: { provider: 'GITHUB', clientId: 'gh', clientSecret: 'gh-nested-secret', scopes: [] } } },
    include: { providers: true },
  });
  const gh = updated.providers.find((p) => p.provider === 'GITHUB')!;
  assert.equal(decryptSecret((await raw('auth_providers', 'client_secret', gh.id))!, SSO), 'gh-nested-secret');

  // updateMany with the { set } form
  await prisma.authProvider.updateMany({ where: { id: gh.id }, data: { clientSecret: { set: 'gh-set-secret' } } });
  const viaSet = await raw('auth_providers', 'client_secret', gh.id);
  assert.ok(isEncrypted(viaSet!));
  assert.equal(decryptSecret(viaSet!, SSO), 'gh-set-secret');

  // upsert (update branch)
  await prisma.authProvider.upsert({
    where: { id: gh.id },
    create: { authConfigId: authConfig.id, provider: 'GITHUB', clientSecret: 'never-used', scopes: [] },
    update: { clientSecret: 'gh-upsert-secret' },
  });
  assert.equal(decryptSecret((await raw('auth_providers', 'client_secret', gh.id))!, SSO), 'gh-upsert-secret');

  // The seeded provider (test helper writes through Prisma) is encrypted too
  const seeded = await raw('auth_providers', 'client_secret', A.providerId);
  assert.ok(isEncrypted(seeded!));
  assert.equal(decryptSecret(seeded!, SSO), 'TOP-SECRET');
});

test('the encrypt script converts plain text, re-keys old values, and is safe to rerun', async () => {
  const { encryptStoredSecrets } = await import('../prisma/encrypt-secrets.js');
  const authConfig = await prisma.authConfig.findUniqueOrThrow({ where: { tenantId: A.tenantId } });
  const p = await prisma.authProvider.create({ data: { authConfigId: authConfig.id, provider: 'AUTH0', clientId: 'a0', scopes: [] } });
  // Plain text written before encryption existed (bypassing the extension)
  await prisma.$executeRawUnsafe(`UPDATE auth_providers SET client_secret = $1 WHERE id = $2`, 'legacy-plain', p.id);
  const only = { clientSecret: [p.id] };

  const check = await encryptStoredSecrets({ check: true, only });
  assert.equal(check.report[SSO].plain, 1);
  assert.equal(await raw('auth_providers', 'client_secret', p.id), 'legacy-plain', '--check changes nothing');

  const run = await encryptStoredSecrets({ only });
  assert.equal(run.report[SSO].fixed, 1);
  const enc = await raw('auth_providers', 'client_secret', p.id);
  assert.equal(decryptSecret(enc!, SSO), 'legacy-plain');

  const again = await encryptStoredSecrets({ only });
  assert.deepEqual(again.report[SSO], { plain: 0, oldKey: 0, current: 1, fixed: 0 }, 'second run does nothing');
  assert.equal(await raw('auth_providers', 'client_secret', p.id), enc, 'value untouched');

  // Rotation: add a v2 key in this process, re-key, and the value moves to v2
  const before = activeKeyVersion();
  config.secretKeys.set(before + 1, key());
  try {
    const rekey = await encryptStoredSecrets({ only });
    assert.equal(rekey.report[SSO].oldKey, 1);
    const rekeyed = await raw('auth_providers', 'client_secret', p.id);
    assert.equal(secretKeyVersion(rekeyed!), before + 1);
    assert.equal(decryptSecret(rekeyed!, SSO), 'legacy-plain');
  } finally {
    config.secretKeys.delete(before + 1);
    await prisma.authProvider.delete({ where: { id: p.id } });
  }
});

test('production refuses to start without a valid key', () => {
  const run = (extra: Record<string, string>) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
      JWT_SECRET: 'x'.repeat(40),
      COOKIE_SECRET: 'y'.repeat(40),
      ...extra,
    };
    return spawnSync(process.execPath, ['--import', 'tsx', '-e', "await import('./src/config/env.ts')"], { env, encoding: 'utf8' });
  };
  const missing = run({});
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SECRETS_KEY_V1 is required in production/);

  const short = run({ SECRETS_KEY_V1: Buffer.alloc(16).toString('base64') });
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /must be 32 bytes/);

  const ok = run({ SECRETS_KEY_V1: key().toString('base64') });
  assert.equal(ok.status, 0, ok.stderr);
});
