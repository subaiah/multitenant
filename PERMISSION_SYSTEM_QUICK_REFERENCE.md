# Permission System Quick Reference

## 🚀 Quick Start

### 1. Check Permissions in Component
```typescript
import { usePermissions } from '../hooks/usePermissions';

function MyComponent() {
  const { hasPermission, loading } = usePermissions();

  if (loading) return <div>Loading...</div>;

  if (!hasPermission('users:read')) {
    return <div>Access Denied</div>;
  }

  return <div>Users List</div>;
}
```

### 2. Protect a Route
```typescript
import { PermissionGuard } from '../components/PermissionGuard';

function App() {
  return (
    <PermissionGuard permission="users:read" redirectTo="/unauthorized">
      <UsersPage />
    </PermissionGuard>
  );
}
```

### 3. Conditional Button
```typescript
import { PermissionButton } from '../components/PermissionGuard';

function UserActions() {
  return (
    <PermissionButton
      permission="users:delete"
      onClick={handleDelete}
      fallback={<button disabled>No Permission</button>}
    >
      Delete User
    </PermissionButton>
  );
}
```

---

## 📚 API Reference

### usePermissions Hook

```typescript
const {
  permissions,           // string[] - User's permissions
  loading,               // boolean - Loading state
  error,                 // string | null - Error message
  hasPermission,         // (perm: string) => boolean
  hasAnyPermission,      // (perms: string[]) => boolean
  hasAllPermissions,     // (perms: string[]) => boolean
  refreshPermissions,    // () => Promise<void>
} = usePermissions();
```

#### hasPermission(permission: string)
Check if user has a specific permission.

```typescript
hasPermission('users:read')        // Exact match
hasPermission('users:*')           // Wildcard resource
hasPermission('*:read')            // Wildcard action
hasPermission('*')                 // Full wildcard
```

#### hasAnyPermission(permissions: string[])
Check if user has ANY of the permissions (OR logic).

```typescript
hasAnyPermission(['users:read', 'users:write'])
// Returns true if user has users:read OR users:write
```

#### hasAllPermissions(permissions: string[])
Check if user has ALL of the permissions (AND logic).

```typescript
hasAllPermissions(['users:read', 'users:write'])
// Returns true if user has users:read AND users:write
```

#### refreshPermissions()
Manually refresh permissions from backend.

```typescript
await refreshPermissions();
```

---

### PermissionGuard Component

```typescript
<PermissionGuard
  permission="users:read"           // Single permission
  anyOf={['users:read', 'admin']}  // OR logic
  allOf={['users:read', 'write']}  // AND logic
  fallback={<div>Denied</div>}      // Fallback UI
  redirectTo="/unauthorized"        // Redirect path
>
  <ProtectedContent />
</PermissionGuard>
```

**Props**:
- `permission?: string` - Single required permission
- `anyOf?: string[]` - Any of these permissions (OR)
- `allOf?: string[]` - All of these permissions (AND)
- `fallback?: ReactNode` - UI to show if no access
- `redirectTo?: string` - Path to redirect if no access
- `children: ReactNode` - Content to protect

**Priority**: `permission` > `anyOf` > `allOf`

---

### PermissionButton Component

```typescript
<PermissionButton
  permission="users:delete"
  anyOf={['users:delete', 'admin']}
  allOf={['users:read', 'users:delete']}
  fallback={<button disabled>No Access</button>}
  onClick={handleClick}
  className="btn-danger"
>
  Delete User
</PermissionButton>
```

**Props**: All standard button props + permission props

---

### PermissionLink Component

```typescript
<PermissionLink
  permission="users:edit"
  href="/users/123/edit"
  className="text-blue-600"
>
  Edit User
</PermissionLink>
```

**Props**: All standard anchor props + permission props

---

## 🎯 Common Patterns

### Pattern 1: Show/Hide Content
```typescript
const { hasPermission } = usePermissions();

{hasPermission('reports:view') && <ReportsWidget />}
```

