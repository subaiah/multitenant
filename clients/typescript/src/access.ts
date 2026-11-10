/**
 * Applying a person's permissions in your application the way the platform
 * does (docs/PRODUCT_INTEGRATION.md, "Scoped permissions").
 *
 * `permissions` hold across the whole organization. `scopedPermissions` hold
 * only inside one of the organization's own organizations, one unit and every
 * unit below it, or one record. They come from the sign-in claims
 * (permissions, scoped_permissions), a token made on a person's behalf, the
 * members API and user events.
 *
 *   const units = unitTree((await api.GET('/product-integrations/organizations/{organizationId}/org-units', ...)).data!.units);
 *   if (!allows(person, 'crm.deals:edit', { orgUnitId: deal.unitId }, units)) return forbidden();
 */
export interface ScopedPermission {
  permission: string;
  scopeType: 'ORGANIZATION' | 'ORG_UNIT' | 'RESOURCE';
  scopeId: string;
}

export interface Access {
  permissions: readonly string[];
  scopedPermissions?: readonly ScopedPermission[];
}

/** Where a record sits: the organization's own organization, a unit, and/or its own id */
export interface Target {
  organizationId?: string | null;
  orgUnitId?: string | null;
  resourceId?: string | null;
}

/** A unit's parent and organization, by unit id (from GET …/org-units) */
export type UnitTree = ReadonlyMap<string, { organizationId: string; parentUnitId: string | null }>;

export function unitTree(units: readonly { id: string; organizationId: string; parentUnitId: string | null }[]): UnitTree {
  return new Map(units.map((u) => [u.id, { organizationId: u.organizationId, parentUnitId: u.parentUnitId }]));
}

/** As the platform matches them: exact, `resource:*`, `*:action`, `*` */
export function permissionMatches(granted: readonly string[], required: string): boolean {
  if (granted.includes('*') || granted.includes('*:*') || granted.includes(required)) return true;
  const i = required.indexOf(':');
  if (i === -1) return false;
  return granted.includes(`${required.slice(0, i)}:*`) || granted.includes(`*:${required.slice(i + 1)}`);
}

/**
 * Whether the person may use `permission` on a record here. Without a target,
 * only a permission held across the whole organization counts. A unit grant
 * covers the units below it, so pass the tree when targets name units.
 */
export function allows(access: Access, permission: string, target: Target = {}, units?: UnitTree): boolean {
  if (permissionMatches(access.permissions, permission)) return true;
  const grants = (access.scopedPermissions ?? []).filter((g) => permissionMatches([g.permission], permission));
  if (!grants.length) return false;
  const chain: string[] = [];
  let organizationId = target.organizationId ?? undefined;
  for (let id = target.orgUnitId ?? null; id && chain.length < 50 && !chain.includes(id); ) {
    chain.push(id);
    const unit = units?.get(id);
    if (!unit) break;
    organizationId ??= unit.organizationId;
    id = unit.parentUnitId;
  }
  return grants.some((g) =>
    (g.scopeType === 'ORGANIZATION' && g.scopeId === organizationId) ||
    (g.scopeType === 'ORG_UNIT' && chain.includes(g.scopeId)) ||
    (g.scopeType === 'RESOURCE' && !!target.resourceId && g.scopeId === target.resourceId));
}
