# 🔧 Complete Backend Build Fix - Step by Step

## 📋 Current Status
- **Errors**: 204 TypeScript compilation errors
- **Main Issues**: Missing type declarations for Fastify request extensions
- **Goal**: 0 errors, successful build

---

## 🎯 Quick Fix (5 Minutes)

### Step 1: Navigate to Backend
```bash
cd backend
```

### Step 2: Regenerate Prisma Client
```bash
npx prisma generate
```

### Step 3: Clean and Build
```bash
rm -rf dist
npm run build
```

### Step 4: Check Results
```bash
npm run build 2>&1 | grep -c "error TS"
```
**Expected**: `0` (zero errors)

---

## 🔍 If Errors Persist - Detailed Fix

### Issue 1: Type Definitions Not Loading

**Symptoms**:
```
Property 'user' does not exist on type 'FastifyRequest'
Property 'tenant' does not exist on type 'FastifyRequest'
```

**Solution**: Verify `src/global.d.ts` exists and contains:

```typescript
import { UserType } from '../utils/authorization.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      userId: string;
      tenantId?: string;
      userType: UserType;
    };
    tenant: {
      id: string;
      name: string;
      slug: string;
      plan: string;
      status: string;
    };
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      userId: string;
      tenantId?: string;
      userType: string;
    };
    user: {
      userId: string;
      tenantId?: string;
      userType: string;
    };
  }
}

export {};
```

### Issue 2: TypeScript Config Not Including Types

**Symptoms**:
```
Cannot find type definition file
```

**Solution**: Update `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "typeRoots": ["./node_modules/@types", "./src/types"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Issue 3: Missing Type Imports in Route Files

**Symptoms**:
```
Cannot find name 'UserType'
```

**Solution**: Add import to files that need it:

```typescript
import { UserType } from '../utils/authorization.js';
```

---

## 📊 Common Error Patterns and Fixes

### Pattern 1: "Property 'X' does not exist on type 'Y'"

**Example**:
```
Property 'user' does not exist on type 'FastifyRequest<...>'
```

**Fix**: Ensure `src/global.d.ts` has the module augmentation (see Issue 1 above)

### Pattern 2: "Cannot find module '@prisma/client'"

**Fix**:
```bash
npx prisma generate
```

### Pattern 3: "'reply' is declared but its value is never read"

**Fix**: Already handled in `tsconfig.json`:
```json
"noUnusedParameters": false
```

### Pattern 4: "Cannot find name 'UserType'"

**Fix**: Add import at top of file:
```typescript
import { UserType } from '../utils/authorization.js';
```

---

## 🧪 Verification Steps

### Test 1: Type Definitions Load
```bash
cd backend
npx tsc --listFiles | grep global.d.ts
```
**Expected**: Should list `src/global.d.ts`

### Test 2: Build Succeeds
```bash
npm run build
```
**Expected**: Exit code 0, no errors

### Test 3: Server Starts
```bash
npm run dev
```
**Expected**: Server starts on http://localhost:4000

### Test 4: Health Check
```bash
curl http://localhost:4000/health
```
**Expected**: Returns JSON with status "ok"

---

## 📁 Files to Check

### Required Files
- [ ] `backend/src/global.d.ts` - Global type declarations
- [ ] `backend/src/types/fastify.d.ts` - Fastify types
- [ ] `backend/src/types/fastify-jwt.d.ts` - JWT types
- [ ] `backend/tsconfig.json` - TypeScript configuration
- [ ] `backend/src/utils/authorization.ts` - UserType definition

### Files Using request.user
- [ ] `backend/src/routes/users.ts`
- [ ] `backend/src/routes/tenants.ts`
- [ ] `backend/src/routes/auth-config.ts`
- [ ] `backend/src/routes/api-config.ts`
- [ ] `backend/src/routes/database.ts`
- [ ] `backend/src/routes/bff.ts`

---

## 🚀 Automated Fix Script

Create `fix-all.sh` in backend directory:

```bash
#!/bin/bash
set -e

echo "🔧 Running automated fix..."

# 1. Regenerate Prisma
echo "📦 Generating Prisma client..."
npx prisma generate

# 2. Clean build
echo "🧹 Cleaning build..."
rm -rf dist

# 3. Build
echo "🏗️  Building..."
npm run build

# 4. Verify
echo "✅ Verifying..."
if [ -d "dist" ]; then
    echo "✅ Build successful! dist/ directory created."
else
    echo "❌ Build failed! dist/ directory not found."
    exit 1
fi

echo ""
echo "🎉 All fixes applied successfully!"
```

Run it:
```bash
chmod +x fix-all.sh
./fix-all.sh
```

---

## 📝 Manual File-by-File Fix

If automated fix doesn't work, check each file:

### File 1: `src/global.d.ts`
**Must contain**:
```typescript
import { UserType } from '../utils/authorization.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      userId: string;
      tenantId?: string;
      userType: UserType;
    };
    tenant: {
      id: string;
      name: string;
      slug: string;
      plan: string;
      status: string;
    };
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      userId: string;
      tenantId?: string;
      userType: string;
    };
    user: {
      userId: string;
      tenantId?: string;
      userType: string;
    };
  }
}

export {};
```

### File 2: `tsconfig.json`
**Must contain**:
```json
{
  "compilerOptions": {
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "typeRoots": ["./node_modules/@types", "./src/types"]
  },
  "include": ["src/**/*"]
}
```

### File 3: Route Files
**Check imports**:
```typescript
// At top of each route file
import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/error-handler.js';
```

---

## 🎯 Success Criteria

Build is successful when ALL of these are true:
- ✅ `npm run build` exits with code 0
- ✅ No "error TS" in output
- ✅ `dist/` directory created
- ✅ `npm run dev` starts server
- ✅ Health endpoint responds

---

## 🆘 Still Having Issues?

### Diagnostic Commands

```bash
# Check TypeScript version
npx tsc --version

# List all compiled files
npx tsc --listFiles

# Show TypeScript config
npx tsc --showConfig

# Check for syntax errors
npx tsc --noEmit
```

### Common Solutions

1. **Clear all caches**:
   ```bash
   rm -rf node_modules/.cache
   rm -rf dist
   rm -rf node_modules/.prisma
   ```

2. **Reinstall dependencies**:
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

3. **Regenerate everything**:
   ```bash
   npx prisma generate
   npm run build
   ```

---

## 📞 Expected Output

### Successful Build
```
> multitenant-bff-api@1.0.0 build
> tsc

✓ Compiled successfully
```

### Failed Build
```
> multitenant-bff-api@1.0.0 build
> tsc

src/routes/users.ts(39,40): error TS2339: Property 'user' does not exist...
...
Found 204 errors.
```

---

## ✅ Final Checklist

Before declaring success, verify:

- [ ] `src/global.d.ts` exists with correct content
- [ ] `tsconfig.json` has correct configuration
- [ ] Prisma client generated
- [ ] `npm run build` completes with 0 errors
- [ ] `dist/` directory created
- [ ] `npm run dev` starts without errors
- [ ] Health endpoint responds

---

**Status**: Ready to execute  
**Estimated Time**: 5-10 minutes  
**Difficulty**: Easy (follow steps above)
