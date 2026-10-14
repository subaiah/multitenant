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
}

// One refresh at a time: refresh tokens rotate, so two parallel refreshes
// would present the same token twice and trip reuse detection (logging the
// user out everywhere).
let refreshInFlight: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  refreshInFlight ??= fetch(`${API_URL}/bff/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

async function send(url: string, options: RequestInit): Promise<Response> {
  const headers = new Headers(options.headers);
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
  const { skipAuth = false, ...fetchOptions } = options;
  const url = endpoint.startsWith('http') ? endpoint : `${API_URL}${endpoint}`;

  const response = await send(url, fetchOptions);
  if (response.status !== 401 || skipAuth) {
    return parse<T>(response);
  }

  if (!(await refreshSession())) {
    throw new AuthError();
  }
  const retry = await send(url, fetchOptions);
  if (retry.status === 401) {
    throw new AuthError();
  }
  return parse<T>(retry);
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
  tenant: { id: string; name: string; slug: string } | null;
}

export function getCurrentUser() {
  return apiGet<CurrentUser>('/bff/auth/me');
}

/** Ends the session server-side and clears the cookies. */
export async function logout() {
  await apiPost('/bff/auth/logout', undefined, { skipAuth: true });
}
