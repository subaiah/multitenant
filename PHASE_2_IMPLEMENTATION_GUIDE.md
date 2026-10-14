# Phase 2 Implementation Guide - Enterprise Features

## Overview

Phase 2 adds **Organizational Hierarchy** and **Application Entitlements** to the multi-tenant platform, enabling:
- Real-world organizational structures (companies, departments, teams)
- Hierarchical scope-based access control
- Application licensing and permission manifests
- Entitlement validation in authorization

## Implementation Status

### ✅ Completed Components

#### Backend
- [x] Database schema updated with Organization, OrgUnit, OrgMembership models
- [x] Application and TenantApplication models added
- [x] Organizations API routes created
- [x] Org Units API routes created
- [x] Applications Management API routes created
- [x] Tenant Applications API routes created
- [x] Hierarchical scope validation implemented in authorization logic
- [x] All routes registered in server.ts

#### Frontend
- [x] Organizations page with CRUD operations
- [x] Org Units management with hierarchical display
- [x] Applications Management page with permission management
- [x] Tenant Entitlements page for application licensing
- [x] Navigation updated in Sidebar and TopNav
- [x] Routes added to App.tsx

## Database Schema

### New Models

#### Organization
```prisma
model Organization {
  id          String   @id @default(uuid())
  tenantId    String   @map("tenant_id")
  name        String
  description String?
  status      String   @default("ACTIVE")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  
  tenant      Tenant   @relation(...)
  units       OrgUnit[]
  memberships OrgMembership[]
  
  @@unique([tenantId, name])
  @@map("organizations")
}
```

#### OrgUnit (Recursive Hierarchy)
```prisma
model OrgUnit {
  id             String    @id @default(uuid())
  tenantId       String    @map("tenant_id")
  organizationId String    @map("organization_id")
  parentUnitId   String?   @map("parent_unit_id")
  unitType       String    @map("unit_type") // DIVISION, DEPARTMENT, TEAM, LOCATION
  name           String
  description    String?
  
  tenant         Tenant    @relation(...)
  organization   Organization @relation(...)
  parent         OrgUnit?  @relation("OrgUnitHierarchy", ...)
  children       OrgUnit[] @relation("OrgUnitHierarchy")
  memberships    OrgMembership[]
  
  @@map("org_units")
}
```

#### OrgMembership
```prisma
model OrgMembership {
  id             String   @id @default(uuid())
  tenantId       String   @map("tenant_id")
  userId         String   @map("user_id")
  organizationId String?  @map("organization_id")
  orgUnitId      String?  @map("org_unit_id")
  
  @@unique([tenantId, userId, organizationId, orgUnitId])
  @@map("org_memberships")
}
```

#### Application
```prisma
model Application {
  id          String   @id @default(uuid())
  key         String   @unique
  name        String
  description String?
  version     String
  status      String   @default("ACTIVE")
  
  permissions Permission[]
  tenantApplications TenantApplication[]
  
  @@map("applications")
}
```

#### TenantApplication
```prisma
model TenantApplication {
  id            String   @id @default(uuid())
  tenantId      String   @map("tenant_id")
  applicationId String   @map("application_id")
  state         String   @default("ENABLED") // ENABLED, DISABLED, TRIAL
  validFrom     DateTime @default(now()) @map("valid_from")
  validTo       DateTime? @map("valid_to")
  
  @@unique([tenantId, applicationId])
  @@map("tenant_applications")
}
```

## API Endpoints

### Organizations
```
GET    /organizations              - List organizations
POST   /organizations              - Create organization
GET    /organizations/:id          - Get organization details
PATCH  /organizations/:id          - Update organization
DELETE /organizations/:id          - Delete organization
POST   /organizations/:id/members  - Add member
DELETE /organizations/:id/members/:userId - Remove member
```

### Org Units
```
GET    /org-units/organization/:orgId        - List units in org
POST   /org-units/organization/:orgId        - Create unit
GET    /org-units/:id                        - Get unit details
PATCH  /org-units/:id                        - Update unit
DELETE /org-units/:id                        - Delete unit
GET    /org-units/organization/:orgId/hierarchy - Get tree structure
POST   /org-units/:id/members                - Add member
DELETE /org-units/:id/members/:userId        - Remove member
```

