/**
 * The keys "Sign in with" signs ID tokens with (RS256). The first is made on
 * first use, under an advisory lock so servers starting together agree on one.
 * Private keys are encrypted at rest (lib/secrets.ts). Every key that isn't
 * retired is published (JWKS); the newest signs.
 */
import crypto from 'node:crypto';
import { controlDb } from '../prisma.js';
import { decryptSecret, secretContext } from '../secrets.js';

export type PrivateJwk = import('node:crypto').webcrypto.JsonWebKey & { kid: string; alg: string; use: string };

export async function signingKeys(): Promise<PrivateJwk[]> {
  let rows = await activeRows();
  if (rows.length === 0) {
    await controlDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('oidc_signing_keys'))`;
      if ((await tx.oidcSigningKey.count({ where: { retiredAt: null } })) > 0) return;
      const { id, jwk } = newKey();
      await tx.oidcSigningKey.create({ data: { id, privateJwk: JSON.stringify(jwk) } });
    });
    rows = await activeRows();
  }
  // Newest first: the provider signs with the first key that fits
  return rows.map((r) => JSON.parse(decryptSecret(r.privateJwk, secretContext('privateJwk'))) as PrivateJwk);
}

function activeRows() {
  return controlDb.oidcSigningKey.findMany({ where: { retiredAt: null }, orderBy: { createdAt: 'desc' } });
}

function newKey(): { id: string; jwk: PrivateJwk } {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const id = crypto.randomBytes(12).toString('base64url');
  return { id, jwk: { ...privateKey.export({ format: 'jwk' }), kid: id, alg: 'RS256', use: 'sig' } };
}
