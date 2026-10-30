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
