/**
 * A typed client for the Multitenant API v1.
 *
 *   import { createClient } from '@multitenant/api-client';
 *
 *   const api = createClient({ baseUrl: 'https://app.example.com/api/v1', apiKey: process.env.MULTITENANT_API_KEY! });
 *   const { data, error } = await api.GET('/users', { params: { query: { limit: 50, status: 'ACTIVE' } } });
 *   if (error) throw new Error(error.message);
 *   for (const user of data.data) console.log(user.email);
 *
 * Paths, parameters, bodies and answers are typed from the API's OpenAPI
 * document (src/schema.d.ts, generated: npm run generate). Requests go
 * through openapi-fetch, so the answer is { data } or { error }, never thrown.
 */
import createFetchClient, { type Client, type ClientOptions } from 'openapi-fetch';
import type { components, paths } from './schema.js';

export type { components, paths, operations, webhooks } from './schema.js';

/** The API's objects: User, Group, Organization, RoleAssignment, AuditEntry, WebhookEvent... */
export type Schemas = components['schemas'];
export type User = Schemas['User'];
export type Group = Schemas['Group'];
export type Organization = Schemas['Organization'];
export type RoleAssignment = Schemas['RoleAssignment'];
export type AuditEntry = Schemas['AuditEntry'];
export type WebhookEvent = Schemas['WebhookEvent'];
export type ApiError = Schemas['Error'];
export type ProductIdentity = Schemas['ProductIdentity'];
export type ProductOrganization = Schemas['ProductOrganization'];
export type ProductMember = Schemas['ProductMember'];
export type ProductOrgUnits = Schemas['ProductOrgUnits'];
export type ProductEmbed = Schemas['ProductEmbed'];
export type ProductBranding = Schemas['ProductBranding'];
export type ProductLauncher = Schemas['ProductLauncher'];
export type ProductPublished = Schemas['ProductPublished'];
export type ResourceType = Schemas['ResourceType'];
export type ProductGroup = Schemas['ProductGroup'];
export type ProductEvent = Schemas['ProductEvent'];

export interface Options extends Omit<ClientOptions, 'baseUrl'> {
  /** The API's v1 address, e.g. https://app.example.com/api/v1 */
  baseUrl: string;
  /** An API key from the Developers page (mtk_...) */
  apiKey: string;
}

export function createClient({ baseUrl, apiKey, headers, ...rest }: Options): Client<paths> {
  return createFetchClient<paths>({
    ...rest,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    headers: { ...(headers as Record<string, string> | undefined), Authorization: `Bearer ${apiKey}` },
  });
}

export interface ProductOptions extends Omit<ClientOptions, 'baseUrl'> {
  /** The API's v1 address, e.g. https://app.example.com/api/v1 */
  baseUrl: string;
  /** The platform's token endpoint, e.g. https://app.example.com/api/oidc/token */
  tokenUrl: string;
  /** A service credential from the platform's Applications page (mts_...) */
  clientId: string;
  clientSecret: string;
  /** The scopes to ask for, e.g. ['organizations.read', 'lifecycle.report'] */
  scopes: string[];
}

/**
 * A client for an external product calling as itself (docs/PRODUCT_INTEGRATION.md).
 * It gets service access tokens (OAuth client credentials) and renews each a
 * minute before it expires. Use it from the product's server only: the
 * secret must never reach a browser.
 */
export function createProductClient({ baseUrl, tokenUrl, clientId, clientSecret, scopes, ...rest }: ProductOptions): Client<paths> {
  let token: { value: string; renewAt: number } | null = null;
  let pending: Promise<string> | null = null;
  const fetchToken = async (): Promise<string> => {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: scopes.join(' ') }),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`Getting a service token failed: ${body.error_description ?? body.error ?? res.status}`);
    token = { value: body.access_token, renewAt: Date.now() + ((body.expires_in ?? 600) - 60) * 1000 };
    return token.value;
  };
  const current = () => {
    if (token && Date.now() < token.renewAt) return Promise.resolve(token.value);
    pending ??= fetchToken().finally(() => (pending = null));
    return pending;
  };
  const client = createFetchClient<paths>({ ...rest, baseUrl: baseUrl.replace(/\/+$/, '') });
  client.use({
    async onRequest({ request }) {
      request.headers.set('Authorization', `Bearer ${await current()}`);
      return request;
    },
  });
  return client;
}


// Applications calling each other (docs/adr/0001-app-to-app-calls.md)
export { createAppTokens, createAppTokenVerifier, appAudience, AppTokenError, AppTokenInvalid, type AppCaller, type AppTokenOptions } from './apps.js';

// Applying permissions held across the organization or in part of it (docs/hub/HUB_GAPS.md G7)
export { allows, permissionMatches, unitTree, type Access, type ScopedPermission, type Target, type UnitTree } from './access.js';

// Applications inside each other's pages (docs/hub/HUB_GAPS.md G5)
export { themeCss, launcherScriptUrl } from './embeds.js';

// Records in other applications (docs/hub/HUB_GAPS.md G8)
export { parseResourceUri, formatResourceUri, checkAccess, createAccessCheckHandler, type AccessCheckRequest, type AccessCheckResult } from './records.js';
