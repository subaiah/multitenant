# Prisma 7 Migration Error Fix

## Issue
When running `npx prisma migrate dev`, you encountered this error:
```
Error: The datasource.url property is required in your Prisma config file when using prisma migrate dev.
```

## Root Cause
The `prisma.config.ts` file was not loading environment variables from the `.env` file, so `process.env.DATABASE_URL` was undefined.

## Solution Applied

### 1. Updated `prisma.config.ts`
- Added `dotenv` package to load environment variables
- Fixed ES module compatibility (replaced `__dirname` with `import.meta.url`)
- Properly configured the migration URL

**Before:**
```typescript
import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  earlyAccess: false,
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  migrate: {
    url: process.env.DATABASE_URL || '',
  },
});
```

**After:**
```typescript
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';
import { config } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
config({ path: path.resolve(__dirname, '.env') });

export default defineConfig({
  earlyAccess: false,
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  migrate: {
    url: process.env.DATABASE_URL || '',
  },
});
```

### 2. Created `.env` File
Created `backend/.env` with the database connection string:
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/multitenant?schema=public"
```

### 3. Added `dotenv` Dependency
Added `dotenv@^16.4.5` to `package.json` dependencies.

## Next Steps

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Verify PostgreSQL is Running
Make sure PostgreSQL is running on your machine. If using Docker:
```bash
# Start PostgreSQL with Docker Compose
docker-compose up -d postgres

# Or if you have a separate docker-compose file
cd backend
docker-compose up -d
```

### 3. Create Database (if it doesn't exist)
```bash
# Connect to PostgreSQL
psql -U postgres

# Create database
CREATE DATABASE multitenant;

# Exit
\q
```

Or using createdb:
```bash
createdb -U postgres multitenant
```

### 4. Run Prisma Migration
```bash
cd backend
npx prisma migrate dev --name init
```

This will:
- Validate your schema
- Create the initial migration
- Apply it to your database
- Generate the Prisma Client

### 5. Seed the Database (Optional)
```bash
npm run prisma:seed
```

## Troubleshooting

### Error: "Connection refused"
- Make sure PostgreSQL is running
- Check the DATABASE_URL in `.env` matches your PostgreSQL credentials
- Default credentials: `postgres:postgres@localhost:5432`

### Error: "database does not exist"
- Create the database first: `createdb -U postgres multitenant`

### Error: "permission denied"
- Check PostgreSQL user permissions
- You may need to create the user or grant permissions

### VS Code Still Shows "url missing" Error
This is a known issue with the Prisma VS Code extension not supporting Prisma 7 yet. The error is cosmetic - your setup is correct. The `.vscode/settings.json` file suppresses this warning.

## Verification

After running the migration, verify everything works:

```bash
# Generate Prisma Client
npx prisma generate

# Open Prisma Studio to view your database
npx prisma studio

# Start the development server
npm run dev
```

## Summary

✅ Fixed `prisma.config.ts` to load environment variables  
✅ Created `.env` file with database URL  
✅ Added `dotenv` dependency  
✅ Fixed ES module compatibility  
✅ Ready to run migrations  

Your Prisma 7 setup is now complete and ready to use!