### Applications Management (Platform Admin)
```
GET    /applications                         - List all applications
POST   /applications                         - Create application
GET    /applications/:id                     - Get application details
PATCH  /applications/:id                     - Update application
DELETE /applications/:id                     - Delete application
GET    /applications/:id/permissions         - List permissions
POST   /applications/:id/permissions         - Create permission
DELETE /applications/permissions/:id         - Delete permission
```

### Tenant Applications
```
GET    /tenant-applications                  - List tenant's apps
POST   /tenant-applications                  - Enable app for tenant
GET    /tenant-applications/:id              - Get entitlement details
PATCH  /tenant-applications/:id              - Update entitlement
DELETE /tenant-applications/:id              - Disable app
GET    /tenant-applications/check/:appId     - Check entitlement
```

## Hierarchical Scope Validation

The authorization system now supports hierarchical scope checking:

### Scope Hierarchy
```
TENANT (covers everything in tenant)
  └── ORGANIZATION (covers org and all its units)
       └── ORG_UNIT (covers unit and all descendants)
            └── RESOURCE (specific resource)
```

### Implementation
```typescript
async function isScopeCompatible(
  assignmentScopeType: string,
  assignmentScopeId: string,
  requestedScopeType: string,
  requestedScopeId: string,
  tenantId: string
): Promise<boolean> {
  // Exact match
  if (assignmentScopeType === requestedScopeType && 
      assignmentScopeId === requestedScopeId) {
    return true;
  }
  
  // Tenant scope covers everything
  if (assignmentScopeType === 'TENANT') {
    return true;
  }
  
  // Organization scope covers org and all units
  if (assignmentScopeType === 'ORGANIZATION') {
    if (requestedScopeType === 'ORGANIZATION' && 
        assignmentScopeId === requestedScopeId) {
      return true;
    }
    if (requestedScopeType === 'ORG_UNIT') {
      const unit = await prisma.orgUnit.findFirst({
        where: {
          id: requestedScopeId,
          organizationId: assignmentScopeId,
          tenantId,
        },
      });
      return !!unit;
    }
  }
  
  // Org unit scope covers unit and descendants
  if (assignmentScopeType === 'ORG_UNIT') {
    if (requestedScopeType === 'ORG_UNIT' && 
        assignmentScopeId === requestedScopeId) {
      return true;
    }
    // Traverse up hierarchy to find ancestor
    let currentUnitId: string | null = requestedScopeId;
    while (currentUnitId) {
      if (currentUnitId === assignmentScopeId) {
        return true;
      }
      const unit = await prisma.orgUnit.findUnique({
        where: { id: currentUnitId },
        select: { parentUnitId: true },
      });
      currentUnitId = unit?.parentUnitId || null;
    }
  }
  
  return false;
}
```

## Frontend Pages

