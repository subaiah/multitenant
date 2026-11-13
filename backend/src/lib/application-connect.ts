/**
 * Connecting an application in one step (docs/hub/CONNECT.md).
 *
 * Registering an application used to end with platform staff copying its
 * secrets into the application's own configuration. Here nobody sees them:
 *
 *  1. The application sends a platform administrator's browser to the
 *     platform's Connect page with its address, where to come back to, and a
 *     PKCE challenge.
 *  2. The platform reads the application's manifest from that address
 *     (/.well-known/hub-manifest.json), shows what it asks for, and the
 *     administrator approves.
 *  3. Approving imports the manifest, makes the application's credentials and
 *     keeps them, encrypted, behind a one-time code. The browser goes back to
 *     the application with the code.
 *  4. The application's server exchanges the code and the PKCE verifier for
 *     the credentials. They are handed over once.
 *
 * Why it can be trusted:
 * - The manifest is read from a fixed path at the application's own address,
 *   its baseUrl must be that address, and the code is only ever sent back to
 *   that address: whoever connects an application controls its site.
 * - The code alone is not enough. Collecting needs the verifier, which never
 *   left the application's server.
 * - A code works once, for ten minutes.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env.js';
import { AppError } from '../middleware/error-handler.js';
import { withPlatformAudit } from './audit.js';
import { issuer } from './oidc/provider.js';
import { newClientSecret } from './oidc/uris.js';
import { controlDb } from './prisma.js';
import { ROTATION_OVERLAP_MS, callbackUrlProblem, newCallbackSecret, trustedCallback } from './product-lifecycle.js';
import { importManifest, manifestProblems, manifestSchema, type ImportResult, type ProductManifest } from './product-manifest.js';
import { API_RESOURCE, newServiceClientId, newServiceSecret } from './product-service.js';
import { decryptSecret, secretContext } from './secrets.js';
import { SERVICE_SCOPES, isServiceScope, type ServiceScope } from './service-scopes.js';
import { isPrivateAddress } from './webhooks.js';

/** Where an application publishes its manifest */
export const MANIFEST_PATH = '/.well-known/hub-manifest.json';
/** How long an approved request can be collected */
export const GRANT_TTL_MS = 10 * 60_000;
/** The service credential a connection makes (and replaces when the application connects again) */
export const CONNECT_CREDENTIAL_NAME = 'Connection';
const MANIFEST_MAX_BYTES = 256 * 1024;
const MANIFEST_TIMEOUT_MS = 5000;

export const connectRequestSchema = z.object({
  /** The application's address: scheme and host (and port), nothing after */
  appUrl: z.string().max(500),
  /** Where the browser goes back to, on the same address */
  redirectUri: z.string().max(2000),
  /** Returned unchanged, so the application can tell its own request */
  state: z.string().max(500).optional(),
  /** PKCE, S256: base64url(sha256(verifier)) */
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'A PKCE S256 challenge (43 characters)'),
  /** What the application's server may call the platform for */
  scopes: z.array(z.string()).max(20).default([]).refine((list) => list.every(isServiceScope), `Scopes: ${Object.keys(SERVICE_SCOPES).join(', ')}`),
  confirmClientTypeChange: z.boolean().optional(),
  /** On approval: the manifestHash the check reported, so what is approved is what was shown */
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type ConnectRequest = z.infer<typeof connectRequestSchema>;

/** What an application collects. Secrets appear here and nowhere else. */
export interface ConnectCredentials {
  platform: { url: string; apiUrl: string };
  application: { id: string; productId: string; name: string };
  signIn: { issuer: string; discoveryUrl: string; clientId: string; clientSecret?: string };
  /** Signs the lifecycle and user events sent to the application's callback address */
  events?: { signingSecret: string };
  /** For calling the platform as the application (client credentials) */
  service?: { tokenUrl: string; resource: string; clientId: string; clientSecret: string; scopes: string[] };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const refuse = (message: string, status = 400, code = 'CONNECT_REFUSED') => new AppError(message, status, true, code);

/** The application's origin and return address, checked against each other */
function addressesOf(request: Pick<ConnectRequest, 'appUrl' | 'redirectUri'>): { origin: string; redirect: URL } {
  const problem = callbackUrlProblem(request.appUrl);
  if (problem) throw refuse(`The application's address can't be used: ${problem}`);
  const app = new URL(request.appUrl);
  if ((app.pathname !== '/' && app.pathname !== '') || app.search) throw refuse("Give the application's address without a path: https://app.example.com");
  let redirect: URL;
  try {
    redirect = new URL(request.redirectUri);
  } catch {
    throw refuse('The return address is not a valid URL');
  }
  if (redirect.origin !== app.origin) throw refuse("The return address must be on the application's own address");
  if (redirect.hash) throw refuse('Leave the #fragment out of the return address');
  return { origin: app.origin, redirect };
}

/** In production, an address that isn't on the operator's list must resolve to public addresses only */
async function assertReachableFromOutside(origin: string): Promise<void> {
  if (trustedCallback(origin)) return;
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw refuse(`${host} does not resolve`);
  if (addresses.some(isPrivateAddress)) throw refuse('That is an inside address: add the host to PRODUCT_CALLBACK_ALLOWED_HOSTS to allow it');
}

/** Read and check the manifest the application publishes at its own address */
export async function fetchManifest(origin: string): Promise<{ manifest: ProductManifest; hash: string }> {
  await assertReachableFromOutside(origin);
  const url = `${origin}${MANIFEST_PATH}`;
  let text: string;
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'Multitenant-Connect/1' },
      // The manifest must be at this address itself, not wherever it points
      redirect: 'error',
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > MANIFEST_MAX_BYTES) throw new Error('too large');
    text = await res.text();
    if (text.length > MANIFEST_MAX_BYTES) throw new Error('too large');
  } catch (err) {
    throw refuse(`Could not read the application's manifest at ${url} (${(err as Error).message})`);
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw refuse(`${url} is not JSON`);
  }
  const problems = manifestProblems(input);
  if (problems) throw new AppError(`The manifest at ${url} has problems: ${problems.join('; ')}`, 400, true, 'MANIFEST_INVALID');
  const manifest = manifestSchema.parse(input);
  // Whoever publishes a manifest speaks for the address it is published at, and no other
  if (new URL(manifest.baseUrl).origin !== origin) {
    throw refuse(`The manifest's baseUrl (${manifest.baseUrl}) is not the address it was read from (${origin})`);
  }
  return { manifest, hash: sha256(text).toString('hex') };
}

