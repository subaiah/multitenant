/**
 * Every external product's integration at a glance (platform staff): what's
 * set up, how its organizations' setup stands, and whether events, user
 * events and logout tokens are getting through. The Integrations page;
 * details are on each application's panels.
 */
import type { FastifyPluginAsync } from 'fastify';
import { controlDb } from '../lib/prisma.js';

/** Pending this long: something is wrong at the product's end */
const STUCK_MS = 60 * 60_000;

export const applicationIntegrationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/integrations', {
    config: { permission: 'app-registry:manage' },
    schema: { tags: ['applications'], summary: "Every external product's integration: settings, organizations' setup, and deliveries" },
  }, async () => {
    const now = new Date();
    const stuckBefore = new Date(now.getTime() - STUCK_MS);
    const [apps, setups, events, oldestPending, logouts, credentials, exposedScopes, consumedScopes, connectionUse] = await Promise.all([
      controlDb.applicationRegistry.findMany({
        where: { OR: [{ manifestImportedAt: { not: null } }, { signIn: { isNot: null } }, { provisioningCallbackUrl: { not: null } }] },
        select: {
          id: true, key: true, name: true, status: true, version: true, manifestImportedAt: true, provisioningCallbackUrl: true, userEvents: true,
          signIn: { select: { enabled: true, clientType: true, backchannelLogoutUri: true, accessTokenLifetime: true } },
        },
        orderBy: { name: 'asc' },
      }),
      controlDb.tenantApplication.groupBy({
        by: ['applicationId', 'provisioningStatus'],
        where: { state: { in: ['ENABLED', 'TRIAL'] }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
        _count: { _all: true },
      }),
      controlDb.productEvent.groupBy({ by: ['applicationId', 'status'], _count: { _all: true }, _max: { deliveredAt: true } }),
      controlDb.productEvent.groupBy({ by: ['applicationId'], where: { status: 'PENDING' }, _min: { createdAt: true } }),
      controlDb.oidcLogoutDelivery.groupBy({ by: ['applicationId', 'status'], _count: { _all: true }, _max: { deliveredAt: true } }),
      controlDb.productServiceCredential.groupBy({ by: ['applicationId'], where: { revokedAt: null }, _count: { _all: true }, _max: { lastUsedAt: true } }),
      controlDb.productApiScope.groupBy({ by: ['applicationId'], where: { retiredAt: null }, _count: { _all: true } }),
      controlDb.productConsumedScope.groupBy({ by: ['applicationId'], _count: { _all: true } }),
      controlDb.appConnectionState.groupBy({ by: ['callerApplicationId'], _sum: { tokensIssued: true }, _max: { lastIssuedAt: true } }),
    ]);
    const blockedFor = await controlDb.appConnectionState.groupBy({ by: ['callerApplicationId'], where: { blockedAt: { not: null } }, _count: { _all: true } });

    const count = <T extends { applicationId: string; _count: { _all: number } }>(rows: T[], id: string, pick: (r: T) => boolean = () => true) =>
      rows.filter((r) => r.applicationId === id && pick(r)).reduce((n, r) => n + r._count._all, 0);
    const latest = (rows: { applicationId: string; _max: { deliveredAt: Date | null } }[], id: string) =>
      rows.filter((r) => r.applicationId === id && r._max.deliveredAt).map((r) => r._max.deliveredAt!).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    return {
      applications: apps.map((a) => {
        const organizations = {
          total: count(setups, a.id),
          ready: count(setups, a.id, (r) => r.provisioningStatus === 'READY' || r.provisioningStatus === 'NOT_REQUIRED'),
          settingUp: count(setups, a.id, (r) => r.provisioningStatus === 'PENDING'),
          failed: count(setups, a.id, (r) => r.provisioningStatus === 'FAILED'),
        };
        const pendingSince = oldestPending.find((r) => r.applicationId === a.id)?._min.createdAt ?? null;
        const eventStats = {
          pending: count(events, a.id, (r) => r.status === 'PENDING'),
          failed: count(events, a.id, (r) => r.status === 'FAILED'),
          lastDeliveredAt: latest(events, a.id),
          pendingSince,
        };
        const logoutStats = {
          pending: count(logouts, a.id, (r) => r.status === 'PENDING'),
          failed: count(logouts, a.id, (r) => r.status === 'FAILED'),
          lastDeliveredAt: latest(logouts, a.id),
        };
        const cred = credentials.find((c) => c.applicationId === a.id);
        // What needs someone to look
        const attention = [
          organizations.failed > 0 && `${organizations.failed} organization${organizations.failed === 1 ? '' : 's'} failed setup`,
          eventStats.failed > 0 && `${eventStats.failed} event${eventStats.failed === 1 ? '' : 's'} given up`,
          pendingSince && pendingSince < stuckBefore && 'Events waiting for over an hour',
          logoutStats.failed > 0 && `${logoutStats.failed} logout${logoutStats.failed === 1 ? '' : 's'} given up`,
          a.status !== 'ACTIVE' && organizations.total > 0 && 'Not active, but organizations have it on',
        ].filter((x): x is string => !!x);
        return {
          id: a.id, key: a.key, name: a.name, status: a.status, version: a.version, manifestImportedAt: a.manifestImportedAt,
          signIn: a.signIn && {
            enabled: a.signIn.enabled, clientType: a.signIn.clientType,
            backchannelLogout: !!a.signIn.backchannelLogoutUri, accessTokenLifetime: a.signIn.accessTokenLifetime,
          },
          lifecycle: { callback: !!a.provisioningCallbackUrl, userEvents: a.userEvents && !!a.provisioningCallbackUrl },
          credentials: { active: cred?._count._all ?? 0, lastUsedAt: cred?._max.lastUsedAt ?? null },
          // Calls between applications (docs/adr/0001-app-to-app-calls.md)
          appToApp: {
            exposes: count(exposedScopes, a.id),
            consumes: count(consumedScopes, a.id),
            tokensIssued: connectionUse.find((u) => u.callerApplicationId === a.id)?._sum.tokensIssued ?? 0,
            lastIssuedAt: connectionUse.find((u) => u.callerApplicationId === a.id)?._max.lastIssuedAt ?? null,
            blockedBy: blockedFor.find((b) => b.callerApplicationId === a.id)?._count._all ?? 0,
          },
          organizations,
          events: eventStats,
          logouts: logoutStats,
          attention,
        };
      }),
    };
  });
};
