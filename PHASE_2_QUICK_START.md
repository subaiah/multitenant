# Phase 2 Quick Start Guide

Get started with Phase 2 features (Organizations, Applications, Entitlements) in 5 minutes!

## Prerequisites

- Node.js 24+
- PostgreSQL database running
- Phase 1.5 completed and working

## Step 1: Run Database Migration

```bash
cd backend
npx prisma migrate dev --name add_organizations_and_applications
```

This creates:
- `organizations` table
- `org_units` table (recursive hierarchy)
- `org_memberships` table
- `applications` table
- `tenant_applications` table
- Updates `permissions` table with applicationId

## Step 2: Seed Default Data (Optional)

```bash
cd backend
npx tsx prisma/migrate-phase2.ts
```

This creates:
- 3 default applications (Admin Portal, Tenant Dashboard, API Gateway)
- Default permissions for each application
- Default organization for each tenant
- Default org units (Executive, Engineering, Sales, Marketing)
- Enables default applications for all tenants

## Step 3: Start Backend

```bash
cd backend
npm run dev
```

Backend will start at `http://localhost:4000`

## Step 4: Start Frontend

```bash
npm run dev
```

Frontend will start at `http://localhost:5173`

## Step 5: Test the Features

### Test Organizations

1. Navigate to **Users → Organizations**
2. Click **+** to create a new organization
3. Enter name and description
4. Click **Create**
5. Select the organization to view its units
6. Click **Add Unit** to create departments/teams
7. Set parent unit for hierarchical structure

### Test Applications Management

1. Navigate to **App Management → Applications**
2. Click **+** to create a new application
3. Enter key (e.g., `my-app`), name, version
4. Click **Create**
5. Select the application
6. Click **Add Permission** to define permissions
7. Enter permission name (e.g., `my-app.users.read`)
8. Set resource and action
9. Click **Create**

### Test Tenant Entitlements

1. Navigate to **App Management → Tenant Entitlements**
2. Click **Add Application**
3. Select an application from the dropdown
4. Optionally set expiration date
5. Click **Add**
6. You can now Enable/Disable the application
7. Test access - users should only access entitled applications

## API Testing with cURL

### Create Organization

```bash
curl -X POST http://localhost:4000/organizations \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Engineering",
    "description": "Engineering department"
  }'
```

### Create Org Unit

```bash
curl -X POST http://localhost:4000/org-units/organization/ORG_ID \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Backend Team",
    "unitType": "TEAM",
    "description": "Backend development team"
  }'
```

### Create Application

```bash
curl -X POST http://localhost:4000/applications \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "my-app",
    "name": "My Application",
    "version": "1.0.0",
    "description": "My custom application"
  }'
```

### Create Permission

```bash
curl -X POST http://localhost:4000/applications/APP_ID/permissions \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-app.users.read",
    "resource": "users",
    "action": "read",
    "description": "Read user data"
  }'
```

### Enable Application for Tenant

```bash
curl -X POST http://localhost:4000/tenant-applications \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "applicationId": "APP_ID",
    "state": "ENABLED"
  }'
```

### Check Entitlement

```bash
curl -X GET http://localhost:4000/tenant-applications/check/APP_ID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Testing Hierarchical Scopes

### 1. Create Organization Structure

```
Engineering (Organization)
  ├── Backend Team (OrgUnit)
  │    └── API Squad (OrgUnit)
  └── Frontend Team (OrgUnit)
```

### 2. Assign Role with ORGANIZATION Scope

```bash
curl -X POST http://localhost:4000/roles/assign \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "roleId": "ROLE_ID",
    "principalType": "USER",
    "userId": "USER_ID",
    "scopeType": "ORGANIZATION",
    "scopeId": "ENGINEERING_ORG_ID"
  }'
```

### 3. Verify Scope Inheritance

User with ORGANIZATION scope should have access to:
- ✅ Engineering organization
- ✅ Backend Team unit
- ✅ API Squad unit (child of Backend Team)
- ✅ Frontend Team unit

### 4. Test with ORG_UNIT Scope

```bash
curl -X POST http://localhost:4000/roles/assign \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "roleId": "ROLE_ID",
    "principalType": "USER",
    "userId": "USER_ID",
    "scopeType": "ORG_UNIT",
    "scopeId": "BACKEND_TEAM_ID"
  }'
```

User with ORG_UNIT scope should have access to:
- ✅ Backend Team unit
- ✅ API Squad unit (child)
- ❌ Frontend Team unit (sibling)
- ❌ Engineering organization (parent)

## Common Workflows

### Workflow 1: Set Up New Tenant

1. Create organization for tenant
2. Create org units (departments, teams)
3. Enable required applications
4. Assign roles with appropriate scopes
5. Add users to organizations/units

### Workflow 2: Manage Application Access

1. Create application with permissions
2. Enable application for tenants
3. Set expiration dates if needed
4. Assign roles with application-specific permissions
5. Monitor usage and adjust entitlements

### Workflow 3: Restructure Organization

1. Create new org units
2. Move users to new units
3. Update role assignments with new scopes
4. Delete old units (after moving members)
5. Verify access still works correctly

## Troubleshooting

### Issue: Can't create organization
**Solution**: Ensure you have TENANT_ADMIN role

### Issue: Can't see applications
**Solution**: 
- Check if you have PLATFORM_ADMIN role (for management)
- Or check tenant entitlements (for tenant view)

### Issue: Scope not working
**Solution**:
- Verify org unit hierarchy is correct
- Check parentUnitId references
- Ensure tenantId matches

### Issue: Entitlement expired
**Solution**:
- Check validTo date
- Update entitlement with new date
- Or remove validTo for no expiration

## Next Steps

After testing Phase 2:
1. Review Phase 2 Implementation Guide for details
2. Test all API endpoints via Swagger UI at `http://localhost:4000/docs`
3. Create custom applications and permissions
4. Set up complex organizational structures
5. Test hierarchical scope inheritance
6. Prepare for Phase 3 (Delegation, Policies)

## Success Criteria

Phase 2 is working when:
- ✅ Can create organizations and org units
- ✅ Can manage applications and permissions
- ✅ Can enable/disable applications for tenants
- ✅ Hierarchical scope validation works
- ✅ Application entitlement checks work
- ✅ Frontend UI is functional
- ✅ All API endpoints respond correctly

## Support

- **Full Documentation**: `PHASE_2_IMPLEMENTATION_GUIDE.md`
- **API Documentation**: `http://localhost:4000/docs`
- **Phase 1.5 Guide**: `PHASE_1_5_COMPLETE.md`
- **Implementation Plan**: `OIAM_IMPLEMENTATION_PLAN.md`

---

**Happy testing!** 🚀