/** What the Connect page shows before anything is saved */
export async function checkConnect(input: ConnectRequest) {
  const { origin } = addressesOf(input);
  const { manifest, hash } = await fetchManifest(origin);
  const existing = await controlDb.applicationRegistry.findUnique({
    where: { key: manifest.productId },
    select: { id: true, baseUrl: true, provisioningCallbackUrl: true, signIn: { select: { clientType: true } } },
  });
  const plan = await importManifest(manifest, { dryRun: true, confirmClientTypeChange: true });
  const confidential = manifest.signIn.clientType !== 'PUBLIC';
  return {
    application: {
      productId: manifest.productId,
      name: manifest.name,
      description: manifest.description ?? null,
      version: manifest.version,
      baseUrl: manifest.baseUrl,
      kind: manifest.manifestVersion === 2 ? manifest.kind : null,
    },
    /** Already in the catalogue: connecting again replaces its secrets */
    reconnect: !!existing,
    /** Registered before at another address: worth a second look */
    addressChanged: !!existing?.baseUrl && new URL(existing.baseUrl).origin !== origin,
    clientTypeChange: !!existing?.signIn && (existing.signIn.clientType !== 'PUBLIC') !== confidential,
    signIn: { redirectUris: manifest.signIn.redirectUris, clientType: manifest.signIn.clientType },
    callbackUrl: manifest.provisioning?.callbackUrl ?? null,
    permissions: manifest.permissions.map((p) => ({ name: p.name, description: p.description })),
    scopes: input.scopes.map((name) => ({ name, description: SERVICE_SCOPES[name as ServiceScope] })),
    import: plan,
    returnsTo: origin,
    /** Send this back when approving: the approval is refused if the manifest has changed since */
    manifestHash: hash,
  };
}

/**
 * Approve: import the manifest, make the credentials, and keep them behind a
 * one-time code. Returns where to send the browser.
 */
