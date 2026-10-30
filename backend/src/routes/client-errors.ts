/**
 * POST /bff/errors: the app reports an error from someone's browser
 * (src/lib/error-reporting.ts in the frontend). Forwarded to Sentry when
 * SENTRY_FRONTEND_DSN is set, otherwise dropped. Always 204, so the page
 * learns nothing either way. No session needed (errors happen on the sign-in
 * page too); rate limited per address.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { reportBrowserError } from '../lib/error-reporting.js';

const body = z.object({
  message: z.string().trim().min(1).max(1000),
  type: z.string().max(100).optional(),
  stack: z.string().max(8000).optional(),
  // The page's path only: the app never sends the query string or fragment
  path: z.string().max(300).regex(/^\/[^?#]*$/).optional(),
  release: z.string().max(100).optional(),
});

export const clientErrorRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/errors', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    bodyLimit: 16 * 1024,
    schema: { tags: ['monitoring'], summary: "Report an error from the app in someone's browser (forwarded to error tracking when it's set up)" },
  }, async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (parsed.success) reportBrowserError(parsed.data, request);
    return reply.status(204).send();
  });
};
