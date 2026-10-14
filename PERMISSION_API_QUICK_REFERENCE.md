# Permission API Quick Reference

## Base URL
```
http://localhost:4000
```

## Authentication
All endpoints require JWT authentication:
```
Authorization: Bearer <token>
```

---

## Endpoints

### 1. Get Enhanced Permissions
**Endpoint**: `GET /permissions`  
**Also available at**: `GET /auth/permissions`

**Description**: Get all user permissions with detailed metadata about sources.

**Response**:
```json
{
  "permissions": ["users:read", "users:write", "applications:read"],
  "sources": {
    "userType": "TENANT_ADMIN",
    "directRoles": ["Admin Role"],
    "groupRoles": ["Developer Group Role"],
    "delegations": []
  },
  "effectivePermissions": [
    {
      "permission": "users:read",
      "sources": ["userType", "role:Admin Role"]
    }
  ]
}
```

**Use Case**: Frontend needs to know not just what permissions a user has, but where they come from (for debugging, auditing, or UI decisions).

---

### 2. Get Simple Permissions
**Endpoint**: `GET /permissions/simple`

**Description**: Get a simple array of permission strings (backward compatibility).

**Response**:
```json
{
  "permissions": ["users:read", "users:write", "applications:read"]
}
```

**Use Case**: Simple permission checks where source information is not needed.

---

### 3. Check Specific Permission
**Endpoint**: `GET /permissions/check`

**Query Parameters**:
- `resource` (required): Resource name (e.g., "users", "applications")
- `action` (required): Action name (e.g., "read", "write", "delete")
- `scopeType` (optional): Scope type (TENANT, ORGANIZATION, ORG_UNIT, RESOURCE)
- `scopeId` (optional): Scope ID (UUID)

**Example**:
```
GET /permissions/check?resource=users&action=write&scopeType=TENANT&scopeId=123e4567-e89b-12d3-a456-426614174000
```

**Response**:
```json
{
  "hasPermission": true,
  "permission": "users:write"
}
```

**Use Case**: Quick check for a specific permission before performing an action.

---

### 4. Get User's Roles
**Endpoint**: `GET /permissions/roles`

**Description**: Get all roles assigned to the user (direct, group-based, delegated).

**Response**:
```json
{
  "directRoles": [
    {
      "id": "uuid",
      "name": "Admin Role",
      "description": "Full administrative access",
      "scopeType": "TENANT",
      "validFrom": "2024-01-01T00:00:00Z",
      "validTo": null
    }
  ],
  "groupRoles": [
    {
      "id": "uuid",
      "name": "Developer Role",
      "description": "Development permissions",
      "groupName": "Developers",
      "scopeType": "TENANT",
      "validFrom": "2024-01-01T00:00:00Z",
      "validTo": null
    }
  ],
  "delegatedRoles": [
    {
      "id": "uuid",
      "name": "Temporary Admin",
      "description": "Temporary admin access",
      "delegatedBy": "John Doe",
      "validTo": "2024-12-31T23:59:59Z"
    }
  ]
}
```

**Use Case**: Display user's roles in UI, audit role assignments, or debug permission issues.

---

### 5. Get User's Groups
**Endpoint**: `GET /permissions/groups`

**Description**: Get all groups the user belongs to.

**Response**:
```json
{
  "groups": [
    {
      "id": "uuid",
      "name": "Developers",
      "description": "Development team",
      "groupType": "MANUAL",
      "validFrom": "2024-01-01T00:00:00Z",
      "validTo": null
    }
  ]
}
```

**Use Case**: Display user's group memberships, manage group assignments, or debug group-based permissions.

---

## Permission String Format

Permissions follow the format: `resource:action`

### Examples:
- `users:read` - Read users
- `users:write` - Create/update users
- `users:delete` - Delete users
- `applications:read` - Read applications
- `applications:manage` - Full application management
- `*:*` - All permissions (super admin)
- `users:*` - All user actions
- `*:read` - Read all resources

### Standard Resources:
- `tenants` - Tenant management
- `users` - User management
- `groups` - Group management
- `roles` - Role management
- `applications` - Application management
- `organizations` - Organization management
- `settings` - Settings management
- `billing` - Billing management
- `platform` - Platform-level operations

### Standard Actions:
- `read` - View/list
- `write` - Create/update
- `delete` - Delete
- `manage` - Full control (read + write + delete)
- `admin` - Administrative access

---

## User Types

| User Type | Default Permissions | Description |
|-----------|-------------------|-------------|
| `PLATFORM_ADMIN` | `*:*` | Full platform access |
| `PLATFORM_USER` | `platform:read`, `tenants:read` | Platform read access |
| `TENANT_ADMIN` | `tenant:*` | Full tenant access |
| `TENANT_MANAGER` | `users:*`, `groups:*`, `roles:read` | User and group management |
| `TENANT_DEVELOPER` | `applications:*`, `users:read` | Application management |
| `TENANT_USER` | `applications:read`, `users:read` | Basic user access |
| `TENANT_VIEWER` | `*:read` | Read-only access |

---

## Frontend Integration

