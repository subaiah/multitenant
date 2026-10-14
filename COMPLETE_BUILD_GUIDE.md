# Complete Build Guide - Step by Step

## 🎯 Goal
Build the complete application (backend + frontend) without errors.

## 📋 Prerequisites
- Node.js 24+ installed
- PostgreSQL database running
- npm or yarn installed

---

## 🚀 Step-by-Step Build Process

### Step 1: Clean and Install Dependencies

```bash
# Navigate to backend directory
cd backend

# Clean node_modules and package-lock
rm -rf node_modules package-lock.json

# Install fresh dependencies
npm install

# Navigate back to root
cd ..

# Clean frontend dependencies
rm -rf node_modules package-lock.json

# Install frontend dependencies
npm install
```

**Expected**: Both installations complete without errors.

---

### Step 2: Generate Prisma Client

```bash
# Navigate to backend
cd backend

# Generate Prisma client (CRITICAL - must be done before build)
npx prisma generate
```

**Expected Output**:
```
✔ Generated Prisma Client (X.XXs)
```

**If this fails**:
- Check your `schema.prisma` file for syntax errors
- Ensure PostgreSQL connection string is correct in `.env`
- Run `npx prisma validate` first to check schema

---

### Step 3: Verify TypeScript Configuration

```bash
# Still in backend directory
npx tsc --version
```

**Expected**: Should show TypeScript version 5.x.x

**Check tsconfig.json**:
```bash
cat tsconfig.json
```

**Verify these settings**:
```json
{
  "compilerOptions": {
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "strict": true
  },
  "include": ["src/**/*", "src/types/**/*"]
}
```

---

### Step 4: Verify Type Definitions Exist

```bash
# Check if type definition files exist
ls -la src/types/
```

**Expected files**:
- `fastify.d.ts` - Fastify type extensions
- `fastify-jwt.d.ts` - JWT type extensions

**If missing**, create them:

**File: `backend/src/types/fastify.d.ts`**
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

export {};
```

**File: `backend/src/types/fastify-jwt.d.ts`**
```typescript
import '@fastify/jwt';

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
```

---

### Step 5: Build Backend

```bash
# In backend directory
npm run build
```

**Expected Output**:
```
> multitenant-bff-api@1.0.0 build
> tsc

✓ Compiled successfully
```

**If errors occur**, check:

#### Error: "Cannot find module '@prisma/client'"
```bash
# Regenerate Prisma client
npx prisma generate
```

#### Error: "Property 'user' does not exist on type 'FastifyRequest'"
- Verify `src/types/fastify.d.ts` exists
- Check `tsconfig.json` includes `src/types/**/*`
- Restart TypeScript server in your IDE

#### Error: "'reply' is declared but its value is never read"
- Verify `tsconfig.json` has `"noUnusedParameters": false`
- Or prefix unused parameters with `_`: `async (request, _reply) => {}`

#### Error: "Cannot find name 'UserType'"
- Import UserType in files that use it:
  ```typescript
  import { UserType } from '../utils/authorization.js';
  ```

---

### Step 6: Test Backend Server

```bash
# Start development server
npm run dev
```

**Expected Output**:
```
Server listening on http://localhost:4000
```

**Test health endpoint**:
```bash
curl http://localhost:4000/health
```

**Expected Response**:
```json
{
  "status": "ok",
  "timestamp": "2026-01-XXT..."
}
```

**Stop server**: `Ctrl+C`

---

### Step 7: Build Frontend

```bash
# Navigate to root directory
cd ..

# Build frontend
npm run build
```

**Expected Output**:
```
vite v8.3.4 building client environment for production...
✓ 2519 modules transformed.
dist/index.html                   2.99 kB
dist/assets/index-XXX.css        59.06 kB
dist/assets/index-XXX.js        829.37 kB
✓ built in X.XXs
```

**If errors occur**:

#### Error: "useNavigate() may be used only in the context of a <Router> component"
- Check `src/App.tsx` structure:
  ```tsx
  <BrowserRouter>
    <AuthProvider>
      <LayoutProvider>
        <Routes>...</Routes>
      </LayoutProvider>
    </AuthProvider>
  </BrowserRouter>
  ```

#### Error: "Cannot find module"
```bash
# Clear Vite cache
rm -rf node_modules/.vite

# Rebuild
npm run build
```

---

### Step 8: Test Frontend

```bash
# Start frontend dev server
npm run dev
```

**Expected Output**:
```
  VITE v8.3.4  ready in XXX ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

**Open browser**: `http://localhost:5173`

**Expected**: Application loads without console errors.

---

## 🔍 Troubleshooting Common Issues

### Issue 1: Prisma Client Not Generated

**Symptoms**:
```
Cannot find module '@prisma/client'
```

**Solution**:
```bash
cd backend
npx prisma generate
```

---

### Issue 2: TypeScript Can't Find Type Definitions

