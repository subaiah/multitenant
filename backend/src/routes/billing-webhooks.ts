/**
 * Webhooks from the payment providers (no session; each delivery is checked
 * against the provider's signing secret):
 *
 *   POST /bff/billing/webhooks/razorpay
 *   POST /bff/billing/webhooks/stripe
 *
 * Behind the bundled Caddy: https://<your domain>/api/bff/billing/webhooks/<provider>.
 * The signature covers the exact bytes sent, so bodies are kept raw here.
 */
import type { FastifyPluginAsync } from 'fastify';
import { handleWebhook } from '../lib/billing/subscriptions.js';
import { enabledProviders, type ProviderName } from '../lib/billing/providers.js';

export const billingWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  // This plugin only: JSON stays as the bytes that were signed
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

  fastify.post('/:provider', {
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    schema: {
      tags: ['billing'],
      summary: 'Payment provider webhooks (signed)',
      params: { type: 'object', required: ['provider'], properties: { provider: { type: 'string', enum: ['razorpay', 'stripe'] } } },
    },
  }, async (request, reply) => {
    const name = (request.params as { provider: string }).provider.toUpperCase() as ProviderName;
    if (!enabledProviders().includes(name)) return reply.status(404).send({ error: 'Not Found', message: 'This payment provider is not set up' });
    if (!Buffer.isBuffer(request.body)) return reply.status(415).send({ error: 'Unsupported Media Type', message: 'Expected a JSON body' });
    const result = await handleWebhook(name, request.body, request.headers);
    if (result.status >= 500) request.log.error({ provider: name, message: result.message }, 'Billing webhook not handled');
    if (result.status === 400) request.log.warn({ securityEvent: 'billing-webhook-rejected', provider: name, message: result.message }, 'Billing webhook rejected');
    return reply.status(result.status).send({ message: result.message });
  });
};
