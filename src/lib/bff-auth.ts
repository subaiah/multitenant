/**
 * BFF Authentication Client
 * 
 * This module handles authentication with the BFF layer using httpOnly cookies.
 * The frontend never sees the actual tokens - they're managed entirely by the BFF.
 */

const BFF_URL = import.meta.env.VITE_BFF_URL || 'http://localhost:4000';

interface LoginCredentials {
  email: string;
  tenantSlug: string;
  password?: string;
}

interface UserInfo {
  id: string;
  email: string;
  name: string | null;
  userType: string;
}

interface TenantInfo {
  id: string;
  name: string;
  slug: string;
}

interface AuthResponse {
  user: UserInfo;
  tenant: TenantInfo;
  message: string;
}

interface SessionInfo {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

/**
 * Login with email and password
 */
export async function login(credentials: LoginCredentials): Promise<AuthResponse> {
  const response = await fetch(`${BFF_URL}/bff/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include', // Important: include cookies
    body: JSON.stringify(credentials),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Login failed');
  }

  return response.json();
}

/**
 * Refresh the access token
 */
export async function refresh(): Promise<void> {
  const response = await fetch(`${BFF_URL}/bff/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error('Token refresh failed');
  }
}

/**
 * Logout and clear all sessions
 */
export async function logout(): Promise<void> {
  const response = await fetch(`${BFF_URL}/bff/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error('Logout failed');
  }
}

/**
 * Get current authenticated user
 */
export async function getCurrentUser(): Promise<AuthResponse> {
  const response = await fetch(`${BFF_URL}/bff/auth/me`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error('Not authenticated');
  }

  return response.json();
}

/**
 * Check authentication status
 */
export async function checkAuthStatus(): Promise<{ isAuthenticated: boolean; hasRefreshToken: boolean }> {
  const response = await fetch(`${BFF_URL}/bff/auth/status`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    return { isAuthenticated: false, hasRefreshToken: false };
  }

  return response.json();
}

/**
 * Revoke all active sessions
 */
export async function revokeAllSessions(): Promise<void> {
  const response = await fetch(`${BFF_URL}/bff/auth/revoke-all`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error('Failed to revoke sessions');
  }
}

/**
 * Get active sessions
 */
export async function getActiveSessions(): Promise<{ sessions: SessionInfo[] }> {
  const response = await fetch(`${BFF_URL}/bff/auth/sessions`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error('Failed to get sessions');
  }

  return response.json();
}

/**
 * Make an authenticated API call with automatic token refresh
 */
export async function authenticatedFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  // Add credentials to include cookies
  const fetchOptions: RequestInit = {
    ...options,
    credentials: 'include',
    headers: {
      ...options.headers,
    },
  };

  let response = await fetch(url, fetchOptions);

  // If unauthorized, try to refresh token
  if (response.status === 401) {
    try {
      await refresh();
      // Retry the original request
      response = await fetch(url, fetchOptions);
    } catch (refreshError) {
      // Refresh failed, user needs to login again
      throw new Error('Session expired');
    }
  }

  return response;
}

/**
 * Setup automatic token refresh
 * Call this on app initialization
 */
export function setupAutoRefresh(intervalMs: number = 10 * 60 * 1000): () => void {
  // Refresh token every interval (default: 10 minutes)
  const intervalId = setInterval(async () => {
    try {
      const status = await checkAuthStatus();
      if (status.isAuthenticated && status.hasRefreshToken) {
        await refresh();
      }
    } catch (error) {
      console.error('Auto-refresh failed:', error);
    }
  }, intervalMs);

  // Return cleanup function
  return () => clearInterval(intervalId);
}

/**
 * Check if user is authenticated (non-blocking)
 */
export async function isAuthenticated(): Promise<boolean> {
  try {
    const status = await checkAuthStatus();
    return status.isAuthenticated;
  } catch {
    return false;
  }
}
