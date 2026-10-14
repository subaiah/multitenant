# OIAM Implementation Plan

## Overview

This document provides a detailed, phased implementation plan to evolve the current multi-tenant RBAC system into a comprehensive Organization, Identity & Access Management (OIAM) architecture based on the specification in `OIAM_ARCHITECTURE.md`.

## Current State (Phase 1 - Complete)

✅ **Implemented:**
- Multi-tenant architecture with tenant isolation
- User types (PLATFORM_ADMIN, TENANT_ADMIN, etc.)
- Custom roles with permissions
- Role assignments to users
- BFF authentication with refresh tokens
- Audit logging
- Basic RBAC evaluation

## Implementation Phases

### Phase 1.5: Enhanced Foundation (Weeks 1-3)
**Goal:** Add groups and scope-based role assignments

### Phase 2: Enterprise Features (Weeks 4-8)
**Goal:** Add organizational hierarchy and application entitlements

### Phase 3: Advanced Governance (Weeks 9-14)
**Goal:** Add delegation, policies, and advanced features

---

## Phase 1.5: Enhanced Foundation (Weeks 1-3)

### Week 1: Database Schema Updates

#### 1.1 Add Groups Tables

**File:** `backend/prisma/schema.prisma`

```prisma
// Add after existing models

model Group {
  id          String   @id @default(uuid())
  tenantId    String   @map("tenant_id")
  name        String
  description String?
  groupType   String   @default("MANUAL") @map("group_type") // MANUAL, SYNCED, RULE_BASED
  status      String   @default("ACTIVE")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  
  // Relations
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  members     GroupMembership[]
  roleAssignments RoleAssignment[]
  
  @@unique([tenantId, name])
  @@index([tenantId])
  @@index([status])
  @@map("groups")
}

model GroupMembership {
  id        String    @id @default(uuid())
  tenantId  String    @map("tenant_id")
  groupId   String    @map("group_id")
  userId    String    @map("user_id")
  validFrom DateTime  @default(now()) @map("valid_from")
  validTo   DateTime? @map("valid_to")
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")
  
  // Relations
  tenant    Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  group     Group     @relation(fields: [groupId], references: [id], onDelete: Cascade)
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  @@unique([tenantId, groupId, userId])
  @@index([tenantId, userId])
  @@index([groupId])
  @@index([validFrom, validTo])
  @@map("group_memberships")
}
```

#### 1.2 Enhance Role Assignments with Scope

**File:** `backend/prisma/schema.prisma`

```prisma
// Replace existing UserRole model with enhanced RoleAssignment

model RoleAssignment {
  id            String    @id @default(uuid())
  tenantId      String    @map("tenant_id")
  roleId        String    @map("role_id")
  principalType String    @map("principal_type") // USER, GROUP
  userId        String?   @map("user_id")
  groupId       String?   @map("group_id")
  scopeType     String    @default("TENANT") @map("scope_type") // TENANT, ORGANIZATION, ORG_UNIT, RESOURCE
  scopeId       String    @map("scope_id")
  validFrom     DateTime  @default(now()) @map("valid_from")
  validTo       DateTime? @map("valid_to")
  status        String    @default("ACTIVE")
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")
  
  // Relations
  tenant        Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  role          Role      @relation(fields: [roleId], references: [id], onDelete: Cascade)
  user          User?     @relation(fields: [userId], references: [id], onDelete: Cascade)
  group         Group?    @relation(fields: [groupId], references: [id], onDelete: Cascade)
  
  // Constraints
  @@check(principalType IN ('USER', 'GROUP'))
  @@check(scopeType IN ('TENANT', 'ORGANIZATION', 'ORG_UNIT', 'RESOURCE'))
  @@index([tenantId, userId, status])
  @@index([tenantId, groupId, status])
  @@index([roleId])
  @@index([scopeType, scopeId])
  @@index([validFrom, validTo])
  @@map("role_assignments")
}
```

#### 1.3 Update User Model

**File:** `backend/prisma/schema.prisma`

