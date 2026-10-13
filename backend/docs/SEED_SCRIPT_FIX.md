# Seed Script Fix - Prisma 7 Adapter

## Issue

The seed script was failing with the error:
```
PrismaClientInitializationError: PrismaClient was instantiated without any options. 
A driver adapter is required to connect to your database.
```

## Root Cause

Prisma 7 requires a driver adapter to be passed to the PrismaClient constructor. The seed script was creating a new PrismaClient instance without the adapter, while the main application was using the shared instance from `src/lib/prisma.ts` which has the adapter configured.

## Solution

Updated `backend/prisma/seed.ts` to:

1. **Import the shared Prisma instance** instead of creating a new one:
   ```typescript
   // ❌ Old (incorrect)
   import { PrismaClient } from '@prisma/client';
   const prisma = new PrismaClient();
   
   // ✅ New (correct)
   import { prisma, pool } from '../src/lib/prisma.js';
   ```

2. **Import the connection pool** for proper cleanup:
   ```typescript
   import { prisma, pool } from '../src/lib/prisma.js';
   ```

3. **Close both Prisma client and pool** on exit:
   ```typescript
   .finally(async () => {
     await prisma.$disconnect();
     await pool.end();
   });
   ```

## Changes Made

### File: `backend/prisma/seed.ts`

**Before:**
```typescript
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/utils/auth.js';

const prisma = new PrismaClient();

// ... seed logic ...

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

**After:**
```typescript
import { prisma, pool } from '../src/lib/prisma.js';
import { hashPassword } from '../src/utils/auth.js';

// ... seed logic ...

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
```

## Why This Works

The `src/lib/prisma.ts` file already has the correct Prisma 7 setup:

```typescript
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

// Create PostgreSQL connection pool
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

// Create Prisma adapter for PostgreSQL
const adapter = new PrismaPg(pool);

// Initialize PrismaClient with adapter
export const prisma = new PrismaClient({ adapter });
```

By importing this shared instance, the seed script:
- ✅ Uses the same adapter configuration as the main application
- ✅ Shares the same connection pool
- ✅ Maintains consistency across the application
- ✅ Properly closes all connections on exit

## Running the Seed Script

Now you can run the seed script successfully:

```bash
cd backend
npm run prisma:seed
```

Expected output:
```
🌱 Starting database seed...
✅ Created 4 tenants
✅ Created 8 users
✅ Created 8 applications
✅ Created 4 database configurations
✅ Created 4 auth configurations
✅ Created 6 auth providers
✅ Created 4 API configurations
✅ Created 4 activities
🎉 Database seed completed successfully!
```

## Best Practices

### For Scripts and Utilities

Always use the shared Prisma instance from `src/lib/prisma.ts`:

```typescript
// ✅ Correct
import { prisma } from '../src/lib/prisma.js';

// ❌ Incorrect
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
```

### Benefits

1. **Consistency** - Same configuration across all files
2. **Connection Pooling** - Shared pool reduces overhead
3. **Adapter Support** - Prisma 7 adapter pattern
4. **Proper Cleanup** - Centralized connection management
5. **Type Safety** - Single source of truth

## Related Files

- `backend/src/lib/prisma.ts` - Shared Prisma instance with adapter
- `backend/src/server.ts` - Main application using shared instance
- `backend/prisma/seed.ts` - Seed script using shared instance
- `backend/prisma.config.ts` - Prisma 7 configuration

## Prisma 7 Migration Notes

This fix is part of the Prisma 7 migration. Key changes:

1. **Driver Adapters Required** - No more direct database URLs in PrismaClient
2. **Connection Pooling** - Use pg, mysql2, or other driver pools
3. **Shared Instances** - Import from central location
4. **Proper Cleanup** - Close both Prisma client and connection pool

See `backend/docs/PRISMA_7_MIGRATION.md` for full migration guide.
