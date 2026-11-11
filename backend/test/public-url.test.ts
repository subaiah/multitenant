/**
 * Public addresses are made canonical (config/env.ts publicUrl): a
 * PUBLIC_URL with a trailing slash made BFF_URL https://host//api, and the
 * OIDC issuer's path //api/oidc was read as another host in discovery
 * (https://api/oidc/auth).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('public addresses: no trailing slash, no repeated slashes in the path', async () => {
  const { publicUrl } = await import('../src/config/env.js');
  assert.equal(publicUrl('https://app-forge.duckdns.org//api'), 'https://app-forge.duckdns.org/api');
  assert.equal(publicUrl('https://app.example.com/'), 'https://app.example.com');
  assert.equal(publicUrl(' https://a.com/x//y/// '), 'https://a.com/x/y');
  assert.equal(publicUrl('http://localhost:4000'), 'http://localhost:4000');
});
