# Phase 4 & 5 Quick Reference

## Route Protection

### Basic Route Guard
```typescript
import { PermissionGuard } from './components/PermissionGuard';

<Route path="/users" element={
  <PermissionGuard permission="users:read" redirectTo="/unauthorized">
    <UsersPage />
  </PermissionGuard>
} />
```

### Multiple Permissions (OR)
```typescript
<PermissionGuard anyOf={['users:read', 'users:write']}>
  <UsersPage />
</PermissionGuard>
```

### Multiple Permissions (AND)
```typescript
<PermissionGuard allOf={['users:read', 'users:write']}>
  <UsersPage />
</PermissionGuard>
```

### With Fallback UI
```typescript
<PermissionGuard 
  permission="admin:access"
  fallback={<div>Access Denied</div>}
>
  <AdminPanel />
</PermissionGuard>
```

---

## Action Buttons

### Basic Permission Button
```typescript
import { PermissionButton } from './components/PermissionGuard';

<PermissionButton
  permission="users:delete"
  onClick={handleDelete}
  className="btn-danger"
>
  Delete User
</PermissionButton>
```

### With Fallback
```typescript
<PermissionButton
  permission="users:delete"
  onClick={handleDelete}
  fallback={
    <button disabled title="No permission">
      Delete (No Permission)
    </button>
  }
>
  Delete User
</PermissionButton>
```

### Multiple Permissions
```typescript
<PermissionButton
  anyOf={['users:delete', 'admin:access']}
  onClick={handleDelete}
>
  Delete User
</PermissionButton>
```

---

## Conditional Links

```typescript
import { PermissionLink } from './components/PermissionGuard';

<PermissionLink
  permission="users:edit"
  href={`/users/${userId}/edit`}
  className="text-blue-600"
>
  Edit User
</PermissionLink>
```

---

## Permission Hook

```typescript
import { usePermissions } from './hooks/usePermissions';

const { 
  permissions,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  loading
} = usePermissions();

// Check single permission
if (hasPermission('users:read')) {
  // Show users
}

// Check any permission
if (hasAnyPermission(['users:read', 'users:write'])) {
  // Show users section
}

// Check all permissions
if (hasAllPermissions(['users:read', 'users:write'])) {
  // Show full access
}
```

---

## Common Permission Patterns

### Read-Only Access
```typescript
<PermissionGuard permission="users:read">
  <UsersList />
</PermissionGuard>
```

### Create Action
```typescript
<PermissionButton permission="users:create" onClick={handleCreate}>
  Create User
</PermissionButton>
```

### Update Action
```typescript
<PermissionButton permission="users:update" onClick={handleUpdate}>
  Update User
</PermissionButton>
```

### Delete Action
```typescript
<PermissionButton permission="users:delete" onClick={handleDelete}>
  Delete User
</PermissionButton>
```

### Full Management
```typescript
<PermissionButton permission="users:manage" onClick={handleManage}>
  Manage Users
</PermissionButton>
```

---

## Protected Routes Table

### Platform Portal
| Route | Permission |
|-------|-----------|
| `/platform/dashboard` | `PLATFORM_ADMIN` or `PLATFORM_USER` |
| `/platform/tenants` | `tenants:read` |
| `/platform/applications` | `applications:read` |
| `/platform/users` | `platform:users:read` |
| `/platform/policies` | `policies:read` |
| `/platform/settings` | `platform:settings:manage` |

### Tenant Portal
| Route | Permission |
|-------|-----------|
| `/dashboard` | `tenant:read` or `dashboard:view` |
| `/profile` | `profile:read` |
| `/applications` | `applications:read` |
| `/activity` | `activity:read` |
| `/infrastructure` | `infrastructure:read` |
| `/data-isolation` | `database:manage` |
| `/authentication` | `auth:manage` |
| `/api` | `api:manage` |
| `/groups` | `groups:read` |
| `/role-assignments` | `roles:read` |
| `/organizations` | `organizations:read` |
| `/tenant-entitlements` | `applications:manage` |
| `/settings` | `settings:manage` |

---

## Permission Naming

### Format: `resource:action`

**Resources:**
- `tenants`, `users`, `groups`, `roles`
- `applications`, `organizations`, `settings`
- `activity`, `infrastructure`, `database`
- `auth`, `api`, `policies`, `profile`
- `dashboard`, `platform`

**Actions:**
- `read` - View/list
- `write` - Create/update
- `delete` - Delete
- `manage` - Full control
- `create` - Create only
- `update` - Update only

**Examples:**
```
users:read
users:write
users:delete
users:manage
groups:create
organizations:update
applications:manage
platform:users:read
```

---

## User Type Permissions

| User Type | Permissions |
|-----------|-------------|
| `PLATFORM_ADMIN` | `*:*` (all) |
| `PLATFORM_USER` | `platform:read`, `tenants:read` |
| `TENANT_ADMIN` | `tenant:*` (all tenant) |
| `TENANT_MANAGER` | `users:*`, `groups:*`, `roles:read` |
| `TENANT_DEVELOPER` | `applications:*`, `users:read` |
| `TENANT_USER` | `applications:read`, `users:read` |
| `TENANT_VIEWER` | `*:read` (read-only) |

---

## Testing Checklist

### Route Protection
- [ ] Login as PLATFORM_ADMIN → Access all platform routes
- [ ] Login as TENANT_ADMIN → Access all tenant routes
- [ ] Login as TENANT_USER → Access only read routes
- [ ] Try unauthorized route → Redirect to /unauthorized
- [ ] Check Unauthorized page displays correctly

### Action Buttons
- [ ] User with permission → Button visible
- [ ] User without permission → Button hidden or disabled
- [ ] Check fallback UI displays correctly
- [ ] Verify button actions work when permitted
- [ ] Test with different user types

### Permission Hook
- [ ] hasPermission() returns correct values
- [ ] hasAnyPermission() works with OR logic
- [ ] hasAllPermissions() works with AND logic
- [ ] Loading state handled correctly
- [ ] Error state handled correctly

---

## Troubleshooting

### Button Not Showing
1. Check user has permission
2. Verify permission string matches
3. Check browser console for errors
4. Verify backend returns permissions

### Route Redirects to Unauthorized
1. Check user has required permission
2. Verify permission string in route
3. Check backend permission assignment
4. Clear cache and reload

### Permission Check Returns False
1. Verify user is logged in
2. Check if permissions are loaded
3. Verify permission string format
4. Check backend API response

---

## Best Practices

✅ **DO:**
- Always check permissions on backend
- Use specific permission strings
- Provide fallback UI
- Handle loading states
- Test with different user types

❌ **DON'T:**
- Rely only on frontend checks
- Use vague permissions
- Skip error handling
- Forget to test edge cases
- Hardcode permission strings

---

## Quick Examples

### Protect a Page
```typescript
<PermissionGuard permission="users:read" redirectTo="/unauthorized">
  <UsersPage />
</PermissionGuard>
```

### Conditional Button
```typescript
<PermissionButton permission="users:delete" onClick={handleDelete}>
  Delete
</PermissionButton>
```

### Programmatic Check
```typescript
const { hasPermission } = usePermissions();

{hasPermission('users:write') && <EditButton />}
```

---

**Status**: ✅ COMPLETE  
**Ready for**: Testing & Build Stabilization
