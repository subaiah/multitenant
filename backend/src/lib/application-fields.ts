/**
 * Which fields of a catalogue application (application_registries) a caller
 * gets. Routes select these explicitly instead of returning whole rows:
 *
 * - everyone who can see the catalogue (organizations' administrators
 *   included): what the application is;
 * - platform staff also: how it's integrated (callback address, when the
 *   manifest was imported, how many organizations have it);
 * - nobody: the lifecycle signing secrets (shown once when made; the
 *   Lifecycle events panel only says whether there is one), even encrypted.
 *
 * test/application-fields.test.ts checks every catalogue route for this.
 */
import { isPlatformUser } from '../utils/authorization.js';
import { controlDb } from './prisma.js';

export const CATALOGUE_FIELDS = {
  id: true,
  key: true,
  name: true,
  description: true,
  version: true,
  status: true,
  baseUrl: true,
  deletesDataOnDeprovision: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const PLATFORM_FIELDS = {
  ...CATALOGUE_FIELDS,
  manifestImportedAt: true,
  provisioningCallbackUrl: true,
  previousCallbackSecretExpiresAt: true,
  userEvents: true,
} as const;

/** Never in a response */
export const SECRET_COLUMNS = ['callbackSigningSecret', 'previousCallbackSigningSecret'] as const;

export const isPlatformCaller = (user: unknown) => isPlatformUser((user as { userType?: string } | undefined)?.userType as never);

/**
 * What an application's server can learn about an organization's people,
 * for its administrators to see (Application Entitlements):
 * - peopleAndGroups: a live service credential with members.read can read
 *   them through API v1 while the organization has it on;
 * - toldWhenPeopleChange: it gets user events (lib/product-user-events.ts).
 */
export interface DataAccess { peopleAndGroups: boolean; toldWhenPeopleChange: boolean }

export async function dataAccessOf(applicationIds: string[]): Promise<Map<string, DataAccess>> {
  const ids = [...new Set(applicationIds)];
  const [creds, apps] = await Promise.all([
    controlDb.productServiceCredential.findMany({ where: { applicationId: { in: ids }, revokedAt: null, scopes: { has: 'members.read' } }, select: { applicationId: true } }),
    controlDb.applicationRegistry.findMany({ where: { id: { in: ids } }, select: { id: true, userEvents: true, provisioningCallbackUrl: true } }),
  ]);
  const reads = new Set(creds.map((c) => c.applicationId));
  return new Map(apps.map((a) => [a.id, { peopleAndGroups: reads.has(a.id), toldWhenPeopleChange: a.userEvents && !!a.provisioningCallbackUrl }]));
}
