/**
 * Connecting an application in one step (lib/application-connect.ts,
 * docs/hub/CONNECT.md).
 *
 * Platform staff: check what an application asks for, and approve it.
 * The application's server: collect its credentials with the one-time code.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { approveConnect, checkConnect, connectRequestSchema, exchangeConnectCode } from '../lib/application-connect.js';
import { connectExchangeRateLimit } from '../lib/rate-limits.js';
import { importAuditEntry } from './application-manifest.js';

/** For platform staff, under /applications */
export const applicationConnectRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/connect/check', {
    config: { permission: 'app-registry:manage' },
    schema: {
      tags: ['applications'],
      summary: "Read an application's manifest from its own address and report what connecting it would do. Nothing is saved.",
      body: { type: 'object' },
    },
  }, async (request) => checkConnect(connectRequestSchema.parse(request.body)));

  fastify.post('/connect/approve', {
    config: { permission: 'app-registry:manage' },
    schema: {
      tags: ['applications'],
      summary: "Connect an application: import its manifest, make its credentials and keep them for it to collect. Returns where to send the browser.",
      body: { type: 'object' },
    },
  }, async (request) => {
    const { redirectTo, result } = await approveConnect(request, connectRequestSchema.parse(request.body));
    await audit(request, 'application.manifest_imported', importAuditEntry(result, { connected: true }));
    return { redirectTo, application: result.application, created: result.created };
  });
};

const exchangeSchema = z.object({
  code: z.string().min(1).max(200),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/, 'A PKCE verifier (43 to 128 characters)'),
});

/** For the application's server: no session, the code and verifier are the proof */
export const applicationConnectExchangeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/exchange', {
    config: { rateLimit: connectExchangeRateLimit },
    schema: {
      tags: ['applications'],
      summary: "Collect an application's credentials with the code from an approved connection (once)",
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const { code, codeVerifier } = exchangeSchema.parse(request.body);
    const credentials = await exchangeConnectCode(code, codeVerifier);
    // Secrets: never to be kept by anything in between
    return reply.header('Cache-Control', 'no-store').send(credentials);
  });
};
