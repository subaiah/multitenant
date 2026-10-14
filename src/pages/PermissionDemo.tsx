import { PermissionGuard, PermissionButton } from '../components/PermissionGuard';
import { usePermissions } from '../hooks/usePermissions';

export default function PermissionDemo() {
  const { permissions, hasPermission, loading } = usePermissions();

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-slate-200 dark:bg-slate-700 rounded w-1/4"></div>
          <div className="h-32 bg-slate-200 dark:bg-slate-700 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
          Permission System Demo
        </h1>
        <p className="text-slate-600 dark:text-slate-400">
          This page demonstrates the permission-based access control system.
        </p>
      </div>

      {/* Current Permissions */}
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">
          Your Current Permissions
        </h2>
        <div className="flex flex-wrap gap-2">
          {permissions.length === 0 ? (
            <p className="text-slate-500 dark:text-slate-400">No permissions assigned</p>
          ) : (
            permissions.map((perm) => (
              <span
                key={perm}
                className="px-3 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full text-sm font-medium"
              >
                {perm}
              </span>
            ))
          )}
        </div>
      </div>

      {/* Permission Guard Examples */}
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">
          Permission Guard Examples
        </h2>

        <div className="space-y-4">
          {/* Single Permission */}
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-4">
            <h3 className="font-medium text-slate-900 dark:text-white mb-2">
              Single Permission Check
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
              Requires: <code className="bg-slate-100 dark:bg-slate-900 px-2 py-1 rounded">users:read</code>
            </p>
            <PermissionGuard permission="users:read" fallback={
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-red-800 dark:text-red-200">
                  ⚠️ Access Denied: You don't have permission to view this content.
                </p>
              </div>
            }>
              <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                <p className="text-green-800 dark:text-green-200">
                  ✅ Success: You have permission to view this content!
                </p>
              </div>
            </PermissionGuard>
          </div>

          {/* Any Of Permissions (OR) */}
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-4">
            <h3 className="font-medium text-slate-900 dark:text-white mb-2">
              Any Of Permissions (OR Logic)
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
              Requires any of: <code className="bg-slate-100 dark:bg-slate-900 px-2 py-1 rounded">users:read</code> OR <code className="bg-slate-100 dark:bg-slate-900 px-2 py-1 rounded">users:write</code>
            </p>
            <PermissionGuard anyOf={['users:read', 'users:write']} fallback={
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-red-800 dark:text-red-200">
                  ⚠️ Access Denied: You need at least one of the required permissions.
                </p>
              </div>
            }>
              <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                <p className="text-green-800 dark:text-green-200">
                  ✅ Success: You have at least one of the required permissions!
                </p>
              </div>
            </PermissionGuard>
          </div>

          {/* All Of Permissions (AND) */}
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-4">
            <h3 className="font-medium text-slate-900 dark:text-white mb-2">
              All Of Permissions (AND Logic)
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
              Requires all of: <code className="bg-slate-100 dark:bg-slate-900 px-2 py-1 rounded">users:read</code> AND <code className="bg-slate-100 dark:bg-slate-900 px-2 py-1 rounded">users:write</code>
            </p>
            <PermissionGuard allOf={['users:read', 'users:write']} fallback={
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-red-800 dark:text-red-200">
                  ⚠️ Access Denied: You need all of the required permissions.
                </p>
              </div>
            }>
              <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                <p className="text-green-800 dark:text-green-200">
                  ✅ Success: You have all of the required permissions!
                </p>
              </div>
            </PermissionGuard>
          </div>
        </div>
      </div>

      {/* Permission Button Examples */}
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">
          Permission Button Examples
        </h2>

        <div className="flex flex-wrap gap-3">
          <PermissionButton
            permission="users:create"
            onClick={() => alert('Create user clicked!')}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
          >
            Create User
          </PermissionButton>

          <PermissionButton
            permission="users:delete"
            onClick={() => alert('Delete user clicked!')}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
            fallback={
              <button
                disabled
                className="px-4 py-2 bg-slate-300 dark:bg-slate-700 text-slate-500 dark:text-slate-400 rounded-lg cursor-not-allowed"
                title="You don't have permission to delete users"
              >
                Delete User (No Permission)
              </button>
            }
          >
            Delete User
          </PermissionButton>

          <PermissionButton
            anyOf={['admin:access', 'superadmin:access']}
            onClick={() => alert('Admin action clicked!')}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
          >
            Admin Action
          </PermissionButton>
        </div>
      </div>

      {/* Permission Check Examples */}
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">
          Programmatic Permission Checks
        </h2>

        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
            <span className="text-slate-700 dark:text-slate-300">hasPermission('users:read')</span>
            <span className={`font-mono ${hasPermission('users:read') ? 'text-green-600' : 'text-red-600'}`}>
              {hasPermission('users:read') ? 'true' : 'false'}
            </span>
          </div>

          <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
            <span className="text-slate-700 dark:text-slate-300">hasPermission('admin:access')</span>
            <span className={`font-mono ${hasPermission('admin:access') ? 'text-green-600' : 'text-red-600'}`}>
              {hasPermission('admin:access') ? 'true' : 'false'}
            </span>
          </div>

          <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
            <span className="text-slate-700 dark:text-slate-300">hasPermission('*')</span>
            <span className={`font-mono ${hasPermission('*') ? 'text-green-600' : 'text-red-600'}`}>
              {hasPermission('*') ? 'true' : 'false'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
