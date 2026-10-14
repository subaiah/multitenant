# RBAC Quick Start Guide

Get started with the Role-Based Access Control system in 5 minutes!

## 🚀 Quick Setup

### 1. Run Database Migration

```bash
cd backend
npx prisma migrate dev --name add-rbac-system
```

This will:
- Add new tables: Permission, Role, RolePermission, UserRole
- Update User table with userType field
- Create default permissions

### 2. Seed Database (Optional)

```bash
npm run prisma:seed
```

This creates:
- 4 test tenants
- 8 test users (2 per tenant)
- Test applications and configurations

### 3. Start Backend

```bash
npm run dev
```

Backend runs on `http://localhost:4000`

## 🔑 Test Credentials

After seeding, use these credentials:

### Acme Corporation
- **Admin**: `admin@acme-corp.com` / `admin123` (TENANT_ADMIN)
- **User**: `user@acme-corp.com` / `user123` (TENANT_USER)

### TechStart Inc.
- **Admin**: `admin@techstart.com` / `admin123` (TENANT_ADMIN)
- **User**: `user@techstart.com` / `user123` (TENANT_USER)

## 📋 Common Tasks

### Task 1: Login and Get Token

```bash
curl -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@acme-corp.com",
    "password": "admin123",
    "tenantId": "<tenant-id>"
  }'
```

Save the `token` from the response.

### Task 2: List Available Roles

```bash
curl -X GET http://localhost:4000/roles \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-tenant-id: YOUR_TENANT_ID"
```

You'll see the 5 default roles:
- Tenant Admin
- Tenant Manager
- Developer
- User
- Viewer

### Task 3: List All Permissions

```bash
curl -X GET http://localhost:4000/roles/permissions/list \
  -H "Authorization: Bearer YOUR_TOKEN"
```

You'll see permissions like:
- `applications:create`
- `applications:read`
- `applications:update`
- `applications:delete`
- `users:create`
- `users:read`
- etc.

### Task 4: Create a Custom Role

```bash
curl -X POST http://localhost:4000/roles \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "App Developer",
    "description": "Can create and update applications",
    "tenantId": "YOUR_TENANT_ID",
    "permissions": [
      "applications:create",
      "applications:read",
      "applications:update"
    ]
  }'
```

### Task 5: Assign Role to User

First, get the user ID:
```bash
curl -X GET http://localhost:4000/users \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-tenant-id: YOUR_TENANT_ID"
```

Then assign the role:
```bash
curl -X POST http://localhost:4000/roles/assign \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "USER_ID",
    "roleId": "ROLE_ID"
  }'
```

### Task 6: Check User's Permissions

```bash
curl -X GET http://localhost:4000/roles/user/USER_ID/permissions \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Response:
```json
{
  "permissions": [
    "applications:create",
    "applications:read",
    "applications:update",
    "tenant:read"
  ]
}
```

## 🎯 User Types Explained

### Platform Users
- **PLATFORM_ADMIN**: Can manage all tenants (you, the system admin)
- **PLATFORM_USER**: Can view tenant info (support staff)

### Tenant Users
- **TENANT_ADMIN**: Full control of their tenant
- **TENANT_MANAGER**: Can manage apps and users
- **TENANT_DEVELOPER**: Can manage applications
- **TENANT_USER**: Can use applications
- **TENANT_VIEWER**: Read-only access

## 🔐 Permission Format

All permissions follow this format:
```
resource:action
```

### Examples
- `applications:create` - Create applications
- `users:read` - View users
- `settings:update` - Update settings
- `*:*` - All permissions (admin only)

### Wildcards
- `applications:*` - All actions on applications
- `*:read` - Read access to everything
- `*:*` - Full access (dangerous!)

## 📚 Default Roles

### Tenant Admin
**Permissions:**
- `tenant:*` - Full tenant control
- `applications:*` - Full app control
- `users:*` - Full user control
- `roles:*` - Full role control
- `settings:*` - Full settings control

**Use for:** Tenant owners, primary administrators

### Tenant Manager
**Permissions:**
- `tenant:read`, `tenant:update`
- `applications:*`
- `users:read`, `users:create`, `users:update`

**Use for:** Department heads, team leads

### Developer
**Permissions:**
- `tenant:read`
- `applications:*`
- `users:read`

**Use for:** Developers, technical staff

### User
**Permissions:**
- `tenant:read`
- `applications:read`
- `users:read`

**Use for:** Regular employees

### Viewer
**Permissions:**
- `tenant:read`
- `applications:read`

**Use for:** Auditors, observers

## 🛠️ Common Scenarios

### Scenario 1: New Developer Joins

1. Create user account
2. Assign "Developer" role
3. Developer can now manage applications

```bash
# Assign Developer role
curl -X POST http://localhost:4000/roles/assign \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "NEW_DEV_USER_ID",
    "roleId": "DEVELOPER_ROLE_ID"
  }'
