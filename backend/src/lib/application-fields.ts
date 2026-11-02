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
} as const;

/** Never in a response */
export const SECRET_COLUMNS = ['callbackSigningSecret', 'previousCallbackSigningSecret'] as const;

export const isPlatformCaller = (user: unknown) => isPlatformUser((user as { userType?: string } | undefined)?.userType as never);