**Symptoms**:
```
Cannot find name 'UserType'
Property 'user' does not exist on type 'FastifyRequest'
```

**Solution**:
1. Verify type files exist in `backend/src/types/`
2. Check `tsconfig.json` includes types:
   ```json
   "include": ["src/**/*", "src/types/**/*"]
   ```
3. Restart TypeScript server in IDE
4. Run `npx tsc --noEmit` to check for errors

---

### Issue 3: Unused Parameter Errors

**Symptoms**:
```
'reply' is declared but its value is never read
```

**Solution**:
Option A - Disable in tsconfig.json:
```json
"noUnusedParameters": false
```

Option B - Prefix with underscore:
```typescript
async (request, _reply) => {
  return {  'something' };
}
```

---

### Issue 4: Module Resolution Errors

**Symptoms**:
```
Cannot find module '../lib/prisma.js'
```

**Solution**:
1. Check file exists
2. Verify import path is correct
3. Ensure `.js` extension is used for ES modules
4. Check `tsconfig.json` has:
   ```json
   "moduleResolution": "bundler"
   ```

---

### Issue 5: Database Connection Errors

**Symptoms**:
```
Can't reach database server at `localhost:5432`
```

**Solution**:
1. Start PostgreSQL:
   ```bash
   # macOS
   brew services start postgresql
   
   # Linux
   sudo systemctl start postgresql
   
   # Docker
   docker-compose up -d postgres
   ```

2. Verify database exists:
   ```bash
   psql -U postgres -l
   ```

3. Check `.env` file:
   ```env
   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/multitenant?schema=public"
   ```

---

## 📊 Build Verification Checklist

After completing all steps, verify:

- [ ] Backend builds without errors (`npm run build` in backend/)
- [ ] Frontend builds without errors (`npm run build` in root)
- [ ] Backend server starts (`npm run dev` in backend/)
- [ ] Frontend server starts (`npm run dev` in root)
- [ ] Health endpoint responds (`curl http://localhost:4000/health`)
- [ ] Frontend loads in browser (`http://localhost:5173`)
- [ ] No console errors in browser
- [ ] No TypeScript errors in IDE

---

## 🎯 Quick Start Script

Create a file `build.sh` in the root directory:

```bash
#!/bin/bash

echo "🚀 Starting complete build process..."

# Step 1: Backend dependencies
echo "📦 Installing backend dependencies..."
cd backend
rm -rf node_modules
npm install

# Step 2: Generate Prisma client
echo "🔧 Generating Prisma client..."
npx prisma generate

# Step 3: Build backend
echo "🏗️  Building backend..."
npm run build

# Step 4: Frontend dependencies
echo "📦 Installing frontend dependencies..."
cd ..
rm -rf node_modules
npm install

# Step 5: Build frontend
echo "🏗️  Building frontend..."
npm run build

echo "✅ Build complete!"
echo ""
echo "To start the application:"
echo "  Backend: cd backend && npm run dev"
echo "  Frontend: npm run dev"
```

Make it executable:
```bash
chmod +x build.sh
```

Run it:
```bash
./build.sh
```

---

## 📝 Environment Variables

Ensure these are set in `backend/.env`:

```env
# Database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/multitenant?schema=public"

# Server
NODE_ENV=development
PORT=4000
HOST=0.0.0.0

# JWT
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES_IN=24h

# CORS
CORS_ORIGIN=http://localhost:5173

# Rate Limiting
RATE_LIMIT_MAX=1000
RATE_LIMIT_TIME_WINDOW=60000

# Logging
LOG_LEVEL=info

# Multi-tenancy
DEFAULT_TENANT_STRATEGY=SHARED_TABLES
TENANT_HEADER=x-tenant-id

# BFF Configuration
BFF_URL=http://localhost:4000
FRONTEND_URL=http://localhost:5173
COOKIE_SECRET=change-this-to-a-secure-random-string-at-least-32-chars
ACCESS_TOKEN_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=7d
```

---

## 🆘 Getting Help

If you're still stuck:

1. **Check the error message carefully** - Most errors tell you exactly what's wrong
2. **Verify file paths** - Ensure all imports are correct
3. **Check TypeScript version** - Should be 5.x.x
4. **Clear caches** - Delete `node_modules`, `dist`, `.vite` folders
5. **Restart IDE** - Sometimes TypeScript server needs a restart

---

## ✅ Success Criteria

You've successfully built the application when:

1. ✅ `cd backend && npm run build` completes with 0 errors
2. ✅ `npm run build` (frontend) completes with 0 errors
3. ✅ `cd backend && npm run dev` starts server on port 4000
4. ✅ `npm run dev` (frontend) starts server on port 5173
5. ✅ Browser shows application without errors
6. ✅ API endpoints respond correctly

---

**Last Updated**: 2026-01-XX  
**Status**: Ready for execution
