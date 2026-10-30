/**
 * Who can sign in to an application, and what it learns about them.
 *
 * The subject (`sub`) is `<tenant id>.<user id>`: stable, unique across
 * organizations, and enough to find the person in their organization's data.
 * Only organization members sign in this way (not platform staff), and only
 * while their account is active, their organization is open and has the
 * application turned on (an entitlement: ENABLED or TRIAL, within its dates).
 * That is checked when they sign in, and again whenever the application
 * refreshes tokens, so turning an application off or suspending someone takes
 * effect without waiting for their tokens to run out.
 */
import { controlDb } from '../prisma.js';
import { dbForTenant } from '../tenant-db.js';
import { getEnhancedUserPermissions } from '../../utils/authorization.js';
import { permissionMatches } from '../../utils/permissions.js';

export const accountIdFor = (tenantId: string, userId: string) => `${tenantId}.${userId}`;

export function parseAccountId(sub: string): { tenantId: string; userId: string } | null {
  const i = sub.indexOf('.');
  if (i <= 0 || i === sub.length - 1) return null;
  return { tenantId: sub.slice(0, i), userId: sub.slice(i + 1) };
}

export type AccessProblem = 'NOT_ENTITLED' | 'ORGANIZATION_UNAVAILABLE' | 'ACCOUNT_INACTIVE' | 'APPLICATION_UNAVAILABLE';

/** The application a client belongs to, if it may sign people in */
export async function applicationForClient(clientId: string) {
  const signIn = await controlDb.applicationSignIn.findUnique({
    where: { clientId },
    select: { enabled: true, application: { select: { id: true, key: true, name: true, status: true } } },
  });
  return signIn?.enabled && signIn.application.status === 'ACTIVE' ? signIn.application : null;
}

/** Whether the organization has the application turned on right now */
export async function entitled(tenantId: string, applicationId: string, now = new Date()): Promise<boolean> {
  const e = await controlDb.tenantApplication.findUnique({
    where: { tenantId_applicationId: { tenantId, applicationId } },
    select: { state: true, validFrom: true, validTo: true },
  });
  return !!e && ['ENABLED', 'TRIAL'].includes(e.state) && e.validFrom <= now && (!e.validTo || e.validTo > now);
}

interface AccountRecord {
  tenant: { id: string; slug: string; name: string };
  user: { id: string; email: string; name: string | null; userType: string; updatedAt: Date; sessionsValidAfter: Date | null };
}

/**
 * The person behind a subject, if they may use the application now; otherwise
 * why not. `issuedAt` (ms) is when the token being used was issued: one from
 * before "sign out everywhere" no longer works.
 */
export async function checkAccount(
  sub: string,
  clientId: string,
  issuedAt?: number,
): Promise<{ account: AccountRecord; applicationId: string; applicationName: string } | { problem: AccessProblem }> {
  const app = await applicationForClient(clientId);
  if (!app) return { problem: 'APPLICATION_UNAVAILABLE' };
  const ids = parseAccountId(sub);
  if (!ids) return { problem: 'ACCOUNT_INACTIVE' };
  const tenant = await controlDb.tenant.findUnique({
    where: { id: ids.tenantId },
    select: { id: true, slug: true, name: true, status: true, provisioningStatus: true, databaseConfig: { select: { updatedAt: true } } },
  });
  if (!tenant || tenant.status === 'SUSPENDED' || tenant.provisioningStatus !== 'READY') return { problem: 'ORGANIZATION_UNAVAILABLE' };
  const db = await dbForTenant(tenant.id, tenant.databaseConfig?.updatedAt);
  const user = await db.user.findFirst({
    where: { id: ids.userId, tenantId: tenant.id },
    select: { id: true, email: true, name: true, userType: true, status: true, updatedAt: true, sessionsValidAfter: true },
  });
  if (!user || user.status !== 'ACTIVE') return { problem: 'ACCOUNT_INACTIVE' };
  if (issuedAt !== undefined && user.sessionsValidAfter && issuedAt < user.sessionsValidAfter.getTime()) return { problem: 'ACCOUNT_INACTIVE' };
  if (!(await entitled(tenant.id, app.id))) return { problem: 'NOT_ENTITLED' };
  return { account: { tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name }, user }, applicationId: app.id, applicationName: app.name };
}

/** The claims for the scopes granted (lib/oidc/provider.ts lists which claim belongs to which scope) */
export async function claimsFor(sub: string, record: AccountRecord, applicationId: string, scopes: Set<string>) {
  const { tenant, user } = record;
  const claims: { sub: string; [claim: string]: unknown } = { sub };
  // No email_verified: the kit doesn't record whether an address was confirmed
  if (scopes.has('email')) claims.email = user.email;
  if (scopes.has('profile')) Object.assign(claims, { name: user.name ?? user.email, updated_at: Math.floor(user.updatedAt.getTime() / 1000) });
  if (scopes.has('organization')) Object.assign(claims, { tenant_id: tenant.id, tenant_slug: tenant.slug, tenant_name: tenant.name });
  if (scopes.has('roles')) {
    const data = await getEnhancedUserPermissions(user.id, tenant.id, user.userType);
    // The permissions this application declares (Applications page) that the person holds
    const declared = await controlDb.permission.findMany({ where: { applicationId }, select: { name: true }, orderBy: { name: 'asc' } });
    Object.assign(claims, {
      roles: [...new Set([...data.sources.directRoles, ...data.sources.groupRoles])].sort(),
      permissions: declared.map((p) => p.name).filter((p) => permissionMatches(data.permissions, p)),
    });
  }
  return claims;
}
