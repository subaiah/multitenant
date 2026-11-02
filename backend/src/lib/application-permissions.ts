/**
 * Permissions that applications in the catalogue declare (the platform's
 * Applications page), made grantable in an organization's roles while it has
 * the application turned on.
 *
 * - Names are `<application key>.<thing>:<action>` (or `<key>:<action>`), so
 *   one application's permissions can never widen the kit's or another's.
 * - An organization's role editor offers those of the applications it has on
 *   (entitlement ENABLED or TRIAL, within its dates; application ACTIVE).
 * - Its administrators hold them all, as they hold everything else in the
 *   organization, so they can build roles with them.
 * - "Sign in with" sends the ones a person holds in the `permissions` claim
 *   (lib/oidc/accounts.ts).
 *
 * The list per organization is cached for a few seconds: it's read on every
 * request an administrator makes.
 */
import { controlDb } from './prisma.js';
import { PERMISSIONS, PLATFORM_RESOURCES } from '../utils/permissions.js';

export interface ApplicationPermission {
  name: string;
  resource: string;
  action: string;
  description: string | null;
  application: { id: string; key: string; name: string };
}

const NAME = /^([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)?):([a-z0-9][a-z0-9-]*)$/;
const kitResources = new Set<string>(PERMISSIONS.map((p) => p.split(':')[0]));

/** Why a permission name can't belong to this application, or null if it can */
export function applicationPermissionProblem(applicationKey: string, name: string): string | null {
  const m = NAME.exec(name);
  if (!m) return 'Use lowercase resource:action, e.g. crm.deals:approve';
  const resource = m[1];
  if (resource !== applicationKey && !resource.startsWith(`${applicationKey}.`)) {
    return `Start the resource with the application's key: ${applicationKey}:… or ${applicationKey}.something:…`;
  }
  if (kitResources.has(resource) || PLATFORM_RESOURCES.has(resource)) return 'That resource belongs to the platform';
  return null;
}

const TTL_MS = 15_000;
const cache = new Map<string, { at: number; value: Promise<ApplicationPermission[]> }>();

/** The application permissions an organization's roles may contain now */
export function entitledApplicationPermissions(tenantId: string): Promise<ApplicationPermission[]> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = load(tenantId).catch((err) => {
    cache.delete(tenantId);
    throw err;
  });
  cache.set(tenantId, { at: Date.now(), value });
  return value;
}

/** After a change to entitlements or declared permissions (other servers catch up within seconds) */
export function forgetApplicationPermissions(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

async function load(tenantId: string): Promise<ApplicationPermission[]> {
  const now = new Date();
  const rows = await controlDb.permission.findMany({
    where: {
      application: {
        status: 'ACTIVE',
        tenantApplications: {
          some: { tenantId, state: { in: ['ENABLED', 'TRIAL'] }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
        },
      },
    },
    select: { name: true, description: true, application: { select: { id: true, key: true, name: true } } },
    orderBy: { name: 'asc' },
  });
  // Only names that follow the rule (older rows might not)
  return rows
    .filter((r) => r.application && !applicationPermissionProblem(r.application.key, r.name))
    .map((r) => {
      const [resource, action] = r.name.split(':');
      return { name: r.name, resource, action, description: r.description, application: r.application! };
    });
}
