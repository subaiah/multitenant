# Phase 3 Quick Start Guide

## What's New in Phase 3?

Phase 3 adds **Advanced Governance** features to your OIAM system:

1. **Delegation** - Temporarily delegate your access to others
2. **Policy Engine** - Fine-grained ABAC policies with conditions
3. **Support Sessions** - Controlled platform support access
4. **JIT Access** - Just-in-Time temporary access requests
5. **Certifications** - Periodic access reviews and compliance

## Quick Setup

### Step 1: Run Database Migration

```bash
cd backend
npx prisma migrate dev --name add_phase3_governance
```

This creates 7 new tables:
- `delegations`
- `access_policies`
- `policy_bindings`
- `support_sessions`
- `access_requests`
- `access_certifications`
- `certification_decisions`

### Step 2: Start Backend

```bash
npm run dev
```

### Step 3: Test the APIs

Visit Swagger UI: `http://localhost:4000/docs`

You'll see new tags:
- `delegations`
- `policies`
- `support-sessions`
- `access-requests`
- `certifications`

## Feature Walkthroughs

### 1. Delegation

**Scenario**: You're going on vacation and need to delegate your admin access to a colleague.

```bash
# Create a delegation
curl -X POST http://localhost:4000/delegations \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "delegateId": "colleague-user-id",
    "roleAssignmentId": "your-role-assignment-id",
    "reason": "Vacation coverage",
    "validFrom": "2026-01-15T00:00:00Z",
    "validTo": "2026-01-22T00:00:00Z"
  }'

# View your active delegations
curl http://localhost:4000/delegations/my/delegations \
  -H "Authorization: Bearer YOUR_TOKEN"

# Revoke a delegation
curl -X POST http://localhost:4000/delegations/DELEGATION_ID/revoke \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Returning from vacation"}'
```

### 2. Policy Engine (ABAC)

**Scenario**: Block access outside business hours.

```bash
# Create a DENY policy
curl -X POST http://localhost:4000/policies \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
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
  }'

# Bind policy to tenant scope
curl -X POST http://localhost:4000/policies/POLICY_ID/bindings \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "scopeType": "TENANT",
    "scopeId": "your-tenant-id"
  }'

# Test policy evaluation
curl -X POST http://localhost:4000/policies/evaluate \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-id",
    "action": "read",
    "resource": "applications",
    "context": {
      "time": "20:00"
    }
  }'
```

### 3. Support Sessions

**Scenario**: Platform support needs to access a tenant environment.

```bash
# Request support session
curl -X POST http://localhost:4000/support-sessions/request \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "tenant-id",
    "reason": "Customer reported issue with application deployment",
    "permissions": ["applications.read", "applications.update"],
    "validTo": "2026-01-15T18:00:00Z"
  }'

# View my active support sessions
curl http://localhost:4000/support-sessions/my/sessions \
  -H "Authorization: Bearer YOUR_TOKEN"

# Revoke support session (platform admin)
curl -X POST http://localhost:4000/support-sessions/SESSION_ID/revoke \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 4. Just-in-Time (JIT) Access

**Scenario**: Developer needs temporary admin access for emergency fix.

```bash
# Request temporary access
curl -X POST http://localhost:4000/access-requests \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "roleId": "admin-role-id",
    "scopeType": "TENANT",
    "scopeId": "tenant-id",
    "reason": "Emergency production fix required",
    "duration": 4
  }'

# View my pending requests
curl http://localhost:4000/access-requests/my/pending \
  -H "Authorization: Bearer YOUR_TOKEN"

# Approve request (tenant admin)
curl -X POST http://localhost:4000/access-requests/REQUEST_ID/decide \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "approved": true,
    "reason": "Approved for emergency maintenance"
  }'

# Deny request
curl -X POST http://localhost:4000/access-requests/REQUEST_ID/decide \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "approved": false,
    "reason": "Use standard deployment process"
  }'