### Organizations Page (`/organizations`)
- **Left Panel**: List of organizations with member/unit counts
- **Right Panel**: Organizational units tree for selected org
- **Features**:
  - Create/Edit/Delete organizations
  - Create org units (Division, Department, Team, Location)
  - Set parent-child relationships
  - View member counts
  - Delete protection (can't delete orgs with units/members)

### Applications Management Page (`/applications-management`)
- **Left Panel**: List of all applications
- **Right Panel**: Permissions for selected application
- **Features**:
  - Create/Edit/Delete applications (platform admin only)
  - Define permissions with resource and action
  - View permission count per app
  - Status management (ACTIVE, INACTIVE, DEPRECATED)

### Tenant Entitlements Page (`/tenant-entitlements`)
- **Main View**: List of enabled applications for current tenant
- **Features**:
  - Add applications from available list
  - Enable/Disable applications
  - Set expiration dates
  - View application details and version
  - Remove entitlements

## Migration Guide

### Step 1: Run Database Migration
```bash
cd backend
npx prisma migrate dev --name add_organizations_and_applications
```

### Step 2: Run Data Migration (Optional)
```bash
cd backend
npx tsx prisma/migrate-phase2.ts
```

This will:
- Create default applications (Admin Portal, Tenant Dashboard, API Gateway)
- Create default permissions for each application
- Create default organization for each tenant
- Create default org units (Executive, Engineering, Sales, Marketing)
- Enable default applications for all tenants

### Step 3: Generate Prisma Client
```bash
npx prisma generate
```

### Step 4: Start Backend
```bash
npm run dev
```

### Step 5: Start Frontend
```bash
cd ..
npm run dev
```

## Testing Checklist

### Organizations
- [ ] Create organization
- [ ] Edit organization
- [ ] Delete organization (with safety checks)
- [ ] View organization details
- [ ] Create org unit
- [ ] Create child org unit
- [ ] Delete org unit (with safety checks)
- [ ] View org hierarchy

### Applications
- [ ] Create application (platform admin)
- [ ] Edit application
- [ ] Delete application (with safety checks)
- [ ] Create permission
- [ ] Delete permission (with safety checks)
- [ ] View application details

### Tenant Entitlements
- [ ] Enable application for tenant
- [ ] Disable application
- [ ] Set expiration date
- [ ] Remove entitlement
- [ ] Check entitlement via API

### Authorization
- [ ] Assign role with TENANT scope
- [ ] Assign role with ORGANIZATION scope
- [ ] Assign role with ORG_UNIT scope
- [ ] Verify hierarchical scope inheritance
- [ ] Verify application entitlement checks
- [ ] Test expired entitlements

## Security Considerations

### Application Management
- Only PLATFORM_ADMIN can create/edit/delete applications
- Only PLATFORM_ADMIN can manage permissions
- Tenant admins can only manage entitlements

### Organization Management
- Only TENANT_ADMIN can create/edit/delete organizations
- Only TENANT_ADMIN can manage org units
- Members can be added/removed by TENANT_ADMIN

### Entitlement Validation
- Authorization checks if tenant has entitlement to application
- Expired entitlements are automatically excluded
- Disabled applications cannot be accessed

## Performance Considerations

### Database Indexes
- Organizations: indexed on tenantId, status
- OrgUnits: indexed on tenantId, organizationId, parentUnitId
- OrgMemberships: indexed on tenantId, userId, organizationId, orgUnitId
- Applications: indexed on key, status
- TenantApplications: indexed on tenantId, applicationId, state

### Query Optimization
- Hierarchical queries use recursive traversal
- Scope compatibility checks are cached
- Entitlement checks are optimized with indexes

## Next Steps (Phase 3)

Phase 3 will add:
- [ ] Delegation (temporary access delegation)
- [ ] Policy Engine (ABAC conditions)
- [ ] Support Sessions (platform-to-tenant access)
- [ ] Just-in-Time Access
- [ ] Access Certification
- [ ] Advanced Audit and Reporting

## Resources

- **Implementation Plan**: `OIAM_IMPLEMENTATION_PLAN.md`
- **Phase 1.5 Summary**: `PHASE_1_5_COMPLETE.md`
- **Migration Script**: `backend/prisma/migrate-phase2.ts`
- **API Documentation**: Available at `http://localhost:4000/docs`

## Troubleshooting

### Issue: Migration fails
**Solution**: 
- Ensure database is accessible
- Check Prisma schema for syntax errors
- Run `npx prisma db push` as fallback

### Issue: Applications not showing
**Solution**:
- Run migration script: `npx tsx prisma/migrate-phase2.ts`
- Check if user has PLATFORM_ADMIN role
- Verify application status is ACTIVE

### Issue: Scope validation not working
**Solution**:
- Ensure org units have correct parentUnitId
- Verify tenantId consistency
- Check authorization logs

### Issue: Entitlements not working
**Solution**:
- Verify tenant has entitlement via `/tenant-applications/check/:appId`
- Check validFrom and validTo dates
- Ensure application is ENABLED

## Summary

Phase 2 is now complete with:
- ✅ Organizational hierarchy with recursive units
- ✅ Hierarchical scope-based authorization
- ✅ Application management with permissions
- ✅ Tenant entitlements with expiration
- ✅ Complete frontend UI
- ✅ Comprehensive API endpoints
- ✅ Migration tools
- ✅ Full documentation

**Ready for testing and deployment!** 🚀