```prisma
// Add to User model
model User {
  // ... existing fields ...
  
  // Add new relations
  groupMemberships GroupMembership[]
  roleAssignments  RoleAssignment[]
}
```

#### 1.4 Update Tenant Model

**File:** `backend/prisma/schema.prisma`

```prisma
// Add to Tenant model
model Tenant {
  // ... existing fields ...
  
  // Add new relations
  groups            Group[]
  groupMemberships  GroupMembership[]
  roleAssignments   RoleAssignment[]
}
```

#### 1.5 Run Migration

```bash
cd backend
npx prisma migrate dev --name add-groups-and-scoped-assignments
```

### Week 2: Backend API Implementation

#### 2.1 Create Groups Routes

**File:** `backend/src/routes/groups.ts`

```typescript
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
import { requireUserType, requireTenantAccess } from '../utils/authorization.js';

const createGroupSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().optional(),
  groupType: z.enum(['MANUAL', 'SYNCED', 'RULE_BASED']).default('MANUAL'),
});

const updateGroupSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

export const groupRoutes: FastifyPluginAsync = async (fastify) => {
  // List groups for current tenant
  fastify.get('/', {
    schema: {
      tags: ['groups'],
      summary: 'List groups for current tenant',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', default: '1' },
          limit: { type: 'string', default: '20' },
          search: { type: 'string' },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const tenantId = request.tenant.id;
    const { page = '1', limit = '20', search, status } = request.query as any;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const where = {
      tenantId,
      AND: [
        status ? { status } : {},
        search ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
          ],
        } : {},
      ],
    };
    
    const [groups, total] = await Promise.all([
      prisma.group.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: { members: true },
          },
        },
      }),
      prisma.group.count({ where }),
    ]);
    
    return {
      groups,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  });

  // Get group by ID
  fastify.get('/:id', {
    schema: {
      tags: ['groups'],
      summary: 'Get group by ID',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.tenant.id;
    
    const group = await prisma.group.findFirst({
      where: { id, tenantId },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                userType: true,
              },
            },
          },
        },
        _count: {
          select: { members: true, roleAssignments: true },
        },
      },
    });
    
    if (!group) {
      throw new AppError('Group not found', 404);
    }
    
    return group;
  });

  // Create group
  fastify.post('/', {
    schema: {
      tags: ['groups'],
      summary: 'Create group',
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 100 },
          description: { type: 'string' },
          groupType: { type: 'string', enum: ['MANUAL', 'SYNCED', 'RULE_BASED'] },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const tenantId = request.tenant.id;
    
    // Only admins can create groups
    requireUserType(userType, 'TENANT_ADMIN');
    
    const data = createGroupSchema.parse(request.body);
    
    // Check if group name already exists
    const existing = await prisma.group.findFirst({
      where: { tenantId, name: data.name },
    });
    
    if (existing) {
      throw new AppError('Group name already exists', 409);
    }
    
    const group = await prisma.group.create({
       {
        tenantId,
        ...data,
      },
    });
    
    // Log activity
    await prisma.activity.create({
       {
        tenantId,
        userId,
        action: 'created group',
        target: group.name,
        type: 'CONFIG',
      },
    });
    
    return reply.status(201).send(group);
  });

  // Update group
  fastify.patch('/:id', {
    schema: {
      tags: ['groups'],
      summary: 'Update group',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 100 },
          description: { type: 'string' },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { id } = request.params as { id: string };
    const tenantId = request.tenant.id;
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    const data = updateGroupSchema.parse(request.body);
    
    const group = await prisma.group.update({
      where: { id, tenantId },
      data,
    });
    
    // Log activity
    await prisma.activity.create({
       {
        tenantId,
        userId,
        action: 'updated group',
        target: group.name,
        type: 'CONFIG',
      },
    });
    
    return group;
  });

  // Delete group
  fastify.delete('/:id', {
    schema: {
      tags: ['groups'],
      summary: 'Delete group',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { id } = request.params as { id: string };
    const tenantId = request.tenant.id;
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    // Check if group has members
    const memberCount = await prisma.groupMembership.count({
      where: { groupId: id },
    });
    
    if (memberCount > 0) {
      throw new AppError('Cannot delete group with members. Remove all members first.', 400);
    }
    
    // Check if group has role assignments
    const assignmentCount = await prisma.roleAssignment.count({
      where: { groupId: id },
    });
    
    if (assignmentCount > 0) {
      throw new AppError('Cannot delete group with role assignments. Remove all assignments first.', 400);
    }
    
    const group = await prisma.group.delete({
      where: { id, tenantId },
    });
    
    // Log activity
    await prisma.activity.create({
       {
        tenantId,
        userId,
        action: 'deleted group',
        target: group.name,
        type: 'CONFIG',
      },
    });
    
    return reply.status(204).send();
  });

  // Add member to group
  fastify.post('/:id/members', {
    schema: {
      tags: ['groups'],
      summary: 'Add member to group',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
          validFrom: { type: 'string', format: 'date-time' },
          validTo: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { id: groupId } = request.params as { id: string };
    const tenantId = request.tenant.id;
    const { userId: memberUserId, validFrom, validTo } = request.body as any;
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    // Verify group exists
    const group = await prisma.group.findFirst({
      where: { id: groupId, tenantId },
    });
    
    if (!group) {
      throw new AppError('Group not found', 404);
    }
    
    // Verify user exists and belongs to tenant
    const user = await prisma.user.findFirst({
      where: { id: memberUserId, tenantId },
    });
    
    if (!user) {
      throw new AppError('User not found', 404);
    }
    
    // Check if already a member
    const existing = await prisma.groupMembership.findFirst({
      where: { groupId, userId: memberUserId },
    });
    
    if (existing) {
      throw new AppError('User is already a member of this group', 409);
    }
    
    const membership = await prisma.groupMembership.create({
       {
        tenantId,
        groupId,
        userId: memberUserId,
        validFrom: validFrom ? new Date(validFrom) : new Date(),
        validTo: validTo ? new Date(validTo) : null,
      },
    });
    
    // Log activity
    await prisma.activity.create({
       {
        tenantId,
        userId,
        action: 'added member to group',
        target: `${user.email} to ${group.name}`,
        type: 'USER',
      },
    });
    
    return reply.status(201).send(membership);
  });

  // Remove member from group
  fastify.delete('/:id/members/:userId', {
    schema: {
      tags: ['groups'],
      summary: 'Remove member from group',
      params: {
        type: 'object',
        required: ['id', 'userId'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          userId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).userId;
    const userType = (request.user as any).userType;
    const { id: groupId, userId: memberUserId } = request.params as { id: string; userId: string };
    const tenantId = request.tenant.id;
    
    requireUserType(userType, 'TENANT_ADMIN');
    
    await prisma.groupMembership.deleteMany({
      where: { groupId, userId: memberUserId, tenantId },
    });
    
    // Log activity
    await prisma.activity.create({
       {
        tenantId,
        userId,
        action: 'removed member from group',
        target: `user ${memberUserId} from group ${groupId}`,
        type: 'USER',
      },
    });
    
    return reply.status(204).send();
  });
};
```

