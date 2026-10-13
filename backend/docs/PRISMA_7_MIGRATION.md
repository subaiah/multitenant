# Prisma 7 Migration Guide

## 🎯 What Changed in Prisma 7?

Prisma 7 introduced a **major breaking change** in how database connections are configured. The traditional `url` property in the `datasource` block is no longer supported.

### Before (Prisma 6 and earlier)

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")  // ❌ No longer supported in Prisma 7
}
```

### After (Prisma 7+)

```prisma
datasource db {
  provider = "postgresql"
  // No URL here - connection is configured via adapters
}
```

## 🔧 New Configuration Approach

Prisma 7 separates concerns into two parts:

1. **Migration Configuration** (`prisma.config.ts`) - For running migrations
2. **Runtime Configuration** (PrismaClient with adapter) - For application code

### 1. Migration Configuration

Create `prisma.config.ts` in your backend root:

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

This file is used by:
- `prisma migrate dev` - Development migrations
- `prisma migrate deploy` - Production migrations
- `prisma db push` - Schema synchronization

### 2. Runtime Configuration (Database Adapter)

Instead of Prisma managing the connection directly, you now use a **database adapter**:

```typescript
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

// Create PostgreSQL connection pool
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create Prisma adapter
const adapter = new PrismaPg(pool);

// Initialize PrismaClient with adapter
const prisma = new PrismaClient({ adapter });
```

## 📦 Required Packages

Install the PostgreSQL adapter and driver:

```bash
npm install @prisma/adapter-pg pg
```

### Available Adapters

Prisma 7 supports multiple database adapters:

| Database | Adapter Package | Driver |
|----------|----------------|--------|
| PostgreSQL | `@prisma/adapter-pg` | `pg` |
| MySQL | `@prisma/adapter-mysql` | `mysql2` |
| SQLite | `@prisma/adapter-libsql` | `@libsql/client` |
| SQL Server | `@prisma/adapter-mssql` | `tedious` |
| MongoDB | `@prisma/adapter-mongodb` | `mongodb` |

## 🚀 Why This Change?

### Benefits

1. **Better Connection Pooling**: Use mature database drivers (pg, mysql2) for connection pooling
2. **More Flexibility**: Configure connections exactly how you want
3. **Better Performance**: Leverage optimized database drivers
4. **Prisma Accelerate**: Easier integration with Prisma's serverless acceleration
5. **Separation of Concerns**: Migrations and runtime use different configurations

### Migration Path

The change encourages:
- Using connection pools instead of single connections
- Better resource management in serverless environments
- More control over database connections
- Easier switching between direct connections and Prisma Accelerate

## 📝 Complete Setup Example

### 1. Update Schema

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  // No URL property
}

model User {
  id    String @id @default(uuid())
  email String @unique
  name  String?
}
```

### 2. Create prisma.config.ts

```typescript
// prisma.config.ts
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

### 3. Update Prisma Client

```typescript
// src/lib/prisma.ts
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });
```

### 4. Environment Variables

```env
# .env
DATABASE_URL="postgresql://user:password@localhost:5432/mydb?schema=public"
```

## 🔄 Running Migrations

### Development

```bash
# Create and apply migration
npx prisma migrate dev --name init

# Reset database
npx prisma migrate reset
```

### Production

```bash
# Deploy migrations
npx prisma migrate deploy

# Generate client
npx prisma generate
```

### Schema Sync (No Migrations)

```bash
# Push schema directly (development only)
npx prisma db push
```

## 🎯 Using Prisma Accelerate (Optional)

If you're using Prisma Accelerate for serverless:

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasourceUrl: process.env.ACCELERATE_URL,
});
```

This bypasses the adapter and connects directly to Prisma Accelerate.

## 🐛 Common Issues

### Issue 1: "The datasource property `url` is no longer supported"

**Solution**: Remove `url` from your `datasource` block in `schema.prisma` and create `prisma.config.ts`.

### Issue 2: "Cannot find module '@prisma/adapter-pg'"

**Solution**: Install the adapter:
```bash
npm install @prisma/adapter-pg pg
```

### Issue 3: Migration fails with "DATABASE_URL not set"

**Solution**: Ensure your `.env` file has `DATABASE_URL` and it's loaded before running migrations.

### Issue 4: Connection pool errors

**Solution**: Configure the pool properly:
```typescript
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

## 📊 Comparison Table

| Feature | Prisma 6 | Prisma 7 |
|---------|----------|----------|
| Connection URL | In schema | In prisma.config.ts + adapter |
| Connection Pooling | Prisma-managed | Driver-managed (pg, mysql2) |
| Configuration Files | schema.prisma | schema.prisma + prisma.config.ts |
| Adapter Required | No | Yes (for direct connections) |
| Accelerate Support | Yes | Yes (improved) |
| Migration Config | In schema | In prisma.config.ts |

## 🎓 Best Practices

### 1. Connection Pool Configuration

```typescript
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

### 2. Graceful Shutdown

```typescript
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  await pool.end();
});
```

### 3. Error Handling

```typescript
try {
  const users = await prisma.user.findMany();
} catch (error) {
  console.error('Database error:', error);
  // Handle error appropriately
}
```

### 4. Type Safety

```typescript
// Always use generated types
import { User, Post } from '@prisma/client';

const user: User = await prisma.user.findUnique({
  where: { id: '123' }
});
```

## 📚 Additional Resources

- [Prisma 7 Announcement](https://www.prisma.io/blog/announcing-prisma-orm-7-0-0)
- [Prisma 7 Migration Guide](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7)
- [Database Adapters](https://www.prisma.io/docs/orm/overview/databases/database-features)
- [Prisma Accelerate](https://www.prisma.io/docs/accelerate)

## ✅ Checklist

- [ ] Remove `url` from `datasource` in schema.prisma
- [ ] Create `prisma.config.ts` with migration URL
- [ ] Install database adapter (`@prisma/adapter-pg`)
- [ ] Install database driver (`pg`)
- [ ] Update PrismaClient initialization to use adapter
- [ ] Test migrations with `prisma migrate dev`
- [ ] Test application with `prisma generate`
- [ ] Update deployment scripts if needed

---

**Migration Status**: ✅ Complete  
**Prisma Version**: 7.10.0  
**Last Updated**: October 2026
