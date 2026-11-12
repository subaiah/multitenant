/**
 * "Sign in with" settings for an application in the catalogue (platform
 * staff): turn it on, where it may send people back to, and its client
 * credentials. The client secret is shown once, when it's made or replaced;
 * it's stored encrypted (lib/secrets.ts).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { audit, diff, withPlatformAudit } from '../lib/audit.js';
import { DEFAULT_ACCESS_TOKEN_LIFETIME, issuer } from '../lib/oidc/provider.js';
import { callbackUrlSchema } from '../lib/product-lifecycle.js';
import { allowedUri, newClientId, newClientSecret as newSecret } from '../lib/oidc/uris.js';

const MAX_URIS = 10;

const uri = z.string().max(2000).refine(allowedUri, 'Use an https:// address (or http://localhost while developing), without a #fragment');

const settingsSchema = z.object({
  enabled: z.boolean(),
  clientType: z.enum(['CONFIDENTIAL', 'PUBLIC']),
  redirectUris: z.array(uri).max(MAX_URIS),
  postLogoutRedirectUris: z.array(uri).max(MAX_URIS).default([]),
  initiateLoginUri: z.union([z.literal(''), z.null(), z.string().max(2000).refine((v) => allowedUri(v), 'Use an https:// address (or http://localhost while developing)')]).optional(),
  // Left out: unchanged (lib/oidc/logout.ts)
  backchannelLogoutUri: z.union([z.literal(''), z.null(), callbackUrlSchema]).optional(),
  accessTokenLifetime: z.number().int().min(60).max(86_400).optional(),
});


const view = (s: Awaited<ReturnType<typeof controlDb.applicationSignIn.findUnique>>) =>
  s && {
    enabled: s.enabled,
    clientId: s.clientId,
    clientType: s.clientType,
    hasSecret: !!s.oidcClientSecret,
    secretCreatedAt: s.secretCreatedAt,
    redirectUris: s.redirectUris,
    postLogoutRedirectUris: s.postLogoutRedirectUris,
    initiateLoginUri: s.initiateLoginUri,
    backchannelLogoutUri: s.backchannelLogoutUri,
    accessTokenLifetime: s.accessTokenLifetime,
    updatedAt: s.updatedAt,
  };

const provider = () => ({ issuer: issuer(), discoveryUrl: `${issuer()}/.well-known/openid-configuration` });

export const applicationSignInRoutes: FastifyPluginAsync = async (fastify) => {
  const findApp = async (id: string) => {
    const app = await controlDb.applicationRegistry.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!app) throw new AppError('Application not found', 404);
    return app;
  };

  fastify.get('/:id/sign-in', {
    config: { permission: 'app-registry:manage' },
    schema: {
      tags: ['applications'],
      summary: "An application's sign-in settings",
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    await findApp(id);
    const settings = await controlDb.applicationSignIn.findUnique({ where: { applicationId: id } });
    return { ...provider(), settings: view(settings) };
  });

  fastify.put('/:id/sign-in', {
    config: { permission: 'app-registry:manage' },
    schema: {
      tags: ['applications'],
      summary: "Set an application's sign-in settings (a new client secret is returned once)",
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const app = await findApp(id);
    const data = settingsSchema.parse(request.body);
    if (data.enabled && data.redirectUris.length === 0) {
      throw new AppError('Add at least one redirect URI before turning sign-in on', 400);
    }
    const before = await controlDb.applicationSignIn.findUnique({ where: { applicationId: id } });
    // A server keeps a secret; a browser or mobile app can't, so it has none
    const secret = data.clientType === 'CONFIDENTIAL' && !before?.oidcClientSecret ? newSecret() : undefined;
    const fields = {
      enabled: data.enabled,
      clientType: data.clientType,
      redirectUris: [...new Set(data.redirectUris)],
      postLogoutRedirectUris: [...new Set(data.postLogoutRedirectUris)],
      initiateLoginUri: data.initiateLoginUri || null,
      backchannelLogoutUri: data.backchannelLogoutUri === undefined ? (before?.backchannelLogoutUri ?? null) : data.backchannelLogoutUri || null,
      accessTokenLifetime: data.accessTokenLifetime ?? before?.accessTokenLifetime ?? DEFAULT_ACCESS_TOKEN_LIFETIME,
      ...(secret && { oidcClientSecret: secret, secretCreatedAt: new Date() }),
      ...(data.clientType === 'PUBLIC' && { oidcClientSecret: null, secretCreatedAt: null }),
    };
    const saved = await controlDb.applicationSignIn.upsert({
      where: { applicationId: id },
      create: { applicationId: id, clientId: newClientId(), ...fields },
      update: fields,
    });
    const { oidcClientSecret: _a, secretCreatedAt: _b, ...changed } = fields;
    await audit(request, 'application.sign_in_updated', {
      resource: { type: 'application', id, label: app.name },
      changes: diff(before ?? {}, changed),
      details: { clientId: saved.clientId, ...(secret && { newClientSecret: true }) },
    });
    return { ...provider(), settings: view(saved), ...(secret && { clientSecret: secret }) };
  });

  fastify.post('/:id/sign-in/secret', {
    config: { permission: 'app-registry:manage' },
    schema: {
      tags: ['applications'],
      summary: "Replace an application's client secret (returned once; the old one stops working at once)",
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const app = await findApp(id);
    const existing = await controlDb.applicationSignIn.findUnique({ where: { applicationId: id } });
    if (!existing) throw new AppError('Set up sign-in for this application first', 400);
    if (existing.clientType !== 'CONFIDENTIAL') throw new AppError('Public clients have no secret', 400);
    const secret = newSecret();
    const saved = await withPlatformAudit(request, async (tx, record) => {
      const saved = await tx.applicationSignIn.update({
        where: { applicationId: id },
        data: { oidcClientSecret: secret, secretCreatedAt: new Date() },
      });
      await record('application.client_secret_rotated', { resource: { type: 'application', id, label: app.name }, details: { clientId: saved.clientId } });
      return saved;
    });
    return { ...provider(), settings: view(saved), clientSecret: secret };
  });
};
