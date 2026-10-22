# Role-Based Access Control (RBAC) System

## Overview

The multi-tenant platform implements a comprehensive role-based access control system with user types and granular permissions. This allows fine-grained control over what users can do within the platform.

## User Types

The system defines 7 user types in a hierarchical structure:

### Platform-Level Users

1. **PLATFORM_ADMIN** (Level 100)
   - Full access to all tenants and platform settings
   - Can manage all tenants, users, and configurations
   - Typically used by system administrators

2. **PLATFORM_USER** (Level 90)
   - Can view tenant information
   - Limited platform-level access
   - Typically used for platform support staff

### Tenant-Level Users

3. **TENANT_ADMIN** (Level 80)
   - Full access within their tenant
   - Can manage users, roles, applications, and settings
   - Typically the tenant owner or primary administrator

4. **TENANT_MANAGER** (Level 70)
   - Can manage applications and users
   - Can read and update tenant settings
   - Typically department heads or team leads

5. **TENANT_DEVELOPER** (Level 60)
   - Can manage applications
   - Can view users and tenant information
   - Typically developers and technical staff

6. **TENANT_USER** (Level 50)
   - Can view and use applications
   - Can view tenant and user information
   - Typically regular employees

7. **TENANT_VIEWER** (Level 40)
   - Read-only access to applications and tenant information
   - Cannot make any changes
   - Typically auditors or observers

## Permission System

### Permission Structure

Permissions follow a `resource:action` format:

- **Resources**: `tenants`, `applications`, `users`, `roles`, `settings`, `billing`, `platform`
- **Actions**: `create`, `read`, `update`, `delete`

Examples:
- `tenants:create` - Create new tenants
- `applications:read` - View applications
- `users:update` - Update user information
- `*:*` - All permissions (wildcard)

### Wildcard Permissions

The system supports wildcard permissions:
- `resource:*` - All actions on a resource
- `*:action` - Action on all resources
- `*:*` - All permissions

## How several roles combine

A tenant user's permissions are the union of:

1. their user type's defaults (Tenant Admin, Manager, User…);
2. roles assigned to them directly;
3. roles assigned to groups they belong to;
4. roles delegated to them.

Only assignments, memberships and delegations that are active and inside their validity dates count. Nothing subtracts: to take a permission away, remove the role, membership or delegation that grants it. Tenant roles can never grant platform permissions, and nobody can give out a permission they don't hold themselves (`requireCanGrant`).

### Scoped assignments

A role can be assigned (to a user, a group, or by delegation) for the **whole tenant**, or for **one organization**, **one unit** (and every unit below it) or **one resource**. A scoped assignment grants its permissions there only (`src/lib/scopes.ts`):

- Route checks and `hasPermission()` see tenant-wide permissions only. So "Org Admin for North", even with `users:read` in the role, can't list the tenant's users.
- Routes that act on organization data declare `config: { permission, scoped: true }` and check each item with `requireInScope(request, permission, { organizationId | orgUnitId | resourceId })`. They filter lists with `scopeOf(request, permission)`. The Organizations and units API does this:
  - someone with a role for one organization sees and manages that organization;
  - someone with a role for a unit sees that unit and the units below it, and can add units under it, but can't create a unit at the top of the organization or move one outside their unit.
