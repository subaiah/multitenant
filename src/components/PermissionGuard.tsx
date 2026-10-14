import { ReactNode } from 'react';
import { usePermissions } from '../hooks/usePermissions';
import { Navigate } from 'react-router-dom';

interface PermissionGuardProps {
  /** Single permission required */
  permission?: string;
  /** Multiple permissions - user needs at least one */
  anyOf?: string[];
  /** Multiple permissions - user needs all of them */
  allOf?: string[];
  /** Children to render if permission check passes */
  children: ReactNode;
  /** Fallback component to render if permission check fails */
  fallback?: ReactNode;
  /** If true, redirect to this path instead of showing fallback */
  redirectTo?: string;
}

/**
 * PermissionGuard - Protects routes and components based on user permissions
 * 
 * @example
 * // Single permission
 * <PermissionGuard permission="users:read">
 *   <UsersPage />
 * </PermissionGuard>
 * 
 * @example
 * // Any of permissions (OR logic)
 * <PermissionGuard anyOf={['users:read', 'users:write']}>
 *   <UsersPage />
 * </PermissionGuard>
 * 
 * @example
 * // All permissions required (AND logic)
 * <PermissionGuard allOf={['users:read', 'users:write']}>
 *   <UsersPage />
 * </PermissionGuard>
 * 
 * @example
 * // With fallback
 * <PermissionGuard 
 *   permission="admin:access" 
 *   fallback={<div>Access Denied</div>}
 * >
 *   <AdminPanel />
 * </PermissionGuard>
 * 
 * @example
 * // With redirect
 * <PermissionGuard 
 *   permission="admin:access" 
 *   redirectTo="/unauthorized"
 * >
 *   <AdminPanel />
 * </PermissionGuard>
 */
export function PermissionGuard({
  permission,
  anyOf,
  allOf,
  children,
  fallback,
  redirectTo,
}: PermissionGuardProps) {
  const { hasPermission, hasAnyPermission, hasAllPermissions, loading } = usePermissions();

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  let hasAccess = false;

  if (permission) {
    hasAccess = hasPermission(permission);
  } else if (anyOf && anyOf.length > 0) {
    hasAccess = hasAnyPermission(anyOf);
  } else if (allOf && allOf.length > 0) {
    hasAccess = hasAllPermissions(allOf);
  } else {
    // No permission requirements, allow access
    hasAccess = true;
  }

  if (!hasAccess) {
    if (redirectTo) {
      return <Navigate to={redirectTo} replace />;
    }

    if (fallback) {
      return <>{fallback}</>;
    }

    // Default fallback: render nothing
    return null;
  }

  return <>{children}</>;
}

interface PermissionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Single permission required */
  permission?: string;
  /** Multiple permissions - user needs at least one */
  anyOf?: string[];
  /** Multiple permissions - user needs all of them */
  allOf?: string[];
  /** Fallback component to render if permission check fails */
  fallback?: ReactNode;
}

/**
 * PermissionButton - A button that only renders if user has required permissions
 * 
 * @example
 * <PermissionButton 
 *   permission="users:delete"
 *   onClick={handleDelete}
 *   className="btn-danger"
 * >
 *   Delete User
 * </PermissionButton>
 */
export function PermissionButton({
  permission,
  anyOf,
  allOf,
  fallback,
  children,
  ...buttonProps
}: PermissionButtonProps) {
  const { hasPermission, hasAnyPermission, hasAllPermissions, loading } = usePermissions();

  if (loading) {
    return null;
  }

  let hasAccess = false;

  if (permission) {
    hasAccess = hasPermission(permission);
  } else if (anyOf && anyOf.length > 0) {
    hasAccess = hasAnyPermission(anyOf);
  } else if (allOf && allOf.length > 0) {
    hasAccess = hasAllPermissions(allOf);
  } else {
    hasAccess = true;
  }

  if (!hasAccess) {
    return fallback ? <>{fallback}</> : null;
  }

  return <button {...buttonProps}>{children}</button>;
}

interface PermissionLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  /** Single permission required */
  permission?: string;
  /** Multiple permissions - user needs at least one */
  anyOf?: string[];
  /** Multiple permissions - user needs all of them */
  allOf?: string[];
  /** Fallback component to render if permission check fails */
  fallback?: ReactNode;
}

/**
 * PermissionLink - A link that only renders if user has required permissions
 * 
 * @example
 * <PermissionLink 
 *   permission="users:edit"
 *   href="/users/123/edit"
 * >
 *   Edit User
 * </PermissionLink>
 */
export function PermissionLink({
  permission,
  anyOf,
  allOf,
  fallback,
  children,
  ...linkProps
}: PermissionLinkProps) {
  const { hasPermission, hasAnyPermission, hasAllPermissions, loading } = usePermissions();

  if (loading) {
    return null;
  }

  let hasAccess = false;

  if (permission) {
    hasAccess = hasPermission(permission);
  } else if (anyOf && anyOf.length > 0) {
    hasAccess = hasAnyPermission(anyOf);
  } else if (allOf && allOf.length > 0) {
    hasAccess = hasAllPermissions(allOf);
  } else {
    hasAccess = true;
  }

  if (!hasAccess) {
    return fallback ? <>{fallback}</> : null;
  }

  return <a {...linkProps}>{children}</a>;
}
