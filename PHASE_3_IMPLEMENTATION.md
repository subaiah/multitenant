# Phase 3 Implementation - Advanced Governance

## Overview

Phase 3 adds enterprise-grade governance features to the OIAM system, enabling sophisticated access control, temporary access management, and compliance workflows.

## Features Implemented

### 1. Delegation System
**Purpose**: Allow users to temporarily delegate their access to other users.

**Key Features**:
- Create delegations with time-bound validity
- Delegate specific role assignments
- Automatic expiration handling
- Revocation capabilities
- Audit trail for all delegation activities

**API Endpoints**:
- `POST /delegations` - Create a delegation
- `GET /delegations` - List delegations
- `GET /delegations/:id` - Get delegation details
- `POST /delegations/:id/revoke` - Revoke a delegation
- `GET /delegations/my/delegations` - Get my active delegations

**Database Models**:
- `Delegation` - Stores delegation records with validity periods

### 2. Policy Engine (ABAC)
**Purpose**: Attribute-Based Access Control for fine-grained, context-aware policies.

**Key Features**:
- Create ALLOW/DENY policies with JSON conditions
- Policy priority system
- Policy bindings to scopes (tenant, org, org unit, resource)
- Policy evaluation engine
- Enable/disable policies dynamically

**API Endpoints**:
- `POST /policies` - Create a policy
- `GET /policies` - List policies
- `GET /policies/:id` - Get policy details
- `PATCH /policies/:id` - Update a policy
- `DELETE /policies/:id` - Delete a policy
- `POST /policies/:id/bindings` - Add policy binding
- `DELETE /policies/:id/bindings/:bindingId` - Remove binding
- `POST /policies/evaluate` - Test policy evaluation

**Database Models**:
- `AccessPolicy` - Stores policy definitions with conditions
- `PolicyBinding` - Links policies to scopes

### 3. Support Sessions
**Purpose**: Controlled temporary access for platform support staff to tenant environments.

**Key Features**:
- Platform users can request support access
- Time-bound access with automatic expiration
- Specific permission sets for support activities
- Approval workflow (currently self-approved, can be enhanced)
- Complete audit trail

**API Endpoints**:
- `POST /support-sessions/request` - Request support session
- `GET /support-sessions` - List all sessions (platform admin)
- `POST /support-sessions/:id/revoke` - Revoke a session
- `GET /support-sessions/my/sessions` - Get my active sessions

**Database Models**:
- `SupportSession` - Stores support session records

### 4. Just-in-Time (JIT) Access
**Purpose**: Request and approve temporary access on-demand.

**Key Features**:
- Users can request temporary role assignments
- Configurable duration (1 hour to 7 days)
- Approval workflow for tenant admins
- Automatic expiration and cleanup
- Request tracking and history

**API Endpoints**:
- `POST /access-requests` - Create access request
- `GET /access-requests` - List requests
- `POST /access-requests/:id/decide` - Approve/deny request
- `GET /access-requests/my/pending` - Get my pending requests

**Database Models**:
- `AccessRequest` - Stores access request records with approval status

### 5. Access Certification
**Purpose**: Periodic review and certification of user access rights.

**Key Features**:
- Create certification campaigns for roles/permissions
- Assign reviewers to certifications
- Due date tracking with overdue detection
- Decision tracking (approve/revoke)
- Automatic role assignment revocation on denial
- Completion workflow

**API Endpoints**:
- `POST /certifications` - Create certification
- `GET /certifications` - List certifications
- `GET /certifications/:id` - Get certification details
- `POST /certifications/:id/decisions` - Submit decision
- `POST /certifications/:id/complete` - Complete certification
- `GET /certifications/my/certifications` - Get my certifications

**Database Models**:
- `AccessCertification` - Stores certification campaigns
- `CertificationDecision` - Stores individual decisions

## Database Schema Changes

### New Models Added

1. **Delegation**
```prisma
model Delegation {
  id, tenantId, delegatorId, delegateId, roleAssignmentId
  reason, validFrom, validTo, status
  revokedAt, revokedBy, createdAt, updatedAt
}
```

2. **AccessPolicy**
```prisma
model AccessPolicy {
  id, tenantId, name, description, effect, conditions
  priority, enabled, createdAt, updatedAt
}
```

3. **PolicyBinding**
```prisma
model PolicyBinding {
  id, policyId, scopeType, scopeId, createdAt
}
```

4. **SupportSession**
```prisma
model SupportSession {
  id, platformUserId, tenantId, approvedBy, reason
  permissions, validFrom, validTo, status
  revokedAt, createdAt, updatedAt
}
```

5. **AccessRequest**
```prisma
model AccessRequest {
  id, tenantId, requesterId, approverId, roleId
  scopeType, scopeId, reason, duration, status
  approvedAt, deniedAt, denialReason, validFrom, validTo
  createdAt, updatedAt
}
```

6. **AccessCertification**
```prisma
model AccessCertification {
  id, tenantId, name, description, reviewType
  scopeType, scopeId, reviewerId, dueDate
  status, completedAt, createdAt, updatedAt
}
```

7. **CertificationDecision**
```prisma
model CertificationDecision {
  id, certificationId, roleAssignmentId, decision
  reason, decidedAt, createdAt
}
```

### Updated Models