### Pattern 2: Multiple Conditions
```typescript
const { hasAnyPermission } = usePermissions();

{hasAnyPermission(['users:read', 'users:write']) && (
  <UsersSection />
)}
```

### Pattern 3: Disable Instead of Hide
```typescript
const { hasPermission } = usePermissions();

<button disabled={!hasPermission('users:delete')}>
  Delete User
</button>
```

### Pattern 4: Route Protection
```typescript
<Route
  path="/admin"
  element={
    <PermissionGuard permission="admin:access" redirectTo="/unauthorized">
      <AdminPage />
    </PermissionGuard>
  }
/>
```

### Pattern 5: Conditional Rendering with Fallback
```typescript
<PermissionGuard
  permission="users:edit"
  fallback={
    <div className="alert">
      You don't have permission to edit users
    </div>
  }
>
  <EditUserForm />
</PermissionGuard>
```

---

## 🔐 Permission Naming Convention

### Format: `resource:action`

**Resources**:
- `users` - User management
- `groups` - Group management
- `roles` - Role management
- `tenants` - Tenant management
- `applications` - Application management
- `organizations` - Organization management
- `settings` - Settings management
- `reports` - Reports and analytics
- `admin` - Administrative functions

**Actions**:
- `read` - View/list
- `write` - Create/update
- `delete` - Delete
- `manage` - Full control (read + write + delete)
- `admin` - Administrative access

**Examples**:
```
users:read          - View users list
users:write         - Create/update users
users:delete        - Delete users
users:manage        - Full user management
groups:read         - View groups
applications:read   - View applications
admin:access        - Access admin panel
```

---

## 🎨 Menu Item Configuration

### Database Schema
```prisma
model MenuItem {
  id              String    @id @default(uuid())
  portal          String    // PLATFORM, TENANT
  parentId        String?   @map("parent_id")
  label           String
  path            String
  icon            String?
  permission      String?   // Required permission
  order           Int       @default(0)
  isActive        Boolean   @default(true)
}
```

### Example: Create Menu Item
```typescript
// Via API
POST /menu-items
{
  "portal": "TENANT",
  "label": "User Management",
  "path": "/users",
  "icon": "Users",
  "permission": "users:read",
  "order": 2,
  "isActive": true
}
```

### Example: Nested Menu
```typescript
// Parent
{
  "portal": "TENANT",
  "label": "Users",
  "path": "/users",
  "icon": "Users",
  "permission": "users:read",
  "order": 2
}

// Child 1
{
  "portal": "TENANT",
  "parentId": "parent-uuid",
  "label": "All Users",
  "path": "/users",
  "permission": "users:read",
  "order": 0
}

// Child 2
{
  "portal": "TENANT",
  "parentId": "parent-uuid",
  "label": "Groups",
  "path": "/groups",
  "permission": "groups:read",
  "order": 1
}
```

---

## 🧪 Testing

### Test Permission Hook
```typescript
import { renderHook } from '@testing-library/react';
import { usePermissions } from './usePermissions';

test('should fetch permissions', async () => {
  const { result } = renderHook(() => usePermissions());
  
  await waitFor(() => {
    expect(result.current.loading).toBe(false);
  });
  
  expect(result.current.permissions).toContain('users:read');
});

test('should check permission', () => {
  const { result } = renderHook(() => usePermissions());
  
  expect(result.current.hasPermission('users:read')).toBe(true);
  expect(result.current.hasPermission('admin:access')).toBe(false);
});
```

### Test PermissionGuard
```typescript
import { render, screen } from '@testing-library/react';
import { PermissionGuard } from './PermissionGuard';

test('should show content when has permission', () => {
  render(
    <PermissionGuard permission="users:read">
      <div>Protected Content</div>
    </PermissionGuard>
  );
  
  expect(screen.getByText('Protected Content')).toBeInTheDocument();
});

test('should show fallback when no permission', () => {
  render(
    <PermissionGuard 
      permission="admin:access"
      fallback={<div>Access Denied</div>}
    >
      <div>Protected Content</div>
    </PermissionGuard>
  );
  
  expect(screen.getByText('Access Denied')).toBeInTheDocument();
  expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
});
```