### React Hook
```typescript
import { usePermissions } from './hooks/usePermissions';

function MyComponent() {
  const { 
    permissions, 
    hasPermission, 
    hasAnyPermission, 
    hasAllPermissions,
    loading,
    error 
  } = usePermissions();

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;

  // Check single permission
  if (hasPermission('users:write')) {
    return <button>Edit User</button>;
  }

  // Check multiple permissions (OR)
  if (hasAnyPermission(['users:read', 'users:write'])) {
    return <div>Can view or edit users</div>;
  }

  // Check multiple permissions (AND)
  if (hasAllPermissions(['users:read', 'users:write'])) {
    return <div>Full user access</div>;
  }

  return null;
}
```

### Permission Guard
```typescript
import { PermissionGuard } from './components/PermissionGuard';

<PermissionGuard
  permission="admin:access"
  fallback={<div>Access Denied</div>}
>
  <AdminPanel />
</PermissionGuard>
```

### Permission Button
```typescript
import { PermissionButton } from './components/PermissionGuard';

<PermissionButton
  permission="users:delete"
  onClick={handleDelete}
  fallback={<button disabled>Delete (No Permission)</button>}
>
  Delete User
</PermissionButton>
```

---

## Error Responses

### 401 Unauthorized
```json
{
  "error": "Unauthorized",
  "message": "Invalid or expired token"
}
```

### 403 Forbidden
```json
{
  "error": "Forbidden",
  "message": "Insufficient permissions"
}
```

### 500 Internal Server Error
```json
{
  "error": "Internal Server Error",
  "message": "Failed to fetch permissions"
}
```

---

## Rate Limiting

All endpoints are subject to rate limiting:
- **Default**: 100 requests per minute per user
- **Configurable**: Via `RATE_LIMIT_MAX` and `RATE_LIMIT_TIME_WINDOW` environment variables

---

## Caching

### Frontend Cache
- Permissions are cached in the `usePermissions` hook
- Cache is invalidated on:
  - Permission changes
  - Role assignment changes
  - Group membership changes
  - Delegation changes
  - Token refresh

### Backend Cache
- Consider implementing Redis cache for high-traffic scenarios
- Cache key: `permissions:{userId}:{tenantId}`
- TTL: 5 minutes (configurable)

---

## Best Practices

### 1. Use Enhanced Endpoint for Debugging
Use `GET /permissions` to see where permissions come from when debugging access issues.

### 2. Use Simple Endpoint for Performance
Use `GET /permissions/simple` when you only need to check permissions and don't need source information.

### 3. Check Specific Permissions
Use `GET /permissions/check` for quick permission checks before performing actions.

### 4. Cache Permissions on Frontend
Use the `usePermissions` hook to cache permissions and reduce API calls.

### 5. Handle Loading States
Always handle loading states when checking permissions to provide good UX.

### 6. Provide Fallback UI
Use `PermissionGuard` and `PermissionButton` with fallback UI for denied access.

---

## Examples

### Example 1: Check Permission Before Action
```typescript
async function deleteUser(userId: string) {
  const response = await fetch('/permissions/check?resource=users&action=delete');
  const { hasPermission } = await response.json();
  
  if (!hasPermission) {
    alert('You do not have permission to delete users');
    return;
  }
  
  // Proceed with deletion
  await fetch(`/users/${userId}`, { method: 'DELETE' });
}
```

### Example 2: Conditional Rendering
```typescript
function UserList() {
  const { hasPermission } = usePermissions();
  
  return (
    <div>
      <h1>Users</h1>
      
      {hasPermission('users:write') && (
        <button>Create User</button>
      )}
      
      <UserTable />
    </div>
  );
}
```

### Example 3: Debug Permission Issues
```typescript
async function debugPermissions() {
  const response = await fetch('/permissions');
  const data = await response.json();
  
  console.log('User Type:', data.sources.userType);
  console.log('Direct Roles:', data.sources.directRoles);
  console.log('Group Roles:', data.sources.groupRoles);
  console.log('Delegations:', data.sources.delegations);
  console.log('All Permissions:', data.permissions);
  console.log('Permission Sources:', data.effectivePermissions);
}
```

---

## Troubleshooting

### Issue: Permission check returns false unexpectedly
**Solution**:
1. Call `GET /permissions` to see all permissions
2. Check if the permission string matches exactly (case-sensitive)
3. Verify user type and role assignments
4. Check time-based validity (validFrom/validTo)
5. Verify scope compatibility

### Issue: Permissions not updating after role change
**Solution**:
1. Clear frontend permission cache
2. Refresh the page
3. Verify role assignment is active
4. Check database for correct role-permission mappings

### Issue: Slow permission checks
**Solution**:
1. Use `GET /permissions/simple` instead of `GET /permissions`
2. Implement backend caching (Redis)
3. Optimize database queries
4. Reduce number of permission checks per page

---

## API Documentation

Full API documentation is available at:
```
http://localhost:4000/docs
```

Swagger UI provides interactive API testing and detailed schema information.

---

**Last Updated**: 2026-01-XX  
**Version**: 1.0  
**Status**: Production Ready ✅
