import { useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';

interface UsePermissionsResult {
  permissions: string[];
  loading: boolean;
  error: string | null;
  hasPermission: (permission: string) => boolean;
  hasAnyPermission: (permissions: string[]) => boolean;
  hasAllPermissions: (permissions: string[]) => boolean;
  refreshPermissions: () => Promise<void>;
}

/**
 * Permissions for the signed-in user. They are loaded once by AuthContext
 * (not per component), and matched with the same wildcard rules as the backend.
 */
export function usePermissions(): UsePermissionsResult {
  const { permissions, loading, hasPermission, reload } = useAuth();

  const hasAnyPermission = useCallback((list: string[]) => list.some(hasPermission), [hasPermission]);
  const hasAllPermissions = useCallback((list: string[]) => list.every(hasPermission), [hasPermission]);
  const refreshPermissions = useCallback(async () => {
    await reload();
  }, [reload]);

  return { permissions, loading, error: null, hasPermission, hasAnyPermission, hasAllPermissions, refreshPermissions };
}