#### 2.2 Update Role Assignment Routes

**File:** `backend/src/routes/roles.ts`

Add scope support to existing role assignment endpoints:

```typescript
// Update create role assignment endpoint
fastify.post('/assign', {
  schema: {
    tags: ['roles'],
    summary: 'Assign role to user or group',
    body: {
      type: 'object',
      required: ['roleId', 'principalType'],
      properties: {
        roleId: { type: 'string', format: 'uuid' },
        principalType: { type: 'string', enum: ['USER', 'GROUP'] },
        userId: { type: 'string', format: 'uuid' },
        groupId: { type: 'string', format: 'uuid' },
        scopeType: { type: 'string', enum: ['TENANT', 'ORGANIZATION', 'ORG_UNIT', 'RESOURCE'], default: 'TENANT' },
        scopeId: { type: 'string', format: 'uuid' },
        validFrom: { type: 'string', format: 'date-time' },
        validTo: { type: 'string', format: 'date-time' },
      },
    },
  },
}, async (request, reply) => {
  const userId = (request.user as any).userId;
  const userType = (request.user as any).userType;
  const tenantId = request.tenant.id;
  
  const {
    roleId,
    principalType,
    userId: targetUserId,
    groupId,
    scopeType = 'TENANT',
    scopeId = tenantId,
    validFrom,
    validTo,
  } = request.body as any;
  
  requireUserType(userType, 'TENANT_ADMIN');
  
  // Validate principal
  if (principalType === 'USER' && !targetUserId) {
    throw new AppError('userId is required for USER principal', 400);
  }
  if (principalType === 'GROUP' && !groupId) {
    throw new AppError('groupId is required for GROUP principal', 400);
  }
  
  // Verify role exists
  const role = await prisma.role.findFirst({
    where: { id: roleId, tenantId },
  });
  
  if (!role) {
    throw new AppError('Role not found', 404);
  }
  
  // Verify principal exists
  if (principalType === 'USER') {
    const user = await prisma.user.findFirst({
      where: { id: targetUserId, tenantId },
    });
    if (!user) {
      throw new AppError('User not found', 404);
    }
  } else {
    const group = await prisma.group.findFirst({
      where: { id: groupId, tenantId },
    });
    if (!group) {
      throw new AppError('Group not found', 404);
    }
  }
  
  // Check for existing assignment
  const existing = await prisma.roleAssignment.findFirst({
    where: {
      tenantId,
      roleId,
      principalType,
      ...(principalType === 'USER' ? { userId: targetUserId } : { groupId }),
      scopeType,
      scopeId,
    },
  });
  
  if (existing) {
    throw new AppError('Role already assigned with this scope', 409);
  }
  
  const assignment = await prisma.roleAssignment.create({
     {
      tenantId,
      roleId,
      principalType,
      userId: principalType === 'USER' ? targetUserId : null,
      groupId: principalType === 'GROUP' ? groupId : null,
      scopeType,
      scopeId,
      validFrom: validFrom ? new Date(validFrom) : new Date(),
      validTo: validTo ? new Date(validTo) : null,
    },
  });
  
  // Log activity
  await prisma.activity.create({
     {
      tenantId,
      userId,
      action: 'assigned role',
      target: `${role.name} to ${principalType === 'USER' ? targetUserId : groupId}`,
      type: 'USER',
    },
  });
  
  return reply.status(201).send(assignment);
});
```

