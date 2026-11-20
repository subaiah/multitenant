/**
 * Rotating JWT_SECRET (lib/signing-keys.ts): with the old value in
 * JWT_SECRET_PREVIOUS, sessions signed with it still work and new ones use
 * the new secret; without it, they don't.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, api, loginSession, seedTenant, startExtraServer, startServer, stopServerAndCleanUp, type TenantSeed } from './helpers.js';
import { config } from '../src/config/env.js';
import { keyedHashes, matchesAny } from '../src/lib/signing-keys.js';

const OLD = process.env.JWT_SECRET!;
const NEW = 'rotated-jwt-secret-rotated-jwt-secret-5678';
let A: TenantSeed;

before(async () => {
  await startServer();
  A = await seedTenant('jwt-rotation');
});
after(stopServerAndCleanUp);

test('during a rotation, sessions under the previous secret still work and new ones use the new secret', async () => {
  const old = await loginSession(A.slug, A.adminEmail);
  const rotating = await startExtraServer({ JWT_SECRET: NEW, JWT_SECRET_PREVIOUS: OLD });
  const rotated = await startExtraServer({ JWT_SECRET: NEW });
  try {
    // Signed before the rotation: accepted while the previous secret is kept, by header or cookie
    assert.equal((await rotating.api('GET', '/bff/auth/me', { token: old.token })).status, 200);
    assert.equal((await rotating.api('GET', '/bff/auth/me', { cookie: old.cookie })).status, 200);
    // ...and refused once it's removed
    assert.equal((await rotated.api('GET', '/bff/auth/me', { token: old.token })).status, 401);

    // Signed after: the new secret, which the server without the previous one also takes
    const res = await rotating.api('POST', '/bff/auth/login', { body: { email: A.adminEmail, tenantSlug: A.slug, password: PASSWORD } });
    assert.equal(res.status, 200);
    const fresh = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('access_token='))!.slice('access_token='.length);
    assert.equal((await rotated.api('GET', '/bff/auth/me', { token: fresh })).status, 200);
    assert.equal((await api('GET', '/bff/auth/me', { token: fresh })).status, 401, 'a server on the old secret alone refuses it');
  } finally {
    await rotating.stop();
    await rotated.stop();
  }
});

test("a stored hash under the previous secret still matches, so products aren't told everyone changed", () => {
  const before = keyedHashes('product-member-state', 'ada@example.com', 'base64url');
  assert.equal(before.length, 1);
  // The settings are read-only to the app; the test swaps them in place
  const settings = config as { jwtSecret: string; jwtSecretPrevious?: string };
  const saved = { secret: settings.jwtSecret, previous: settings.jwtSecretPrevious };
  try {
    settings.jwtSecretPrevious = settings.jwtSecret;
    settings.jwtSecret = NEW;
    const now = keyedHashes('product-member-state', 'ada@example.com', 'base64url');
    assert.notEqual(now[0], before[0], 'new hashes use the new secret');
    assert.ok(matchesAny(before[0], now), 'the old hash still matches');
    assert.ok(!matchesAny(before[0], keyedHashes('product-member-state', 'grace@example.com', 'base64url')));
  } finally {
    settings.jwtSecret = saved.secret;
    settings.jwtSecretPrevious = saved.previous;
  }
});
