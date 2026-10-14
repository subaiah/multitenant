# Quick Build Guide - No Errors

## 🎯 Fast Track (5 Steps)

### 1️⃣ Backend: Install & Generate
```bash
cd backend
npm install
npx prisma generate
```

### 2️⃣ Backend: Build
```bash
npm run build
```

**Expected**: ✅ 0 errors

### 3️⃣ Backend: Test
```bash
npm run dev
```

**Expected**: Server starts on http://localhost:4000

### 4️⃣ Frontend: Install & Build
```bash
cd ..
npm install
npm run build
```

**Expected**: ✅ 0 errors

### 5️⃣ Frontend: Test
```bash
npm run dev
```

**Expected**: App loads on http://localhost:5173

---

## 🔧 If You Get Errors

### Error: "Cannot find module '@prisma/client'"
```bash
cd backend
npx prisma generate
```

### Error: "Property 'user' does not exist on type 'FastifyRequest'"
1. Check `backend/src/types/fastify.d.ts` exists
2. Verify `backend/tsconfig.json` has:
   ```json
   "include": ["src/**/*", "src/types/**/*"]
   ```

### Error: "'reply' is declared but its value is never read"
Update `backend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "noUnusedParameters": false,
    "noUnusedLocals": false
  }
}
```

### Error: "useNavigate() may be used only in the context of a <Router> component"
Check `src/App.tsx`:
```tsx
<BrowserRouter>
  <AuthProvider>
    <LayoutProvider>
      <Routes>...</Routes>
    </LayoutProvider>
  </AuthProvider>
</BrowserRouter>
```

---

## 📋 Verification Checklist

After build, verify:

- [ ] `cd backend && npm run build` → 0 errors
- [ ] `cd backend && npm run dev` → Server starts
- [ ] `curl http://localhost:4000/health` → Returns JSON
- [ ] `npm run build` (frontend) → 0 errors
- [ ] `npm run dev` (frontend) → App loads
- [ ] Browser console → No errors

---

## 🆘 Still Having Issues?

### Clean Build
```bash
# Backend
cd backend
rm -rf node_modules dist
npm install
npx prisma generate
npm run build

# Frontend
cd ..
rm -rf node_modules dist
npm install
npm run build
```

### Check TypeScript Version
```bash
cd backend
npx tsc --version
```
Should be 5.x.x

### Check Node Version
```bash
node --version
```
Should be 24.x.x

---

## 📚 Full Documentation

For detailed troubleshooting, see: `COMPLETE_BUILD_GUIDE.md`

---

**Status**: Ready to execute ✅