#### 2.3 Enhance Authorization Logic

**File:** `backend/src/utils/authorization.ts`

Update the `hasPermission` function to support groups and scope:

```typescript
/**
 * Check if user has a specific permission with scope validation
 */
export async function hasPermission(
  userId: string,
  tenantId: string,
  resource: string,
  action: string,
  scopeType?: string,
  scopeId?: string
): Promise<boolean> {
  const permString = `${resource}:${action}`;
  
  // 1. Check direct user assignments
  const directAssignments = await prisma.roleAssignment.findMany({
    where: {
      tenantId,
      userId,
      principalType: 'USER',
      status: 'ACTIVE',
      validFrom: { lte: new Date() },
      OR: [
        { validTo: null },
        { validTo: { gt: new Date() } },
      ],
    },
    include: {
      role: {
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      },
    },
  });
  
  // 2. Check group-based assignments
  const groupMemberships = await prisma.groupMembership.findMany({
    where: {
      tenantId,
      userId,
      validFrom: { lte: new Date() },
      OR: [
        { validTo: null },
        { validTo: { gt: new Date() } },
      ],
    },
    select: { groupId: true },
  });
  
  const groupAssignments = await prisma.roleAssignment.findMany({
    where: {
      tenantId,
      groupId: { in: groupMemberships.map(m => m.groupId) },
      principalType: 'GROUP',
      status: 'ACTIVE',
      validFrom: { lte: new Date() },
      OR: [
        { validTo: null },
        { validTo: { gt: new Date() } },
      ],
    },
    include: {
      role: {
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      },
    },
  });
  
  // 3. Combine all assignments
  const allAssignments = [...directAssignments, ...groupAssignments];
  
  // 4. Filter by scope if provided
  let validAssignments = allAssignments;
  if (scopeType && scopeId) {
    validAssignments = allAssignments.filter(assignment => {
      // Check if assignment scope is compatible with requested scope
      return isScopeCompatible(assignment.scopeType, assignment.scopeId, scopeType, scopeId);
    });
  }
  
  // 5. Check for wildcard permissions
  const hasWildcard = validAssignments.some(assignment =>
    assignment.role.permissions.some(rp => {
      const perm = rp.permission.name;
      return perm === '*:*' || 
             perm === `${resource}:*` || 
             perm === `*:${action}` ||
             perm === permString;
    })
  );
  
  if (hasWildcard) {
    return true;
  }
  
  // 6. Check for explicit permission
  return validAssignments.some(assignment =>
    assignment.role.permissions.some(rp => rp.permission.name === permString)
  );
}

/**
 * Check if assignment scope is compatible with requested scope
 */
function isScopeCompatible(
  assignmentScopeType: string,
  assignmentScopeId: string,
  requestedScopeType: string,
  requestedScopeId: string
): boolean {
  // Exact match
  if (assignmentScopeType === requestedScopeType && assignmentScopeId === requestedScopeId) {
    return true;
  }
  
  // Tenant scope covers everything in tenant
  if (assignmentScopeType === 'TENANT' && assignmentScopeId === requestedScopeId) {
    return true;
  }
  
  // TODO: Add hierarchical scope checking for ORGANIZATION and ORG_UNIT
  // This will be implemented in Phase 2 when org hierarchy is added
  
  return false;
}
```

