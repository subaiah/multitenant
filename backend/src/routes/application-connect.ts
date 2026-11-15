/**
 * Connecting an application in one step (lib/application-connect.ts,
 * docs/hub/CONNECT.md).
 *
 * Platform staff: check what an application asks for, and approve it.
 * (The application's server collects its credentials in application-connect-exchange.ts.)
 */
import type { FastifyPluginAsync } from 'fastify';
import { audit } from '../lib/audit.js';
import { approveConnect, checkConnect, connectRequestSchema } from '../lib/application-connect.js';
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