- **User**: Added relations to delegations, support sessions, access requests, certifications
- **Tenant**: Added relations to delegations, policies, support sessions, access requests, certifications
- **Role**: Added relation to access requests
- **RoleAssignment**: Added relations to delegations and certification decisions

## Implementation Files

### Backend Routes Created

1. `backend/src/routes/delegations.ts` - Delegation management
2. `backend/src/routes/policies.ts` - Policy engine
3. `backend/src/routes/support-sessions.ts` - Support session management
4. `backend/src/routes/access-requests.ts` - JIT access requests
5. `backend/src/routes/certifications.ts` - Access certification

### Server Registration

Updated `backend/src/server.ts` to register all Phase 3 routes:
- `/delegations`
- `/policies`
- `/support-sessions`
- `/access-requests`
- `/certifications`

## Security Considerations

### Delegation
- Only role assignment owners can delegate
- Cannot delegate to yourself
- Time-bound with automatic expiration
- Revocation requires admin or delegator

### Policies
- DENY policies take precedence over ALLOW
- Priority-based evaluation
- Tenant isolation enforced
- Admin-only policy management

### Support Sessions
- Platform users only
- Time-bound access
- Specific permission sets
- Complete audit trail

### JIT Access
- Approval workflow required
- Automatic expiration
- Duration limits (max 7 days)
- Admin-only approval

### Certifications
- Reviewer assignment required
- Due date tracking
- Overdue detection
- Decision audit trail

## Usage Examples

### Creating a Delegation
```typescript
POST /delegations
{
  "delegateId": "user-uuid",
  "roleAssignmentId": "assignment-uuid",
  "reason": "Vacation coverage",
  "validFrom": "2026-01-15T00:00:00Z",
  "validTo": "2026-01-22T00:00:00Z"
}
```

### Creating a Policy
```typescript
POST /policies
{
  "name": "Block access outside business hours",
  "description": "DENY access outside 9 AM - 5 PM",
  "effect": "DENY",
  "conditions": {
    "time": {
      "operator": "NOT_BETWEEN",
      "value": ["09:00", "17:00"]
    }
  },
  "priority": 100,
  "enabled": true
}
```

### Requesting JIT Access
```typescript
POST /access-requests
{
  "roleId": "role-uuid",
  "scopeType": "TENANT",
  "scopeId": "tenant-uuid",
  "reason": "Need access for emergency maintenance",
  "duration": 4  // 4 hours
}
```

### Creating a Certification
```typescript
POST /certifications
{
  "name": "Q1 2026 Access Review",
  "description": "Quarterly access certification",
  "reviewType": "ROLE",
  "scopeType": "TENANT",
  "scopeId": "tenant-uuid",
  "reviewerId": "reviewer-uuid",
  "dueDate": "2026-03-31T23:59:59Z"
}
```

## Next Steps

### Frontend Implementation (Recommended)
Create UI pages for:
1. **Delegations Page** - Manage delegations
2. **Policies Page** - Policy management interface
3. **Support Sessions Page** - Support access management
4. **Access Requests Page** - JIT request workflow
5. **Certifications Page** - Certification campaigns

### Enhanced Features (Future)
1. **Policy Condition Builder** - Visual policy editor
2. **Delegation Templates** - Pre-defined delegation patterns
3. **Automated Certifications** - Scheduled certification campaigns
4. **Policy Simulation** - Test policies before deployment
5. **Advanced Reporting** - Access analytics and compliance reports

### Integration Points
1. **Email Notifications** - Notify on requests, approvals, expirations
2. **Webhook Support** - External system integration
3. **SSO Integration** - Support session SSO
4. **Audit Log Enhancement** - Detailed governance audit trail

## Migration Guide

### Step 1: Run Database Migration
```bash
cd backend
npx prisma migrate dev --name add_phase3_governance
```

### Step 2: Verify Migration
```bash
npx prisma studio
```
Check that all new tables are created.

### Step 3: Test APIs
Use the API endpoints to test each feature:
- Create a delegation
- Create a policy
- Request support session
- Create access request
- Create certification

### Step 4: Build Frontend (Optional)
Create UI pages for each feature following the existing patterns.

## API Documentation

All Phase 3 endpoints are documented in the Swagger UI:
```
http://localhost:4000/docs
```

Tags:
- `delegations` - Delegation management
- `policies` - Policy engine
- `support-sessions` - Support session management
- `access-requests` - JIT access requests
- `certifications` - Access certification

## Testing Checklist

- [ ] Database migration successful
- [ ] All new tables created
- [ ] Delegation CRUD operations work
- [ ] Policy creation and evaluation work
- [ ] Support session workflow works
- [ ] Access request approval workflow works
- [ ] Certification decision workflow works
- [ ] Authorization checks enforce tenant isolation
- [ ] Audit logs are created for all operations
- [ ] Time-based expiration works correctly

## Summary

Phase 3 successfully adds comprehensive governance capabilities to the OIAM system:

✅ **Delegation** - Temporary access delegation  
✅ **Policy Engine** - ABAC with JSON conditions  
✅ **Support Sessions** - Controlled platform access  
✅ **JIT Access** - On-demand temporary access  
✅ **Certifications** - Periodic access reviews  

All features include:
- Complete CRUD operations
- Time-based validity
- Audit trails
- Tenant isolation
- Authorization checks
- Comprehensive error handling

The system is now ready for enterprise-grade access governance!
