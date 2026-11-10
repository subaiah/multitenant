/**
 * Referring to another application's records (docs/hub/HUB_GAPS.md G8).
 *
 * - An identifier: mt://<productId>/<type>/<id>. The organization isn't in
 *   it: it's the one the token is for, so an identifier never leaks across
 *   organizations and can be stored as is (a Hearth thread "on" a deal).
 * - The owning application declares its record types (manifest v2
 *   resources: type, label, urlTemplate) and exposes <productId>.records:check.
 *   Another application asks it whether a person can see some records:
 *   POST <baseUrl><accessCheckPath, default /access-check> with an
 *   application token for the owner (G1) and { subject, resources: [...] }.
 *   The answer is { results: [{ resource, allowed }] }. The owner decides; the
 *   platform only says where to ask.
 * - Here: the catalogue of record types (GET …/resource-types) and turning an
 *   identifier into a link for an organization that has the owner on
 *   (GET …/organizations/{id}/resources/resolve).
 */
import { controlDb } from './prisma.js';
import { readableOrganization } from './product-data.js';
import { entitlementProblem } from './oidc/accounts.js';
import { AppError } from '../middleware/error-handler.js';

export const DEFAULT_ACCESS_CHECK_PATH = '/access-check';
const URI = /^mt:\/\/([a-z0-9][a-z0-9-]{1,49})\/([a-z][a-z0-9_-]{0,49})\/([^/\s]{1,200})$/;

export function parseResourceUri(uri: string): { productId: string; type: string; id: string } | null {
  const m = URI.exec(uri);
  if (!m) return null;
  try {
    return { productId: m[1], type: m[2], id: decodeURIComponent(m[3]) };
  } catch {
    return null;
  }
}
export const formatResourceUri = (productId: string, type: string, id: string) => `mt://${productId}/${type}/${encodeURIComponent(id)}`;

const base = (url: string | null) => (url ?? '').replace(/\/+$/, '');

/** Every active application's record types, with where to ask about access */
export async function resourceTypes() {
  const rows = await controlDb.productResourceType.findMany({
    where: { application: { status: 'ACTIVE' } },
    include: { application: { select: { key: true, name: true, baseUrl: true, accessCheckPath: true } } },
    orderBy: [{ application: { key: 'asc' } }, { position: 'asc' }],
  });
  return {
    types: rows.map((r) => ({
      productId: r.application.key,
      application: r.application.name,
      type: r.type,
      label: r.label,
      /** Absolute, with {id} */
      urlTemplate: `${base(r.application.baseUrl)}${r.urlTemplate}`,
      accessCheckUrl: `${base(r.application.baseUrl)}${r.application.accessCheckPath ?? DEFAULT_ACCESS_CHECK_PATH}`,
      checkScope: `${r.application.key}.records:check`,
    })),
  };
}

/** An identifier as a link, for an organization that has both the caller and the owner on */
export async function resolveResource(callerApplicationId: string, tenantId: string, uri: string) {
  await readableOrganization(callerApplicationId, tenantId);
  const parsed = parseResourceUri(uri);
  if (!parsed) throw new AppError('Not a record identifier (mt://<productId>/<type>/<id>)', 400, true, 'INVALID_RESOURCE');
  const t = await controlDb.productResourceType.findFirst({
    where: { type: parsed.type, application: { key: parsed.productId, status: 'ACTIVE' } },
    include: { application: { select: { id: true, key: true, name: true, baseUrl: true } } },
  });
  if (!t) throw new AppError(`${parsed.productId} has no record type "${parsed.type}"`, 404, true, 'UNKNOWN_RESOURCE_TYPE');
  // Only where the organization can open it
  if (await entitlementProblem(tenantId, t.application.id)) throw new AppError(`This organization doesn't have ${t.application.name} turned on`, 404, true, 'NOT_ENTITLED');
  return {
    resource: formatResourceUri(parsed.productId, parsed.type, parsed.id),
    productId: parsed.productId,
    application: t.application.name,
    type: parsed.type,
    label: t.label,
    id: parsed.id,
    url: `${base(t.application.baseUrl)}${t.urlTemplate.replace('{id}', encodeURIComponent(parsed.id))}`,
  };
}
