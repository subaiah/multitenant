/**
 * External products registered from a manifest (docs/PRODUCT_INTEGRATION.md),
 * by platform staff: import (create or update) and export.
 */
import type { FastifyPluginAsync } from 'fastify';
import { audit } from '../lib/audit.js';
import { exportManifest, importManifest } from '../lib/product-manifest.js';

export const applicationManifestRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/manifest', {
    config: { permission: 'app-registry:manage' },
    schema: {
      tags: ['applications'],
      summary: "Create or update an external product from its manifest (sign-in credentials are returned once, when made). ?dryRun=true checks and reports without saving; switching client type needs ?confirmClientTypeChange=true",
      body: { type: 'object' },
      querystring: { type: 'object', properties: { dryRun: { type: 'boolean' }, confirmClientTypeChange: { type: 'boolean' } } },
    },
  }, async (request, reply) => {
    const query = request.query as { dryRun?: boolean; confirmClientTypeChange?: boolean };
    const result = await importManifest(request.body, { dryRun: query.dryRun, confirmClientTypeChange: query.confirmClientTypeChange });
    if (result.dryRun) return reply.status(200).send(result);
    await audit(request, 'application.manifest_imported', {
      resource: { type: 'application', id: result.application.id, label: result.application.name },
      changes: result.changes,
      details: {
        created: result.created,
        version: result.application.version,
        permissionsAdded: result.permissions.added,
        permissionsUpdated: result.permissions.updated,
        permissionsNotInManifest: result.permissions.notInManifest,
        menuItems: result.menuItems,
        ...(result.clientSecret && { newClientSecret: true }),
        ...(result.callbackSigningSecret && { newCallbackSigningSecret: true }),
        ...(result.organizationsTold && { organizationsTold: result.organizationsTold }),
      },
    });
    return reply.status(result.created ? 201 : 200).send(result);
  });

  fastify.get('/:id/manifest', {
    config: { permission: 'app-registry:manage' },
    schema: {
      tags: ['applications'],
      summary: "An application's settings as a manifest",
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => exportManifest((request.params as { id: string }).id));
};