### Week 3: Frontend Implementation

#### 3.1 Create Groups Management Page

**File:** `src/pages/Groups.tsx`

Create a comprehensive groups management page with:
- List all groups with search and filters
- Create new group
- Edit group details
- Delete group
- Manage group members (add/remove)
- View group role assignments

#### 3.2 Update Role Assignment UI

**File:** `src/pages/Roles.tsx` (or create new)

Enhance role assignment interface to support:
- Select principal type (User or Group)
- Select scope type (Tenant, Organization, Org Unit, Resource)
- Set validity period
- View all assignments with filters

#### 3.3 Update Header User Dropdown

**File:** `src/components/Header.tsx`

Add "Groups" link to the dropdown menu for quick access.

### Week 3: Testing and Migration

#### 3.1 Create Migration Script

**File:** `backend/prisma/migrate-existing-assignments.ts`

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function migrateExistingAssignments() {
  console.log('Starting migration of existing role assignments...');
  
  // Get all existing UserRole records
  const existingAssignments = await prisma.userRole.findMany({
    include: {
      user: true,
      role: true,
    },
  });
  
  console.log(`Found ${existingAssignments.length} existing assignments to migrate`);
  
  for (const assignment of existingAssignments) {
    // Create new RoleAssignment with TENANT scope
    await prisma.roleAssignment.create({
       {
        tenantId: assignment.user.tenantId,
        roleId: assignment.roleId,
        principalType: 'USER',
        userId: assignment.userId,
        groupId: null,
        scopeType: 'TENANT',
        scopeId: assignment.user.tenantId,
        validFrom: assignment.createdAt,
        validTo: null,
        status: 'ACTIVE',
      },
    });
  }
  
  console.log('Migration completed successfully');
  
  // Optional: Delete old UserRole records after verification
  // await prisma.userRole.deleteMany({});
}

migrateExistingAssignments()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

#### 3.2 Write Tests

Create comprehensive tests for:
- Group CRUD operations
- Group membership management
- Scoped role assignments
- Authorization with groups
- Authorization with scope validation

---

## Phase 2: Enterprise Features (Weeks 4-8)

### Week 4-5: Organizational Hierarchy

#### 4.1 Database Schema

Add organizations and org units:

