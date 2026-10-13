/**
 * API Client with automatic token refresh
 * 
 * This utility makes authenticated API calls using httpOnly cookies
 * and automatically refreshes tokens when they expire.
 */

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const BFF_URL = import.meta.env.VITE_BFF_URL || 'http://localhost:4000';

interface ApiOptions extends RequestInit {
  skipAuth?: boolean;
}

/**
 * Refresh the access token using the refresh token
 */
async function refreshAccessToken(): Promise<boolean> {
  try {
    const response = await fetch(`${BFF_URL}/bff/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });

    return response.ok;
  } catch (error) {
    console.error('Token refresh failed:', error);
    return false;
  }
}

/**
 * Make an authenticated API request
 */
export async function apiRequest<T = any>(
  endpoint: string,
  options: ApiOptions = {}
): Promise<T> {
  const { skipAuth = false, ...fetchOptions } = options;

  const url = endpoint.startsWith('http') ? endpoint : `${API_URL}${endpoint}`;

  const response = await fetch(url, {
    ...fetchOptions,
    credentials: 'include', // Always include cookies for BFF authentication
    headers: {
      'Content-Type': 'application/json',
      ...fetchOptions.headers,
    },
  });

  // If unauthorized and not skipping auth, try to refresh token
  if (response.status === 401 && !skipAuth) {
    const refreshed = await refreshAccessToken();
    
    if (refreshed) {
      // Retry the original request
      const retryResponse = await fetch(url, {
        ...fetchOptions,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...fetchOptions.headers,
        },
      });

      if (!retryResponse.ok) {
        const error = await retryResponse.json().catch(() => ({ message: 'Request failed' }));
        throw new Error(error.message || `HTTP ${retryResponse.status}`);
      }

      return retryResponse.json();
    } else {
      // Refresh failed, redirect to login
      window.location.href = '/login';
      throw new Error('Session expired');
    }
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  // Handle empty responses (e.g., 204 No Content)
  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

/**
 * GET request helper
 */
export async function apiGet<T = any>(
  endpoint: string,
  options?: Omit<ApiOptions, 'method'>
): Promise<T> {
  return apiRequest<T>(endpoint, { ...options, method: 'GET' });
}

/**
 * POST request helper
 */
export async function apiPost<T = any>(
  endpoint: string,
  data?: any,
  options?: Omit<ApiOptions, 'method' | 'body'>
): Promise<T> {
  return apiRequest<T>(endpoint, {
    ...options,
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  });
}

/**
 * PUT request helper
 */
export async function apiPut<T = any>(
  endpoint: string,
  data?: any,
  options?: Omit<ApiOptions, 'method' | 'body'>
): Promise<T> {
  return apiRequest<T>(endpoint, {
    ...options,
    method: 'PUT',
    body: data ? JSON.stringify(data) : undefined,
  });
}

/**
 * PATCH request helper
 */
export async function apiPatch<T = any>(
  endpoint: string,
  data?: any,
  options?: Omit<ApiOptions, 'method' | 'body'>
): Promise<T> {
  return apiRequest<T>(endpoint, {
    ...options,
    method: 'PATCH',
    body: data ? JSON.stringify(data) : undefined,
  });
}

/**
 * DELETE request helper
 */
export async function apiDelete<T = any>(
  endpoint: string,
  options?: Omit<ApiOptions, 'method'>
): Promise<T> {
  return apiRequest<T>(endpoint, { ...options, method: 'DELETE' });
}

/**
 * Check if user is authenticated
 */
export async function checkAuth(): Promise<boolean> {
  try {
    const response = await apiGet<{ isAuthenticated: boolean }>('/bff/auth/status', {
      skipAuth: true,
    });
    return response.isAuthenticated;
  } catch {
    return false;
  }
}

/**
 * Get current user info
 */
export async function getCurrentUser() {
  return apiGet<{
    user: {
      id: string;
      email: string;
      name: string | null;
      userType: string;
    };
    tenant: {
      id: string;
      name: string;
      slug: string;
    };
  }>('/bff/auth/me');
}

/**
 * Logout
 */
export async function logout() {
  await apiPost('/bff/auth/logout');
  window.location.href = '/login';
}