- `GET /auth/permissions` returns the tenant-wide `permissions` and the `scoped` grants. Pages for scope-aware resources (organizations, plus the product's `scopedResources`) show when a permission applies anywhere. Everything else needs it tenant-wide.
- The access review lists scoped permissions as "in part", next to the tenant-wide ones.

## Default Roles

When a new tenant is created, the following default roles are automatically created:

1. **Tenant Admin**
   - Full access to all tenant resources
   - Permissions: `tenant:*`, `applications:*`, `users:*`, `roles:*`, `settings:*`

2. **Tenant Manager**
   - Can manage applications and users
   - Permissions: `tenant:read`, `tenant:update`, `applications:*`, `users:read`, `users:create`, `users:update`

3. **Developer**
   - Can manage applications
   - Permissions: `tenant:read`, `applications:*`, `users:read`

4. **User**
   - Can view and use applications
   - Permissions: `tenant:read`, `applications:read`, `users:read`

5. **Viewer**
   - Read-only access
   - Permissions: `tenant:read`, `applications:read`

## API Endpoints

### Role Management

#### List Roles
```http
GET /roles
GET /roles?tenantId={tenantId}
```

**Response:**
```json
{
  "roles": [
    {
      "id": "uuid",
      "tenantId": "uuid",
      "name": "Tenant Admin",
      "description": "Full access to tenant resources",
      "isSystem": true,
      "permissions": [
        {
          "permission": {
            "name": "tenant:*",
            "resource": "tenant",
            "action": "*"
          }
        }
      ],
      "_count": {
        "users": 5
      }
    }
  ]
}
```

#### Get Role by ID
```http
GET /roles/{id}
```

#### Create Role
```http
POST /roles
Content-Type: application/json

{
  "name": "Custom Role",
  "description": "Custom role description",
  "tenantId": "uuid",
  "permissions": ["applications:read", "applications:update"]
}
```

#### Update Role
```http
PATCH /roles/{id}
Content-Type: application/json

{
  "name": "Updated Role Name",
  "description": "Updated description",
  "permissions": ["applications:read"]
}
```

#### Delete Role
```http
DELETE /roles/{id}
```

**Note:** System roles cannot be deleted.

### Role Assignment

#### Assign Role to User
```http
POST /roles/assign
Content-Type: application/json

{
  "userId": "uuid",
  "roleId": "uuid"
}
```

#### Remove Role from User
```http
DELETE /roles/unassign
Content-Type: application/json

{
  "userId": "uuid",
  "roleId": "uuid"
}
```

#### Get User Roles
```http
GET /roles/user/{userId}
```

**Response:**
```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "userType": "TENANT_ADMIN"
  },
  "roles": [
    {
      "id": "uuid",
      "name": "Tenant Admin",
      "description": "Full access to tenant resources",
      "permissions": ["tenant:*", "applications:*"]
    }
  ]
}
```

#### Get User Permissions
```http
GET /roles/user/{userId}/permissions
```

**Response:**
```json
{
  "permissions": [
    "tenant:*",
    "applications:*",
    "users:read",
    "settings:read"
  ]
}
```

### Permission Management

#### List All Permissions
```http
GET /roles/permissions/list
```

**Response:**
```json
{
  "permissions": [
    {
      "id": "uuid",
      "name": "applications:create",
      "description": "create applications",
      "resource": "applications",
      "action": "create"
    }
  ]
}
```

#### Initialize Default Roles
```http
POST /roles/initialize/{tenantId}
```

This creates the 5 default roles for a tenant.

## Authorization Middleware

### Tenant Context Middleware

The `tenantContext` middleware automatically:
1. Extracts tenant ID from request headers (`x-tenant-id`)
2. Validates tenant exists and is active
3. Attaches tenant information to the request

### Authorization Checks

#### Check User Type
```typescript
import { requireUserType } from '../utils/authorization.js';

// Require at least TENANT_ADMIN
requireUserType(userType, 'TENANT_ADMIN');
```

#### Check Tenant Access
```typescript
import { requireTenantAccess } from '../utils/authorization.js';

// Check if user can access specific tenant
await requireTenantAccess(userId, tenantId);
```

#### Check Permission
```typescript
import { requirePermission } from '../utils/authorization.js';

// Check if user has specific permission
await requirePermission(userId, 'applications', 'create');
```

## Usage Examples

### Creating a Custom Role

```typescript
// Create a role with specific permissions
const role = await prisma.role.create({
   {
    tenantId: 'tenant-uuid',
    name: 'App Manager',
    description: 'Can manage applications only',
    isSystem: false,
  },
});

// Assign permissions
const permissions = await prisma.permission.findMany({
  where: {
    resource: 'applications',
  },
});

await prisma.rolePermission.createMany({
   {
    roleId: role.id,
    permissionIds: permissions.map(p => p.id),
  },
});
```

### Assigning Multiple Roles to a User

```typescript
// User can have multiple roles
await prisma.userRole.createMany({
   [
    { userId: 'user-uuid', roleId: 'role-1-uuid' },
    { userId: 'user-uuid', roleId: 'role-2-uuid' },
  ],
});

// Permissions are cumulative across all roles,
// except that a role assigned for one organization or unit applies there only
// (see "Scoped assignments" above)
```

### Checking Permissions in Routes

```typescript
fastify.get('/applications', {
  schema: {
    tags: ['applications'],
    summary: 'List applications',
  },
}, async (request, reply) => {
  const userId = (request.user as any).userId;
  const userType = (request.user as any).userType;
  
  // Check user type
  requireUserType(userType, 'TENANT_USER');
  
  // Check specific permission
  await requirePermission(userId, 'applications', 'read');
  
  // Continue with route logic
  const applications = await prisma.application.findMany({
    where: { tenantId: request.tenant.id },
  });
  
  return { applications };
});
```

## Database Schema

### User Model
```prisma
model User {
  id              String     @id @default(uuid())
  tenantId        String?    @map("tenant_id")
  email           String
  name            String?
  passwordHash    String?    @map("password_hash")
  userType        UserType   @default(TENANT_USER) @map("user_type")
  status          UserStatus @default(ACTIVE)
  
  // Relations
  tenant          Tenant?    @relation(...)
  roles           UserRole[]
}
```

### Role Model
```prisma
model Role {
  id          String    @id @default(uuid())
  tenantId    String?   @map("tenant_id")
  name        String
  description String?
  isSystem    Boolean   @default(false) @map("is_system")
  
  // Relations
  tenant      Tenant?   @relation(...)
  permissions RolePermission[]
  users       UserRole[]
}
```

### Permission Model
```prisma
model Permission {
  id          String    @id @default(uuid())
  name        String    @unique
  description String?
  resource    String
  action      String
  
  roles       RolePermission[]
}
```

### RolePermission Model (Many-to-Many)
```prisma
model RolePermission {
  id           String     @id @default(uuid())
  roleId       String     @map("role_id")
  permissionId String     @map("permission_id")
  
  role         Role       @relation(...)
  permission   Permission @relation(...)
  
  @@unique([roleId, permissionId])
}
```

### UserRole Model (Many-to-Many)
```prisma
model UserRole {
  id        String   @id @default(uuid())
  userId    String   @map("user_id")
  roleId    String   @map("role_id")
  
  user      User     @relation(...)
  role      Role     @relation(...)
  
  @@unique([userId, roleId])
}
```

## Best Practices

### 1. Use User Types for Broad Access Control
- Use `userType` for high-level access control
- Use roles for fine-grained permissions within a tenant

### 2. Create Custom Roles for Specific Needs
- Don't modify system roles
- Create custom roles for specific use cases
- Assign only necessary permissions

### 3. Follow Principle of Least Privilege
- Grant minimum necessary permissions
- Review permissions regularly
- Remove unused roles

### 4. Use System Roles as Templates
- System roles provide good starting points
- Copy permissions from system roles when creating custom roles
- Customize as needed

### 5. Audit Role Assignments
- Monitor role assignments
- Log all role changes
- Review access regularly

## Migration Guide

### From Old Role System

If you're migrating from the old `role` field:

1. **Update User Records**
```sql
UPDATE users 
SET user_type = CASE 
  WHEN role = 'ADMIN' THEN 'TENANT_ADMIN'
  WHEN role = 'MANAGER' THEN 'TENANT_MANAGER'
  WHEN role = 'USER' THEN 'TENANT_USER'
  ELSE 'TENANT_VIEWER'
END;
```

2. **Create Default Roles**
```bash
# For each tenant, run:
POST /roles/initialize/{tenantId}
```

3. **Assign Roles**
```typescript
// Assign appropriate roles to users
await prisma.userRole.create({
   {
    userId: 'user-uuid',
    roleId: 'tenant-admin-role-uuid',
  },
});
```

## Security Considerations

### 1. JWT Token Contains User Type
- User type is included in JWT token
- Cannot be changed without re-authentication
- Validated on every request

### 2. Tenant Isolation
- Users can only access their own tenant
- Platform admins can access all tenants
- Enforced at middleware level

### 3. System Role Protection
- System roles cannot be deleted
- System roles cannot be modified
- Prevents accidental permission loss

### 4. Permission Validation
- All permissions are validated against database
- Invalid permissions are rejected
- Wildcard permissions are supported

## Troubleshooting

### User Cannot Access Resource
1. Check user type level
2. Check assigned roles
3. Check role permissions
4. Verify tenant access

### Permission Denied Error
1. Verify user has the required permission
2. Check if permission string is correct
3. Verify role is properly assigned
4. Check for typos in resource/action names

### Role Assignment Fails
1. Verify user and role exist
2. Check tenant alignment
3. Verify role is not already assigned
4. Check user permissions to assign roles

## Future Enhancements

### Planned Features
- [ ] Role templates
- [ ] Permission groups
- [ ] Role inheritance
- [ ] Temporary role assignments
- [ ] Role expiration
- [ ] Permission audit logs
- [ ] Role usage analytics

### Custom Extensions
- Add custom resources
- Add custom actions
- Create domain-specific roles
- Implement approval workflows

## Summary

The RBAC system provides:
- ✅ 7 hierarchical user types
- ✅ Granular permission system
- ✅ Default roles for common use cases
- ✅ Custom role creation
- ✅ Multiple role assignment per user
- ✅ Tenant isolation
- ✅ Comprehensive API
- ✅ Security best practices

This system scales from small startups to large enterprises while maintaining security and flexibility.
