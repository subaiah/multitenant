# Phase 1.5 Quick Start Guide

## Overview
This guide will help you test the new Groups and Scoped Role Assignments features implemented in Phase 1.5.

## Prerequisites
- Backend server running
- Database accessible
- Valid authentication token
- Tenant ID for testing

## Step 1: Run Database Migration

```bash
cd backend
npx prisma migrate dev --name add-groups-and-scoped-assignments
```

This will:
- Create `groups` table
- Create `group_memberships` table
- Create `role_assignments` table
- Keep legacy `user_roles` table for backward compatibility

## Step 2: Migrate Existing Assignments

```bash
cd backend
npx tsx prisma/migrate-assignments.ts
```

This will:
- Copy all existing UserRole records to RoleAssignment
- Set scope to TENANT for all migrated assignments
- Report migration statistics

**Expected Output:**
```
Starting migration of existing role assignments...
Found X existing assignments to migrate
Migration completed:
  - Migrated: X
  - Skipped (duplicates): 0
  - Total processed: X
```

## Step 3: Start Backend Server

```bash
cd backend
npm run dev
```

Server should start on `http://localhost:4000`

## Step 4: Test Groups API

### 4.1 Create a Group

```bash
curl -X POST http://localhost:4000/groups \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-tenant-id: YOUR_TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Engineering Team",
    "description": "All engineering staff",
    "groupType": "MANUAL"
  }'
```

**Expected Response:**
```json
{
  "id": "uuid",
  "tenantId": "uuid",
  "name": "Engineering Team",
  "description": "All engineering staff",
  "groupType": "MANUAL",
  "status": "ACTIVE",
  "createdAt": "2024-01-XXT...",
  "updatedAt": "2024-01-XXT..."
}
```

### 4.2 List Groups

```bash
curl -X GET http://localhost:4000/groups \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-tenant-id: YOUR_TENANT_ID"
```

**Expected Response:**
```json
{
  "groups": [
    {
      "id": "uuid",
      "name": "Engineering Team",
      "description": "All engineering staff",
      "groupType": "MANUAL",
      "status": "ACTIVE",
      "_count": {
        "members": 0
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "pages": 1
  }
}
```

### 4.3 Add Member to Group

First, get a user ID:
```bash
curl -X GET http://localhost:4000/users \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-tenant-id: YOUR_TENANT_ID"
```

Then add to group:
```bash
curl -X POST http://localhost:4000/groups/GROUP_ID/members \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-tenant-id: YOUR_TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "USER_ID",
    "validFrom": "2024-01-01T00:00:00Z",
    "validTo": "2024-12-31T23:59:59Z"
  }'
```

### 4.4 Get Group Details

```bash
curl -X GET http://localhost:4000/groups/GROUP_ID \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-tenant-id: YOUR_TENANT_ID"
```

**Expected Response:**
```json
{
  "id": "uuid",
  "name": "Engineering Team",
  "description": "All engineering staff",
  "members": [
    {
      "id": "uuid",
      "user": {
        "id": "uuid",
        "email": "user@example.com",
        "name": "User Name",
        "userType": "TENANT_USER"
      }
    }
  ],
  "_count": {
    "members": 1,
    "roleAssignments": 0
  }
}
```

## Step 5: Test Scoped Role Assignments

### 5.1 Create a Role (if not exists)

```bash
curl -X POST http://localhost:4000/roles \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-tenant-id: YOUR_TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Developer",
    "description": "Developer role with app access",
    "permissions": ["applications:read", "applications:create"]
  }'
```

### 5.2 Assign Role to User with Scope

```bash
curl -X POST http://localhost:4000/roles/assign \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-tenant-id: YOUR_TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "roleId": "ROLE_ID",
    "principalType": "USER",
    "userId": "USER_ID",
    "scopeType": "TENANT",
    "scopeId": "YOUR_TENANT_ID",
    "validFrom": "2024-01-01T00:00:00Z",
    "validTo": "2024-12-31T23:59:59Z"
  }'
```

### 5.3 Assign Role to Group with Scope

```bash
curl -X POST http://localhost:4000/roles/assign \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-tenant-id: YOUR_TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "roleId": "ROLE_ID",
    "principalType": "GROUP",
    "groupId": "GROUP_ID",
    "scopeType": "TENANT",
    "scopeId": "YOUR_TENANT_ID"
  }'
```

