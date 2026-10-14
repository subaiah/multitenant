import { useState, useEffect, useCallback } from 'react';
import { apiGet } from '../lib/api-client';

interface UsePermissionsResult {
  permissions: string[];
  loading: boolean;
  error: string | null;
  hasPermission: (permission: string) => boolean;
  hasAnyPermission: (permissions: string[]) => boolean;
  hasAllPermissions: (permissions: string[]) => boolean;
  refreshPermissions: () => Promise<void>;
}

export function usePermissions(): UsePermissionsResult {
  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPermissions = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiGet<{ permissions: string[] }>('/auth/permissions');
      setPermissions(response.permissions);
    } catch (err) {
      console.error('Failed to fetch permissions:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch permissions');
      setPermissions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPermissions();
  }, [fetchPermissions]);

  const hasPermission = useCallback(
    (permission: string): boolean => {
      // Wildcard permission check
      if (permissions.includes('*')) {
        return true;
      }

      // Exact match
      if (permissions.includes(permission)) {
        return true;
      }

      // Wildcard resource check (e.g., "users:*")
      const [resource] = permission.split(':');
      if (permissions.includes(`${resource}:*`)) {
        return true;
      }

      // Wildcard action check (e.g., "*:read")
      const [, action] = permission.split(':');
      if (permissions.includes(`*:${action}`)) {
        return true;
      }

      return false;
    },
    [permissions]
  );

  const hasAnyPermission = useCallback(
    (permissionList: string[]): boolean => {
      return permissionList.some((perm) => hasPermission(perm));
    },
    [hasPermission]
  );

  const hasAllPermissions = useCallback(
    (permissionList: string[]): boolean => {
      return permissionList.every((perm) => hasPermission(perm));
    },
    [hasPermission]
  );

  return {
    permissions,
    loading,
    error,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    refreshPermissions: fetchPermissions,
  };
}