```

### 5. Access Certification

**Scenario**: Quarterly access review for compliance.

```bash
# Create certification campaign
curl -X POST http://localhost:4000/certifications \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Q1 2026 Access Review",
    "description": "Quarterly access certification for compliance",
    "reviewType": "ROLE",
    "scopeType": "TENANT",
    "scopeId": "tenant-id",
    "reviewerId": "reviewer-user-id",
    "dueDate": "2026-03-31T23:59:59Z"
  }'

# View my certifications
curl http://localhost:4000/certifications/my/certifications \
  -H "Authorization: Bearer YOUR_TOKEN"

# Submit decision (reviewer)
curl -X POST http://localhost:4000/certifications/CERT_ID/decisions \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "roleAssignmentId": "assignment-id",
    "decision": "APPROVE",
    "reason": "User still requires this access"
  }'

# Revoke access
curl -X POST http://localhost:4000/certifications/CERT_ID/decisions \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "roleAssignmentId": "assignment-id",
    "decision": "REVOKE",
    "reason": "User no longer requires this access"
  }'

# Complete certification
curl -X POST http://localhost:4000/certifications/CERT_ID/complete \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Common Workflows

### Workflow 1: Vacation Coverage
1. Create delegation for your role assignments
2. Set validity period for your vacation dates
3. Colleague receives delegated access
4. Delegation automatically expires when you return

### Workflow 2: Emergency Access
1. User requests JIT access with reason
2. Tenant admin reviews and approves
3. Temporary role assignment created
4. Access automatically expires after duration
5. Audit trail maintained

### Workflow 3: Compliance Review
1. Admin creates certification campaign
2. Reviewer assigned to campaign
3. Reviewer evaluates each role assignment
4. Decisions recorded (approve/revoke)
5. Revoked assignments deactivated
6. Certification marked complete

### Workflow 4: Support Access
1. Platform user requests support session
2. Specific permissions granted
3. Time-bound access created
4. Full audit trail maintained
5. Access automatically expires

## Security Best Practices

### Delegation
✅ Only delegate specific role assignments  
✅ Set reasonable time bounds  
✅ Document the reason for delegation  
✅ Revoke when no longer needed  

### Policies
✅ Start with DENY policies for critical restrictions  
✅ Use ALLOW policies for exceptions  
✅ Set appropriate priorities  
✅ Test policies before enabling  

### Support Sessions
✅ Limit permissions to minimum required  
✅ Set short validity periods  
✅ Document the reason clearly  
✅ Revoke immediately after use  

### JIT Access
✅ Require detailed reasons  
✅ Limit duration to minimum needed  
✅ Require admin approval  
✅ Monitor usage patterns  

### Certifications
✅ Schedule regular reviews (quarterly)  
✅ Assign appropriate reviewers  
✅ Track overdue certifications  
✅ Document all decisions  

## Troubleshooting

### Issue: Delegation creation fails
**Solution**: Ensure you own the role assignment and delegate is in same tenant

### Issue: Policy evaluation returns unexpected result
**Solution**: Check policy priority and conditions. DENY takes precedence.

### Issue: Support session not created
**Solution**: Verify you have PLATFORM_USER or PLATFORM_ADMIN role

### Issue: Access request not approved
**Solution**: Only TENANT_ADMIN can approve requests

### Issue: Certification not completing
**Solution**: Ensure all required decisions are submitted

## Next Steps

### Frontend Implementation
Create UI pages for each feature:
1. Delegations management page
2. Policies management page
3. Support sessions page
4. Access requests page
5. Certifications page

### Advanced Features
1. Email notifications for requests and approvals
2. Automated certification scheduling
3. Policy condition builder UI
4. Delegation templates
5. Advanced reporting and analytics

## Summary

Phase 3 provides enterprise-grade governance with:

✅ **Delegation** - Secure temporary access transfer  
✅ **Policies** - Fine-grained ABAC control  
✅ **Support Sessions** - Controlled platform access  
✅ **JIT Access** - On-demand temporary access  
✅ **Certifications** - Compliance reviews  

All features include:
- Complete audit trails
- Time-based validity
- Authorization checks
- Tenant isolation
- Comprehensive error handling

Your OIAM system is now ready for enterprise governance! 🎉