### 5.4 Get User Roles and Assignments

```bash
curl -X GET http://localhost:4000/roles/user/USER_ID \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-tenant-id: YOUR_TENANT_ID"
```

**Expected Response:**
```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "User Name",
    "userType": "TENANT_USER"
  },
  "roles": [
    {
      "id": "uuid",
      "name": "Developer",
      "description": "Developer role",
      "permissions": ["applications:read", "applications:create"]
    }
  ],
  "roleAssignments": [
    {
      "id": "uuid",
      "roleId": "uuid",
      "roleName": "Developer",
      "roleDescription": "Developer role",
      "scopeType": "TENANT",
      "scopeId": "uuid",
      "validFrom": "2024-01-01T00:00:00Z",
      "validTo": "2024-12-31T23:59:59Z",
      "permissions": ["applications:read", "applications:create"]
    }
  ],
  "groups": [
    {
      "id": "uuid",
      "name": "Engineering Team",
      "description": "All engineering staff",
      "validFrom": "2024-01-01T00:00:00Z",
      "validTo": "2024-12-31T23:59:59Z"
    }
  ]
}
```

## Step 6: Test Authorization

### 6.1 Test Permission Check

Create a test endpoint or use existing protected endpoint to verify:
- Direct user assignments work
- Group-based assignments work
- Scope validation works
- Validity periods are enforced

Example test scenario:
1. Assign role to group with TENANT scope
2. Add user to group
3. Verify user has permissions from group role
4. Remove user from group
5. Verify user no longer has permissions

## Step 7: Test Edge Cases

### 7.1 Expired Assignment
```bash
# Create assignment with past expiry
curl -X POST http://localhost:4000/roles/assign \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-tenant-id: YOUR_TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "roleId": "ROLE_ID",
    "principalType": "USER",
    "userId": "USER_ID",
    "scopeType": "TENANT",
    "scopeId": "YOUR_TENANT_ID",
    "validFrom": "2023-01-01T00:00:00Z",
    "validTo": "2023-12-31T23:59:59Z"
  }'

# Verify user does NOT have permissions from this assignment
```

### 7.2 Duplicate Assignment
```bash
# Try to assign same role to same user with same scope twice
# Should return 409 Conflict
```

### 7.3 Group Deletion with Members
```bash
# Try to delete group that has members
# Should return 400 Bad Request
```

## Step 8: Verify Backward Compatibility

### 8.1 Check Legacy UserRole Still Works
```bash
# Query old UserRole table
npx prisma studio
# Navigate to UserRole table
# Verify records still exist
```

### 8.2 Check Authorization Aggregates Both
```bash
# User should have permissions from:
# 1. Legacy UserRole assignments
# 2. New RoleAssignment assignments
# 3. Group-based RoleAssignment assignments
```

## Troubleshooting

### Issue: Migration fails
**Solution:** 
- Check database connection
- Ensure Prisma client is generated: `npx prisma generate`
- Check for schema syntax errors

### Issue: Groups API returns 404
**Solution:**
- Verify routes are registered in server.ts
- Check authentication token is valid
- Verify tenant ID in header

### Issue: Authorization not working with groups
**Solution:**
- Verify user is member of group
- Verify group has role assignment
- Check validity periods
- Check scope compatibility

### Issue: Duplicate assignments after migration
**Solution:**
- Migration script checks for duplicates
- Re-run migration with clean database
- Manually remove duplicates

## Next Steps

After successful testing:
1. ✅ Backend implementation complete
2. ⏳ Frontend implementation (Week 3)
3. ⏳ Comprehensive test suite
4. ⏳ Documentation updates
5. ⏳ Code review

## Support

If you encounter issues:
1. Check `PHASE_1_5_PROGRESS.md` for implementation details
2. Review API documentation in route files
3. Check authorization logic in `utils/authorization.ts`
4. Review migration script for data issues

## Success Criteria

Phase 1.5 is complete when:
- [x] Database schema updated
- [x] Migration script created
- [x] Groups API implemented
- [x] Role assignments enhanced with scope
- [x] Authorization logic updated
- [ ] All tests passing
- [ ] Frontend UI complete
- [ ] Documentation updated