```prisma
model Organization {
  id          String   @id @default(uuid())
  tenantId    String   @map("tenant_id")
  name        String
  description String?
  status      String   @default("ACTIVE")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  units       OrgUnit[]
  memberships OrgMembership[]
  
  @@unique([tenantId, name])
  @@map("organizations")
}

model OrgUnit {
  id          String   @id @default(uuid())
  tenantId    String   @map("tenant_id")
  organizationId String @map("organization_id")
  parentUnitId String? @map("parent_unit_id")
  unitType    String   @map("unit_type") // DIVISION, DEPARTMENT, TEAM, LOCATION
  name        String
  description String?
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  parent      OrgUnit? @relation("OrgUnitHierarchy", fields: [parentUnitId], references: [id])
  children    OrgUnit[] @relation("OrgUnitHierarchy")
  memberships OrgMembership[]
  
  @@index([tenantId, organizationId])
  @@index([parentUnitId])
  @@map("org_units")
}

model OrgMembership {
  id                String   @id @default(uuid())
  tenantId          String   @map("tenant_id")
  userId            String   @map("user_id")
  organizationId    String?  @map("organization_id")
  orgUnitId         String?  @map("org_unit_id")
  createdAt         DateTime @default(now()) @map("created_at")
  
  tenant            Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization      Organization? @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  orgUnit           OrgUnit? @relation(fields: [orgUnitId], references: [id], onDelete: Cascade)
  
  @@unique([tenantId, userId, organizationId, orgUnitId])
  @@map("org_memberships")
}
```

#### 4.2 Backend APIs

Create routes for:
- Organization CRUD
- Org unit CRUD (with hierarchical structure)
- Org membership management
- Update scope validation to traverse hierarchy

#### 4.3 Frontend UI

Create pages for:
- Organization management
- Org unit tree view
- Org membership assignment

### Week 6-7: Application Entitlements

#### 5.1 Database Schema

```prisma
model Application {
  id          String   @id @default(uuid())
  key         String   @unique
  name        String
  description String?
  version     String
  status      String   @default("ACTIVE")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  
  permissions Permission[]
  tenantApplications TenantApplication[]
  
  @@map("applications")
}

model TenantApplication {
  id            String   @id @default(uuid())
  tenantId      String   @map("tenant_id")
  applicationId String   @map("application_id")
  state         String   @default("ENABLED") // ENABLED, DISABLED, TRIAL
  validFrom     DateTime @default(now()) @map("valid_from")
  validTo       DateTime? @map("valid_to")
  createdAt     DateTime @default(now()) @map("created_at")
  
  tenant        Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  application   Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  
  @@unique([tenantId, applicationId])
  @@map("tenant_applications")
}
```

#### 5.2 Permission Manifest System

Create application-owned permission catalogs with versioning.

#### 5.3 Entitlement Validation

Update authorization logic to check tenant application entitlements.

### Week 8: Testing and Integration

- End-to-end testing of organizational hierarchy
- Application entitlement validation
- Scope-based authorization with org hierarchy
- Performance testing with large datasets

---

## Phase 3: Advanced Governance (Weeks 9-14)

### Week 9-10: Delegation

Implement temporary delegation with:
- Delegation creation with expiry
- Scope restrictions (intersection of delegator and delegate)
- Audit trail for delegated actions
- Automatic expiry handling

### Week 11-12: Policy Engine

Implement basic ABAC policy engine:
- Policy definition with conditions
- Policy evaluation in authorization flow
- Policy versioning
- Policy testing tools

### Week 13-14: Support Sessions and Advanced Features

- Platform support sessions for tenant access
- Just-in-time access requests
- Access certification workflows
- Advanced audit and reporting

---

## Success Criteria

### Phase 1.5 Success Criteria

- [ ] Groups can be created, edited, and deleted
- [ ] Users can be added to and removed from groups
- [ ] Roles can be assigned to groups
- [ ] Role assignments support explicit scope
- [ ] Authorization evaluates both direct and group-based permissions
- [ ] Scope validation prevents unauthorized access
- [ ] Existing role assignments migrated successfully
- [ ] All tests passing
- [ ] Documentation updated

### Phase 2 Success Criteria

- [ ] Organizations and org units can be managed
- [ ] Hierarchical scope traversal works correctly
- [ ] Application entitlements control access
- [ ] Permission manifests are versioned
- [ ] Performance is acceptable with large datasets

