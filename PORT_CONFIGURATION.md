# Port Configuration Guide

## Overview

This document explains the port configuration for the multi-tenant application platform to avoid conflicts between frontend and backend services.

## Port Assignments

### Frontend (Vite)
- **Port**: `5173`
- **URL**: `http://localhost:5173`
- **Purpose**: React application with Vite dev server
- **Configuration**: `vite.config.js`

### Backend (Fastify)
- **Port**: `4000`
- **URL**: `http://localhost:4000`
- **Purpose**: Node.js API server with Fastify
- **Configuration**: `backend/.env` and `backend/src/config/env.ts`

### Database (PostgreSQL)
- **Port**: `5432`
- **URL**: `postgresql://localhost:5432/multitenant`
- **Purpose**: PostgreSQL database server
- **Configuration**: `backend/.env` (DATABASE_URL)

## Why These Ports?

### Frontend on 5173
- **Vite's default port**: Widely recognized in the React/Vite community
- **Avoids conflicts**: Doesn't clash with common backend ports (3000, 4000, 8000)
- **Easy to remember**: Standard Vite convention

### Backend on 4000
- **Common API port**: Frequently used for backend services
- **Clear separation**: Distinct from frontend (5173) and database (5432)
- **Professional convention**: Follows industry standards

## Configuration Files

### Frontend Configuration

**File**: `vite.config.js`
```javascript
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});
```

### Backend Configuration

**File**: `backend/.env`
```env
# Server Configuration
NODE_ENV=development
PORT=4000
HOST=0.0.0.0

# CORS Configuration
CORS_ORIGIN=http://localhost:5173
```

**File**: `backend/src/config/env.ts`
```typescript
const envSchema = z.object({
  // Server
  PORT: z.string().default('4000').transform(Number),
  
  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
});
```

## CORS Configuration

The backend is configured to accept requests from the frontend:

```typescript
// backend/src/config/env.ts
CORS_ORIGIN: z.string().default('http://localhost:5173')
```

This allows the frontend at `http://localhost:5173` to make API calls to `http://localhost:4000`.

## API Endpoints

All backend API endpoints are accessible at `http://localhost:4000`:

- **Health Check**: `http://localhost:4000/health`
- **API Documentation**: `http://localhost:4000/docs`
- **Authentication**: `http://localhost:4000/auth/*`
- **Tenants**: `http://localhost:4000/tenants/*`
- **Applications**: `http://localhost:4000/applications/*`

## Frontend API Calls

The frontend makes API calls to the backend using the full URL:

```typescript
// Example from src/pages/Login.tsx
const response = await fetch('http://localhost:4000/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, tenantId, password }),
});
```

## Testing the Setup

### 1. Start Backend
```bash
cd backend
npm run dev
```
Backend will start at `http://localhost:4000`

### 2. Start Frontend
```bash
npm run dev
```
Frontend will start at `http://localhost:5173`

### 3. Verify Both Services
```bash
# Test backend health
curl http://localhost:4000/health

# Open frontend in browser
open http://localhost:5173
```

## Common Issues

### Port Already in Use

If you see "Port 4000 already in use":
```bash
# Find process using port 4000
lsof -i :4000  # macOS/Linux
netstat -ano | findstr :4000  # Windows

# Kill the process
kill -9 <PID>  # macOS/Linux
taskkill /PID <PID> /F  # Windows
```

Or change the port in `backend/.env`:
```env
PORT=4001
```

### CORS Errors

If you see CORS errors in the browser console:
1. Check that `CORS_ORIGIN` in `backend/.env` matches your frontend URL
2. Ensure the backend is running on port 4000
3. Restart the backend after changing `.env`

### Frontend Can't Connect to Backend

If the frontend can't reach the backend:
1. Verify backend is running: `curl http://localhost:4000/health`
2. Check that frontend API calls use `http://localhost:4000` (not 3000)
3. Check browser console for specific error messages

## Alternative Port Configurations

If you prefer different ports, here are some common alternatives:

### Option 1: Traditional
- Frontend: `3000`
- Backend: `5000`

### Option 2: Sequential
- Frontend: `3000`
- Backend: `3001`

### Option 3: High Ports
- Frontend: `8080`
- Backend: `8081`

To change ports:
1. Update `vite.config.js` for frontend
2. Update `backend/.env` for backend
3. Update `CORS_ORIGIN` in backend config
4. Update API URLs in frontend code

## Production Considerations

In production, you'll typically use:
- **Frontend**: Served by CDN or web server (port 80/443)
- **Backend**: API server behind reverse proxy (port 443)
- **Database**: Internal network, not exposed publicly

Example production setup:
```
Frontend: https://app.example.com (port 443)
Backend:  https://api.example.com (port 443)
Database: postgres://db.internal:5432 (internal only)
```

## Summary

| Service | Port | URL | Purpose |
|---------|------|-----|---------|
| Frontend | 5173 | http://localhost:5173 | React app (Vite) |
| Backend | 4000 | http://localhost:4000 | API server (Fastify) |
| Database | 5432 | postgresql://localhost:5432 | PostgreSQL |

This configuration ensures:
- ✅ No port conflicts
- ✅ Clear separation of concerns
- ✅ Industry-standard conventions
- ✅ Easy to remember and document
- ✅ CORS properly configured

---

**Last Updated**: 2026-01-XX  
**Version**: 1.0.0
