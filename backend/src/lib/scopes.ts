/**
 * Role assignments scoped to part of a tenant.
 *
 * A role can be assigned for the whole tenant, or for one organization, one
 * unit (and every unit below it) or one resource. A scoped assignment grants
 * its permissions there only: route checks and hasPermission() see the
 * tenant-wide permissions alone, so a "Manager for Acme EU" can't manage the
 * tenant's users. Routes that act on organization data declare
 * `config: { permission, scoped: true }` (the route check then also lets
 * through someone holding the permission somewhere) and decide per item:
 *
 *   await requireInScope(request, 'organizations:update', { organizationId })
 *   await requireInScope(request, 'organizations:update', { orgUnitId })
 *   const where = await scopeWhere(request, 'organizations:read')   // lists
 *
 * Products use the same calls for their own rows (e.g. invoices with an
 * organization_id, or { resourceId } for single records).
 */
import type { FastifyRequest } from 'fastify';
import { AppError } from '../middleware/error-handler.js';
import { hasPermission, loadPermissions } from '../middleware/authorize.js';
import { permissionMatches } from '../utils/permissions.js';
import type { ScopedGrant } from '../utils/authorization.js';

export interface ScopeTarget {
  organizationId?: string;
  orgUnitId?: string;
  resourceId?: string;
}

/** The request's scoped grants that cover a permission */
export async function grantsFor(request: FastifyRequest, permission: string): Promise<ScopedGrant[]> {
  await loadPermissions(request);
  return (request.scopedGrants ?? []).filter((g) => permissionMatches([g.permission], permission));
}

/** A unit, its ancestors (nearest first) and its organization */
async function unitChain(request: FastifyRequest, unitId: string): Promise<{ organizationId: string; ids: string[] } | null> {
  const ids: string[] = [];
  let organizationId: string | null = null;
  let next: string | null = unitId;
  // A cycle can't be created through the API, but don't trust that blindly
  for (let depth = 0; next && depth < 50 && !ids.includes(next); depth++) {
    const unit: { organizationId: string; parentUnitId: string | null } | null = await request.db.orgUnit.findFirst({
      where: { id: next, tenantId: request.tenant.id },
      select: { organizationId: true, parentUnitId: true },
    });
    if (!unit) break;
    ids.push(next);
    organizationId = unit.organizationId;
    next = unit.parentUnitId;
  }
  return organizationId ? { organizationId, ids } : null;
}

/** Whether the request may use `permission` on this organization, unit or resource */
export async function canInScope(request: FastifyRequest, permission: string, target: ScopeTarget): Promise<boolean> {
  if (await hasPermission(request, permission)) return true;
  const grants = await grantsFor(request, permission);
  if (!grants.length) return false;
  let organizationId = target.organizationId;
  let units: string[] = [];
  if (target.orgUnitId) {
    const chain = await unitChain(request, target.orgUnitId);
    if (chain) {
      units = chain.ids;
      organizationId ??= chain.organizationId;
    }
  }
  return grants.some((g) =>
    (g.scopeType === 'ORGANIZATION' && g.scopeId === organizationId) ||
    (g.scopeType === 'ORG_UNIT' && units.includes(g.scopeId)) ||
    (g.scopeType === 'RESOURCE' && g.scopeId === target.resourceId));
}

export async function requireInScope(request: FastifyRequest, permission: string, target: ScopeTarget): Promise<void> {
  if (!(await canInScope(request, permission, target))) {
    throw new AppError(`Missing permission: ${permission} here`, 403);
  }
}

/**
 * Where a permission applies, for filtering lists: everywhere, or these
 * organizations, units (with the units below them) and resources.
 */
export async function scopeOf(request: FastifyRequest, permission: string): Promise<
  { all: true } | { all: false; organizationIds: string[]; orgUnitIds: string[]; resourceIds: string[] }
> {
  if (await hasPermission(request, permission)) return { all: true };
  const grants = await grantsFor(request, permission);
  const ids = (t: ScopedGrant['scopeType']) => [...new Set(grants.filter((g) => g.scopeType === t).map((g) => g.scopeId))];
  return { all: false, organizationIds: ids('ORGANIZATION'), orgUnitIds: ids('ORG_UNIT'), resourceIds: ids('RESOURCE') };
}

/**
 * Of an organization's units, the ones a set of unit grants reach: the
 * granted units and everything below them.
 */
export function unitsWithin(units: { id: string; parentUnitId: string | null }[], granted: string[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const u of units) if (u.parentUnitId) children.set(u.parentUnitId, [...(children.get(u.parentUnitId) ?? []), u.id]);
  const reached = new Set<string>();
  const stack = units.filter((u) => granted.includes(u.id)).map((u) => u.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return reached;
}