### Phase 3 Success Criteria

- [ ] Delegation works with proper expiry
- [ ] Policies can be defined and evaluated
- [ ] Support sessions are properly controlled
- [ ] All audit trails are complete
- [ ] Security review passed

---

## Risk Mitigation

### Data Migration Risks

- **Risk:** Data loss during migration
- **Mitigation:** Backup before migration, test on staging first, rollback plan

### Performance Risks

- **Risk:** Authorization checks become slow
- **Mitigation:** Implement caching, optimize queries, monitor performance

### Security Risks

- **Risk:** Scope validation bypass
- **Mitigation:** Comprehensive testing, security review, penetration testing

### Compatibility Risks

- **Risk:** Breaking existing integrations
- **Mitigation:** Version APIs, maintain backward compatibility, deprecation notices

---

## Resource Requirements

### Team Composition

- 1 Backend Engineer (full-time)
- 1 Frontend Engineer (full-time)
- 1 Database Engineer (part-time)
- 1 Security Engineer (part-time, Phase 2-3)
- 1 QA Engineer (part-time)
- 1 Product Owner (part-time)

### Infrastructure

- Development database
- Staging environment
- Performance testing environment
- Monitoring and logging

### Timeline

- **Phase 1.5:** 3 weeks
- **Phase 2:** 5 weeks
- **Phase 3:** 6 weeks
- **Total:** 14 weeks (3.5 months)

---

## Next Steps

1. **Review and approve this implementation plan**
2. **Set up development environment**
3. **Begin Phase 1.5 implementation**
4. **Schedule weekly progress reviews**
5. **Plan for Phase 2 during Phase 1.5**

---

## Appendix: API Endpoints Summary

### Phase 1.5 APIs

**Groups:**
- `GET /tenants/{tenantId}/groups`
- `POST /tenants/{tenantId}/groups`
- `GET /tenants/{tenantId}/groups/{id}`
- `PATCH /tenants/{tenantId}/groups/{id}`
- `DELETE /tenants/{tenantId}/groups/{id}`
- `POST /tenants/{tenantId}/groups/{id}/members`
- `DELETE /tenants/{tenantId}/groups/{id}/members/{userId}`

**Enhanced Role Assignments:**
- `POST /tenants/{tenantId}/role-assignments` (with scope)
- `GET /tenants/{tenantId}/role-assignments` (with filters)
- `DELETE /tenants/{tenantId}/role-assignments/{id}`

### Phase 2 APIs

**Organizations:**
- `GET /tenants/{tenantId}/organizations`
- `POST /tenants/{tenantId}/organizations`
- `GET /tenants/{tenantId}/organizations/{id}`
- `PATCH /tenants/{tenantId}/organizations/{id}`
- `DELETE /tenants/{tenantId}/organizations/{id}`

**Org Units:**
- `GET /organizations/{orgId}/units`
- `POST /organizations/{orgId}/units`
- `GET /org-units/{id}`
- `PATCH /org-units/{id}`
- `DELETE /org-units/{id}`

**Applications:**
- `GET /applications`
- `POST /applications`
- `GET /tenants/{tenantId}/applications`
- `POST /tenants/{tenantId}/applications/{appId}/entitlement`

### Phase 3 APIs

**Delegation:**
- `POST /tenants/{tenantId}/delegations`
- `GET /tenants/{tenantId}/delegations`
- `DELETE /tenants/{tenantId}/delegations/{id}`

**Policies:**
- `GET /tenants/{tenantId}/policies`
- `POST /tenants/{tenantId}/policies`
- `PATCH /tenants/{tenantId}/policies/{id}`
- `DELETE /tenants/{tenantId}/policies/{id}`

---

## Conclusion

This implementation plan provides a clear, phased approach to evolving the current RBAC system into a comprehensive OIAM architecture. Each phase builds on the previous one, allowing for incremental delivery and validation. The plan prioritizes high-value features (groups, scope-based assignments) while laying the groundwork for advanced capabilities (organizational hierarchy, policies, delegation).

**Recommended immediate action:** Begin Phase 1.5 implementation starting with database schema updates.
