# Backend Build Fix Guide

## Issue
After adding the `orgUnits` back-reference to the Tenant model in `schema.prisma`, the backend build is failing with 296 errors across 23 files.

## Root Cause
The Prisma client needs to be regenerated after schema changes. The TypeScript compiler is seeing type mismatches because the generated Prisma client doesn't include the new `orgUnits` relation yet.

## Solution

### Quick Fix (Recommended)
Run the fix script:

```bash
chmod +x fix-backend-build.sh
./fix-backend-build.sh
```

### Manual Fix
If you prefer to run the commands manually:

```bash
cd backend

# Step 1: Validate the schema
npx prisma validate

# Step 2: Generate Prisma client
npx prisma generate

# Step 3: Check TypeScript compilation
npx tsc --noEmit

# Step 4: Build the project
npm run build
```

## Expected Output

After running the fix, you should see:

```
✅ Schema validation passed
✅ Prisma client generated successfully
✅ TypeScript compilation successful
✅ Build successful!
```

## If Errors Persist

If you still see errors after regenerating the Prisma client, check:

1. **Missing Imports**: Ensure all route files import the Prisma client correctly
   ```typescript
   import { prisma } from '../lib/prisma.js';
   ```

2. **Type Mismatches**: The Prisma client types should now include `orgUnits` on the Tenant model
   ```typescript
   // This should now work:
   const tenant = await prisma.tenant.findUnique({
     where: { id: tenantId },
     include: { orgUnits: true }
   });
   ```

3. **Node Modules**: If issues persist, try reinstalling dependencies
   ```bash
   rm -rf node_modules
   npm install
   npx prisma generate
   ```

## Verification

After the fix, verify that:

1. ✅ `npx prisma validate` passes
2. ✅ `npx prisma generate` completes successfully
3. ✅ `npx tsc --noEmit` shows no errors
4. ✅ `npm run build` completes successfully

## Common Errors and Solutions

### Error: "Property 'orgUnits' does not exist on type 'Tenant'"
**Solution**: Run `npx prisma generate` to regenerate the Prisma client with the new relation.

### Error: "Cannot find module '@prisma/client'"
**Solution**: Run `npm install` to install dependencies, then `npx prisma generate`.

### Error: Multiple type errors across route files
**Solution**: This indicates the Prisma client is out of sync. Run the full fix script.

## Next Steps

After fixing the build:

1. Start the backend: `npm run dev`
2. Verify the API is running: `curl http://localhost:4000/health`
3. Continue with Phase 3 implementation

---

**Status**: Fix script created and ready to run  
**Files Modified**: `backend/prisma/schema.prisma` (added orgUnits back-reference)  
**Action Required**: Run `./fix-backend-build.sh` to regenerate Prisma client and rebuild
