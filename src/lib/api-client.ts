/**
 * API client.
 *
 * Authentication is entirely cookie-based: /bff/auth/login sets httpOnly
 * `access_token` and `refresh_token` cookies, and every request sends them
 * (`credentials: 'include'`). The tenant comes from the access token, so no
 * tenant header is needed.
 *
 * On a 401 the client refreshes the access token once and retries. If that
 * fails it throws `AuthError`; the AuthContext / route guards decide where to
 * send the user (this module never navigates).
 */

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The session is gone (refresh failed); the user needs to log in again. */
export class AuthError extends ApiError {
  constructor() {
    super('Session expired', 401);
    this.name = 'AuthError';
  }
}

interface ApiOptions extends RequestInit {
  /** Don't try to refresh the session on 401 (login/public endpoints). */
  skipAuth?: boolean;
  /**
   * A request the page makes by itself (polling), not the user: it doesn't
   * count as activity for the idle timeout, and on 401 it doesn't renew the
   * session (the user's next action does).
   */
  background?: boolean;
}

// One refresh at a time: refresh tokens rotate, so two parallel refreshes
// would present the same token twice and trip reuse detection (logging the
// user out everywhere).
let refreshInFlight: Promise<boolean> | null = null;
/** Why the last refresh was refused, when the server said (SESSION_IDLE, SESSION_MAX). */
let endReason: string | undefined;

function refreshSession(): Promise<boolean> {
  refreshInFlight ??= fetch(`${API_URL}/bff/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) endReason = ((await res.json().catch(() => ({}))) as { code?: string }).code;
      return res.ok;
    })
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/**
 * Platform staff working in a tenant through a support session: every request
 * names that tenant (x-tenant-id) while the support workspace is open.
 */
let actingTenantId: string | null = null;
export function setActingTenant(tenantId: string | null) {
  actingTenantId = tenantId;
}

async function send(url: string, options: RequestInit): Promise<Response> {
  const headers = new Headers(options.headers);
  if (actingTenantId && !headers.has('x-tenant-id')) headers.set('x-tenant-id', actingTenantId);
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, { ...options, headers, credentials: 'include' });
}

async function parse<T>(response: Response): Promise<T> {
  if (response.status === 204) return {} as T;
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new ApiError(body?.message || body?.error || `HTTP ${response.status}`, response.status, body);
  }
  return body as T;
}

export async function apiRequest<T = any>(endpoint: string, options: ApiOptions = {}): Promise<T> {
  const { skipAuth = false, background = false, ...fetchOptions } = options;
  const url = endpoint.startsWith('http') ? endpoint : `${API_URL}${endpoint}`;
  if (background) fetchOptions.headers = { ...(fetchOptions.headers as Record<string, string>), 'x-background-request': '1' };

  const response = await send(url, fetchOptions);
  if (response.status !== 401 || skipAuth || background) {
    return parse<T>(response);
  }

  if (!(await refreshSession())) {
    sessionEnded();
    throw new AuthError();
  }
  const retry = await send(url, fetchOptions);
  if (retry.status === 401) {
    sessionEnded();
    throw new AuthError();
  }
  return parse<T>(retry);
}

/**
 * The server refused the session and it couldn't be renewed: the account was
 * deactivated or removed, or the user signed out everywhere. AuthContext
 * listens for this and sends the user to the sign-in page.
 */
export const SESSION_ENDED_EVENT = 'auth:session-ended';
/** Why a session ended, for the sign-in page's notice. */
export type SessionEndReason = 'idle' | 'max' | 'signed-out';
function sessionEnded() {
  const reason: SessionEndReason = endReason === 'SESSION_IDLE' ? 'idle' : endReason === 'SESSION_MAX' ? 'max' : 'signed-out';
  endReason = undefined;
  window.dispatchEvent(new CustomEvent<SessionEndReason>(SESSION_ENDED_EVENT, { detail: reason }));
}

export function apiGet<T = any>(endpoint: string, options?: Omit<ApiOptions, 'method'>): Promise<T> {
  return apiRequest<T>(endpoint, { ...options, method: 'GET' });
}

export function apiPost<T = any>(endpoint: string, data?: unknown, options?: Omit<ApiOptions, 'method' | 'body'>): Promise<T> {
  return apiRequest<T>(endpoint, { ...options, method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) });
}

export function apiPut<T = any>(endpoint: string, data?: unknown, options?: Omit<ApiOptions, 'method' | 'body'>): Promise<T> {
  return apiRequest<T>(endpoint, { ...options, method: 'PUT', body: data === undefined ? undefined : JSON.stringify(data) });
}

export function apiPatch<T = any>(endpoint: string, data?: unknown, options?: Omit<ApiOptions, 'method' | 'body'>): Promise<T> {
  return apiRequest<T>(endpoint, { ...options, method: 'PATCH', body: data === undefined ? undefined : JSON.stringify(data) });
}

export function apiDelete<T = any>(endpoint: string, options?: Omit<ApiOptions, 'method'>): Promise<T> {
  return apiRequest<T>(endpoint, { ...options, method: 'DELETE' });
}

export interface CurrentUser {
  user: {
    id: string;
    email: string;
    name: string | null;
    userType: string;
    portal: 'PLATFORM' | 'TENANT';
  };
  tenant: { id: string; name: string; slug: string; primaryColor?: string | null; logoUrl?: string | null } | null;
  /** Optional parts of the app this server shows (PREVIEW_FEATURES) */
  features?: { preview: boolean };
}

export function getCurrentUser() {
  return apiGet<CurrentUser>('/bff/auth/me');
}

/** What a sign-in step returns when two-factor comes next (no session yet). */
export interface MfaStep {
  mfa: 'verify' | 'enroll';
  mfaToken: string;
}
export const isMfaStep = (body: unknown): body is MfaStep =>
  !!body && typeof body === 'object' && 'mfa' in body && 'mfaToken' in body;

/** Ends the session server-side and clears the cookies. */
export async function logout() {
  await apiPost('/bff/auth/logout', undefined, { skipAuth: true });
}