export async function approveConnect(request: FastifyRequest, input: ConnectRequest): Promise<{ redirectTo: string; result: ImportResult }> {
  const { origin, redirect } = addressesOf(input);
  const { manifest, hash } = await fetchManifest(origin);
  if (!input.manifestHash) throw refuse('Check the request first, and approve what it showed (manifestHash)');
  if (input.manifestHash !== hash) throw new AppError('The application changed its manifest after it was checked: review it again', 409, true, 'MANIFEST_CHANGED');
  const result = await importManifest(manifest, { confirmClientTypeChange: input.confirmClientTypeChange });
  const app = await controlDb.applicationRegistry.findUniqueOrThrow({ where: { id: result.application.id }, include: { signIn: true } });
  const scopes = [...new Set(input.scopes)];
  const code = randomBytes(32).toString('base64url');

  await withPlatformAudit(request, async (tx, record) => {
    // A secret can only be read when it is made. One made by this import is
    // used; otherwise a new one replaces the old.
    let clientSecret = result.clientSecret;
    if (!clientSecret && app.signIn?.clientType === 'CONFIDENTIAL') {
      clientSecret = newClientSecret();
      await tx.applicationSignIn.update({ where: { applicationId: app.id }, data: { oidcClientSecret: clientSecret, secretCreatedAt: new Date() } });
    }
    let signingSecret = result.callbackSigningSecret;
    if (!signingSecret && app.provisioningCallbackUrl) {
      signingSecret = newCallbackSecret();
      // The old one keeps signing alongside for a day, as when it is replaced by hand
      await tx.applicationRegistry.update({
        where: { id: app.id },
        data: {
          callbackSigningSecret: signingSecret,
          previousCallbackSigningSecret: app.callbackSigningSecret ? decryptSecret(app.callbackSigningSecret, secretContext('callbackSigningSecret')) : null,
          previousCallbackSecretExpiresAt: app.callbackSigningSecret ? new Date(Date.now() + ROTATION_OVERLAP_MS) : null,
        },
      });
    }
    let service: ConnectCredentials['service'];
    if (scopes.length) {
      // The credential an earlier connection made stops working: the application now has this one
      await tx.productServiceCredential.updateMany({ where: { applicationId: app.id, name: CONNECT_CREDENTIAL_NAME, revokedAt: null }, data: { revokedAt: new Date() } });
      const secret = newServiceSecret();
      const made = await tx.productServiceCredential.create({
        data: { applicationId: app.id, name: CONNECT_CREDENTIAL_NAME, clientId: newServiceClientId(), serviceClientSecret: secret, scopes, createdBy: request.user.userId },
      });
      service = { tokenUrl: `${issuer()}/token`, resource: API_RESOURCE, clientId: made.clientId, clientSecret: secret, scopes };
    }

    const credentials: ConnectCredentials = {
      platform: { url: config.frontendUrl, apiUrl: config.bffUrl },
      application: { id: app.id, productId: app.key, name: app.name },
      signIn: { issuer: issuer(), discoveryUrl: `${issuer()}/.well-known/openid-configuration`, clientId: result.clientId, ...(clientSecret && { clientSecret }) },
      ...(signingSecret && { events: { signingSecret } }),
      ...(service && { service }),
    };
    // One request at a time per application; and whatever was never collected goes
    await tx.applicationConnectGrant.deleteMany({ where: { OR: [{ applicationId: app.id }, { expiresAt: { lt: new Date() } }] } });
    await tx.applicationConnectGrant.create({
      data: {
        applicationId: app.id,
        codeHash: sha256(code).toString('hex'),
        codeChallenge: input.codeChallenge,
        redirectUri: redirect.toString(),
        connectCredentials: JSON.stringify(credentials),
        createdBy: request.user.userId,
        expiresAt: new Date(Date.now() + GRANT_TTL_MS),
      },
    });
    await record('application.connected', {
      resource: { type: 'application', id: app.id, label: app.name },
      details: {
        address: origin,
        firstTime: result.created,
        ...(clientSecret && { newClientSecret: true }),
        ...(signingSecret && { newCallbackSigningSecret: true }),
        ...(service && { serviceCredential: service.clientId, scopes }),
      },
    });
  });

  redirect.searchParams.set('code', code);
  if (input.state) redirect.searchParams.set('state', input.state);
  return { redirectTo: redirect.toString(), result };
}

/**
 * The application's server collects its credentials: the code it was sent
 * back with, and the verifier whose challenge it sent at the start. Whatever
 * the outcome, the code is used up.
 */
export async function exchangeConnectCode(code: string, codeVerifier: string): Promise<ConnectCredentials> {
  const invalid = () => new AppError('The code is not valid, has been used, or has expired: connect again', 400, true, 'INVALID_GRANT');
  const codeHash = sha256(code).toString('hex');
  const grant = await controlDb.applicationConnectGrant.findUnique({ where: { codeHash } });
  if (!grant) throw invalid();
  // Only one caller gets past this, and a wrong verifier burns the code too
  const { count } = await controlDb.applicationConnectGrant.deleteMany({ where: { id: grant.id } });
  if (count !== 1 || grant.expiresAt < new Date()) throw invalid();
  const challenge = Buffer.from(sha256(codeVerifier).toString('base64url'));
  const expected = Buffer.from(grant.codeChallenge);
  if (challenge.length !== expected.length || !timingSafeEqual(challenge, expected)) throw invalid();
  return JSON.parse(decryptSecret(grant.connectCredentials, secretContext('connectCredentials'))) as ConnectCredentials;
}