```

### Scenario 2: Create Custom Role for QA Team

```bash
curl -X POST http://localhost:4000/roles \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "QA Tester",
    "description": "Can view and test applications",
    "tenantId": "YOUR_TENANT_ID",
    "permissions": [
      "applications:read",
      "applications:update"
    ]
  }'
```

### Scenario 3: Promote User to Manager

1. Get current roles
2. Remove old role
3. Assign Manager role

```bash
# Remove old role
curl -X DELETE http://localhost:4000/roles/unassign \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "USER_ID",
    "roleId": "OLD_ROLE_ID"
  }'

# Assign Manager role
curl -X POST http://localhost:4000/roles/assign \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "USER_ID",
    "roleId": "MANAGER_ROLE_ID"
  }'
```

## 🧪 Testing Permissions

### Test in Code

```typescript
import { requirePermission } from './utils/authorization.js';

fastify.get('/applications', async (request, reply) => {
  const userId = (request.user as any).userId;
  
  // This will throw 403 if user doesn't have permission
  await requirePermission(userId, 'applications', 'read');
  
  // User has permission, continue
  const apps = await prisma.application.findMany();
  return { apps };
});
```

### Test via API

Try accessing a resource without permission:

```bash
# Login as regular user
curl -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@acme-corp.com",
    "password": "user123",
    "tenantId": "TENANT_ID"
  }'

# Try to create an application (should fail with 403)
curl -X POST http://localhost:4000/applications \
  -H "Authorization: Bearer USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test App",
    "description": "Test"
  }'
```

Expected response:
```json
{
  "error": "Missing permission: applications:create"
}
```

## 📖 Next Steps

1. **Read Full Documentation**: `backend/docs/RBAC_SYSTEM.md`
2. **Explore API**: `http://localhost:4000/docs` (Swagger UI)
3. **Create Custom Roles**: Design roles for your use cases
4. **Assign Roles**: Assign appropriate roles to users
5. **Test Permissions**: Verify access control works as expected

## 🆘 Troubleshooting

### "Missing permission" Error
- Check user's assigned roles
- Verify role has the required permission
- Check permission string format (resource:action)

### "Access denied to this tenant" Error
- Verify user belongs to the tenant
- Check x-tenant-id header
- Platform admins can access any tenant

### "Role not found" Error
- Verify role ID is correct
- Check role belongs to the tenant
- Ensure role hasn't been deleted

### User Can't Access Resource
- Check user type level
- Verify role assignments
- Check role permissions
- Test with admin user first

## 💡 Tips

1. **Start Simple**: Use default roles first, customize later
2. **Test Thoroughly**: Test permissions before deploying
3. **Document Roles**: Keep track of what each role can do
4. **Regular Audits**: Review role assignments periodically
5. **Least Privilege**: Grant minimum necessary permissions

## 🎉 You're Ready!

You now have a fully functional RBAC system. Start creating custom roles and managing permissions for your multi-tenant platform!

For advanced features and detailed documentation, see:
- `backend/docs/RBAC_SYSTEM.md` - Complete RBAC guide
- `RBAC_IMPLEMENTATION_SUMMARY.md` - Implementation details
