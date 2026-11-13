/**
 * The application's server collecting its credentials after an
 * administrator connected it (lib/application-connect.ts,
 * docs/hub/CONNECT.md). No session: the one-time code and the PKCE verifier
 * are the proof.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { exchangeConnectCode } from '../lib/application-connect.js';
import { connectExchangeRateLimit } from '../lib/rate-limits.js';

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