---

## 🐛 Troubleshooting

### Issue: Menu items not showing
**Solution**: 
1. Check if menu item has `permission` field set
2. Verify user has that permission
3. Check if menu item `isActive` is true
4. Refresh permissions: `await refreshPermissions()`

### Issue: Permission check always returns false
**Solution**:
1. Verify exact permission string (case-sensitive)
2. Check if permission exists in user's role
3. Verify permission format: `resource:action`
4. Check backend logs for permission aggregation

### Issue: PermissionGuard always shows fallback
**Solution**:
1. Check if permission string is correct
2. Verify user is logged in
3. Check if permissions are loaded
4. Test with `hasPermission()` directly

### Issue: Button not rendering
**Solution**:
1. Check permission prop is correct
2. Verify user has the permission
3. Check if `fallback` is provided
4. Inspect browser console for errors

---

## 📖 Examples

### Example 1: Admin Dashboard
```typescript
import { PermissionGuard } from '../components/PermissionGuard';
import { usePermissions } from '../hooks/usePermissions';

function AdminDashboard() {
  const { hasPermission } = usePermissions();

  return (
    <div>
      <h1>Admin Dashboard</h1>
      
      {hasPermission('users:read') && (
        <UsersWidget />
      )}
      
      {hasPermission('reports:view') && (
        <ReportsWidget />
      )}
      
      <PermissionGuard 
        permission="admin:settings"
        fallback={<div>Settings access required</div>}
      >
        <SettingsPanel />
      </PermissionGuard>
    </div>
  );
}
```

### Example 2: User Management Page
```typescript
import { PermissionButton, PermissionGuard } from '../components/PermissionGuard';

function UsersPage() {
  return (
    <PermissionGuard permission="users:read" redirectTo="/unauthorized">
      <div>
        <h1>Users</h1>
        
        <PermissionButton
          permission="users:create"
          onClick={handleCreate}
          className="btn-primary"
        >
          Create User
        </PermissionButton>
        
        <UsersList />
      </div>
    </PermissionGuard>
  );
}
```

### Example 3: Conditional Actions
```typescript
function UserRow({ user }) {
  const { hasPermission } = usePermissions();

  return (
    <tr>
      <td>{user.name}</td>
      <td>{user.email}</td>
      <td>
        {hasPermission('users:write') && (
          <button onClick={() => handleEdit(user)}>Edit</button>
        )}
        
        {hasPermission('users:delete') && (
          <button onClick={() => handleDelete(user)}>Delete</button>
        )}
      </td>
    </tr>
  );
}
```

---

## 🎓 Best Practices

### ✅ DO
- Use specific permissions: `users:read` not just `read`
- Check permissions before rendering sensitive content
- Provide fallback UI for better UX
- Use `anyOf` for flexible access control
- Test with different user types
- Document all permissions

### ❌ DON'T
- Don't rely only on frontend checks
- Don't use vague permissions like `access`
- Don't hardcode permission strings
- Don't skip backend validation
- Don't expose sensitive data without checks
- Don't forget to handle loading states

---

## 🔗 Related Documentation

- **Phase 1**: `PHASE_1_PORTAL_ROUTING_COMPLETE.md`
- **Phase 2**: `PHASE_2_PERMISSION_MENUS_COMPLETE.md`
- **API Docs**: `http://localhost:4000/docs`
- **Demo Page**: `/permission-demo`

---

## 📞 Support

For issues or questions:
1. Check this quick reference
2. Review Phase 2 documentation
3. Check backend logs
4. Verify database permissions
5. Test with different user types

---

**Last Updated**: 2026-01-XX  
**Version**: 1.0  
**Status**: Production Ready ✅
