/**
 * Referring to another application's records (docs/PRODUCT_INTEGRATION.md,
 * "Records in other applications").
 *
 * An identifier is mt://<productId>/<type>/<id>; the organization is the one
 * the token is for. To show someone a record another application owns, ask
 * the owner whether they may see it: checkAccess() below, from your server.
 * If you own records, answer that question with createAccessCheckHandler().
 */
import type { AppCaller } from './apps.js';

export function parseResourceUri(uri: string): { productId: string; type: string; id: string } | null {
  const m = /^mt:\/\/([a-z0-9][a-z0-9-]{1,49})\/([a-z][a-z0-9_-]{0,49})\/([^/\s]{1,200})$/.exec(uri);
  if (!m) return null;
  try {
    return { productId: m[1], type: m[2], id: decodeURIComponent(m[3]) };
  } catch {
    return null;
  }
}
export const formatResourceUri = (productId: string, type: string, id: string) => `mt://${productId}/${type}/${encodeURIComponent(id)}`;

export interface AccessCheckRequest { subject: string; resources: string[] }
export interface AccessCheckResult { results: { resource: string; allowed: boolean }[] }

/**
 * Ask a record's owner whether a person may see some of its records.
 * `token`: an application token for the owner and organization, with
 * <owner>.records:check (createAppTokens().forOrganization(owner, organizationId, [`${owner}.records:check`])).
 * `accessCheckUrl` comes from GET …/resource-types. Anything not answered
 * `allowed: true` is no: when the owner can't be reached, show nothing.
 */
export async function checkAccess(accessCheckUrl: string, token: string, request: AccessCheckRequest): Promise<Map<string, boolean>> {
  const answer = new Map(request.resources.map((r) => [r, false]));
  const res = await fetch(accessCheckUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) return answer;
  const body = (await res.json().catch(() => null)) as AccessCheckResult | null;
  for (const r of body?.results ?? []) if (answer.has(r.resource) && r.allowed === true) answer.set(r.resource, true);
  return answer;
}

/**
 * For an application that owns records: a handler for POST /access-check.
 * `verify` is createAppTokenVerifier() for your own product id; `canSee`
 * decides for one person and some of your records, in the caller's
 * organization (caller.tenantId). Only your own identifiers are answered;
 * anything else is not allowed.
 */
export function createAccessCheckHandler(opts: {
  productId: string;
  verify: (authorization: string | undefined | null) => Promise<AppCaller>;
  canSee: (q: { tenantId: string; subject: string; records: { type: string; id: string; resource: string }[]; caller: AppCaller }) => Promise<Set<string> | string[]>;
}) {
  return async (authorization: string | undefined | null, body: unknown): Promise<{ status: number; body: AccessCheckResult | { error: string } }> => {
    let caller: AppCaller;
    try {
      caller = await opts.verify(authorization);
    } catch {
      return { status: 401, body: { error: 'invalid_token' } };
    }
    if (!caller.scopes.has(`${opts.productId}.records:check`)) return { status: 403, body: { error: 'insufficient_scope' } };
    const req = body as Partial<AccessCheckRequest> | null;
    if (!req || typeof req.subject !== 'string' || !Array.isArray(req.resources) || req.resources.length > 200) return { status: 400, body: { error: 'invalid_request' } };
    // The person must be in the caller's organization
    if (!req.subject.startsWith(`${caller.tenantId}.`)) return { status: 200, body: { results: req.resources.map((resource) => ({ resource: String(resource), allowed: false })) } };
    const mine = req.resources.map(String).map((resource) => ({ resource, parsed: parseResourceUri(resource) })).filter((x) => x.parsed?.productId === opts.productId);
    const allowed = new Set(mine.length ? await opts.canSee({ tenantId: caller.tenantId, subject: req.subject, records: mine.map((x) => ({ type: x.parsed!.type, id: x.parsed!.id, resource: x.resource })), caller }) : []);
    return { status: 200, body: { results: req.resources.map((resource) => ({ resource: String(resource), allowed: allowed.has(String(resource)) })) } };
  };
}
