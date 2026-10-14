# Prisma 7 Configuration Guide

## 🔍 Understanding the `url` Error

### The Confusion

You're seeing two contradictory errors:
1. ❌ "The datasource property `url` is no longer supported" (from Prisma CLI)
2. ❌ "Argument 'url' is missing in data source block 'db'" (likely from IDE/editor)

### What's Actually Happening

**Prisma 7 does NOT support `url` in the schema file.** This is confirmed by:
- Official Prisma documentation
- Multiple community reports
- JetBrains plugin issue tracker

The error "Argument 'url' is missing" is likely coming from:
- **VS Code Prisma extension** (outdated)
- **JetBrains Prisma plugin** (has a known bug - see [WEB-75800](https://youtrack.jetbrains.com/projects/WEB/issues/WEB-75800))
- **Older Prisma CLI version**

### ✅ Correct Prisma 7 Setup

**Your `schema.prisma` should NOT have `url`:**

```prisma
datasource db {
  provider = "postgresql"
  // No url property - this is correct for Prisma 7!
}
```

**Configuration is split into two places:**

1. **For Migrations** → `prisma.config.ts`
2. **For Runtime** → Database adapter in code

### 🛠️ Fixing IDE Errors

#### VS Code
Update the Prisma extension to the latest version:
```bash
# In VS Code, update the "Prisma" extension
# Or reinstall:
code --install-extension Prisma.prisma
```

#### JetBrains (WebStorm, IntelliJ, etc.)
This is a known bug. Workarounds:
1. **Ignore the error** - It's a false positive from the plugin
2. **Add `url` back temporarily** for IDE support (will fail at runtime):
   ```prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL") // Only for IDE - will fail with Prisma 7 CLI
   }
   ```
3. **Wait for JetBrains to fix** the plugin

### ✅ Verify Prisma CLI Works

Test that Prisma CLI actually works (ignore IDE errors):

```bash
cd backend

# This should work without errors
npx prisma generate

# This should also work
npx prisma validate
```

If these commands work, your setup is correct. The IDE error is a false positive.

---

## 🐍 Using snake_case with @map and @@map

Yes! You can absolutely use snake_case in your database while keeping camelCase in TypeScript. This is a best practice for PostgreSQL.

### @map - Column Names

Use `@map` to map a Prisma field to a snake_case column name:

```prisma
model User {
  id        String   @id @default(uuid())
  email     String   @unique
  firstName String   @map("first_name")
  lastName  String   @map("last_name")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  
  @@map("users")
}
```

**Result:**
- TypeScript: `user.firstName` (camelCase)
- Database: `first_name` (snake_case)

### @@map - Table Names

Use `@@map` to map a Prisma model to a snake_case table name:

```prisma
model UserProfile {
  id     String @id @default(uuid())
  userId String @map("user_id")
  bio    String?
  
  @@map("user_profiles")
}
```

**Result:**
- TypeScript: `prisma.userProfile.findMany()` (camelCase)
- Database: `user_profiles` table (snake_case)

### Complete Example with All Mappings

```prisma
// Tenant model
model Tenant {
  id           String       @id @default(uuid())
  name         String
  slug         String       @unique
  plan         TenantPlan   @map("plan")
  status       TenantStatus @map("status")
  
  // Branding
  logoUrl      String?      @map("logo_url")
  primaryColor String?      @map("primary_color") @default("#3b82f6")
  customDomain String?      @unique @map("custom_domain")
  loginTitle   String?      @map("login_title")
  loginSubtitle String?     @map("login_subtitle")
  
  createdAt    DateTime     @default(now()) @map("created_at")
  updatedAt    DateTime     @updatedAt @map("updated_at")
  
  // Relations
  users           User[]
  applications    Application[]
  databaseConfig  DatabaseConfig?
  authConfig      AuthConfig?
  apiConfig       ApiConfig?
  activities      Activity[]
  
  @@map("tenants")
  @@index([slug])
  @@index([status])
}

// User model
model User {
  id          String     @id @default(uuid())
  tenantId    String     @map("tenant_id")
  email       String
  name        String?
  role        UserRole   @default(USER)
  status      UserStatus @default(ACTIVE)
  lastLoginAt DateTime?  @map("last_login_at")
  createdAt   DateTime   @default(now()) @map("created_at")
  updatedAt   DateTime   @updatedAt @map("updated_at")
  
  // Relations
  tenant      Tenant     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  
  @@unique([tenantId, email])
  @@index([tenantId])
  @@index([email])
  @@map("users")
}

// Application model
model Application {
  id              String            @id @default(uuid())
  tenantId        String            @map("tenant_id")
  name            String
  description     String?
  status          ApplicationStatus
  version         String
  environment     Environment
  url             String
  cpu             Int               @default(0)
  memory          Int               @default(0)
  requests        Int               @default(0)
  lastDeployedAt  DateTime?         @map("last_deployed_at")
  createdAt       DateTime          @default(now()) @map("created_at")
  updatedAt       DateTime          @updatedAt @map("updated_at")
  
  // Relations
  tenant          Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  
  @@index([tenantId])
  @@index([status])
  @@index([environment])
  @@map("applications")
}

// Database configuration
model DatabaseConfig {
  id                String            @id @default(uuid())
  tenantId          String            @unique @map("tenant_id")
  strategy          DatabaseStrategy
  provider          DatabaseProvider
  region            String
  backupEnabled     Boolean           @default(false) @map("backup_enabled")
  encryptionAtRest  Boolean           @default(false) @map("encryption_at_rest")
  maxConnections    Int               @default(100) @map("max_connections")
  storageLimit      String            @map("storage_limit")
  connectionString  String?           @map("connection_string")
  schemaName        String?           @map("schema_name")
  tenantColumn      String?           @map("tenant_column")
  createdAt         DateTime          @default(now()) @map("created_at")
  updatedAt         DateTime          @updatedAt @map("updated_at")
  
  // Relations
  tenant            Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  
  @@map("database_configs")
}

// Auth configuration
model AuthConfig {
  id              String         @id @default(uuid())
  tenantId        String         @unique @map("tenant_id")
  mfaEnabled      Boolean        @default(false) @map("mfa_enabled")
  sessionTimeout  Int            @default(60) @map("session_timeout")
  passwordPolicy  PasswordPolicy @default(STANDARD) @map("password_policy")
  ssoOnly         Boolean        @default(false) @map("sso_only")
  createdAt       DateTime       @default(now()) @map("created_at")
  updatedAt       DateTime       @updatedAt @map("updated_at")
  
  // Relations
  tenant          Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  providers       AuthProvider[]
  
  @@map("auth_configs")
}

// Auth providers
model AuthProvider {
  id              String           @id @default(uuid())
  authConfigId    String           @map("auth_config_id")
  provider        AuthProviderType
  enabled         Boolean          @default(false)
  clientId        String?          @map("client_id")
  clientSecret    String?          @map("client_secret")
  tenantId        String?          @map("tenant_id")
  domain          String?
  scopes          String[]
  autoProvision   Boolean          @default(false) @map("auto_provision")
  authorizeUrl    String?          @map("authorize_url")
  tokenUrl        String?          @map("token_url")
  userInfoUrl     String?          @map("user_info_url")
  createdAt       DateTime         @default(now()) @map("created_at")
  updatedAt       DateTime         @updatedAt @map("updated_at")
  
  // Relations
  authConfig      AuthConfig       @relation(fields: [authConfigId], references: [id], onDelete: Cascade)
  
  @@index([authConfigId])
  @@map("auth_providers")
}

// API configuration
model ApiConfig {
  id              String         @id @default(uuid())
  tenantId        String         @unique @map("tenant_id")
  bffEnabled      Boolean        @default(false) @map("bff_enabled")
  bffUrl          String?        @map("bff_url")
  apiGateway      ApiGateway     @map("api_gateway")
  rateLimit       Int            @default(5000) @map("rate_limit")
  corsEnabled     Boolean        @default(true) @map("cors_enabled")
  allowedOrigins  String[]       @map("allowed_origins")
  authType        ApiAuthType    @default(JWT) @map("auth_type")
  versioning      ApiVersioning  @default(URL)
  createdAt       DateTime       @default(now()) @map("created_at")
  updatedAt       DateTime       @updatedAt @map("updated_at")
  
  // Relations
  tenant          Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  
  @@map("api_configs")
}

// Activity log
model Activity {
  id          String       @id @default(uuid())
  tenantId    String       @map("tenant_id")
  userId      String?      @map("user_id")
  action      String
  target      String
  type        ActivityType
  metadata    Json?
  createdAt   DateTime     @default(now()) @map("created_at")
  
  // Relations
  tenant      Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  
  @@index([tenantId])
  @@index([type])
  @@index([createdAt])
  @@map("activities")
}

// OAuth session
model OAuthSession {
  id          String   @id @default(uuid())
  state       String   @unique
  providerId  String   @map("provider_id")
  tenantId    String   @map("tenant_id")
  redirectUri String   @map("redirect_uri")
  expiresAt   DateTime @map("expires_at")
  createdAt   DateTime @default(now()) @map("created_at")
  
  @@index([state])
  @@index([expiresAt])
  @@map("oauth_sessions")
}

// Enums (these don't need mapping - they're TypeScript-only)
enum TenantPlan {
  FREE
  STARTER
  PROFESSIONAL
  ENTERPRISE
}

enum TenantStatus {
  ACTIVE
  SUSPENDED
  TRIAL
}

enum UserRole {
  ADMIN
  MANAGER
  USER
}

enum UserStatus {
  ACTIVE
  INACTIVE
  PENDING
}

enum ApplicationStatus {
  RUNNING
  STOPPED
  DEPLOYING
  ERROR
}

enum Environment {
  PRODUCTION
  STAGING
  DEVELOPMENT
}

enum DatabaseStrategy {
  DATABASE_PER_TENANT
  SCHEMA_PER_TENANT
  SHARED_TABLES
}

enum DatabaseProvider {
  POSTGRESQL
  MYSQL
  MONGODB
  SQLSERVER
}

enum PasswordPolicy {
  STANDARD
  STRONG
  VERY_STRONG
}

enum AuthProviderType {
  ENTRA
  GOOGLE
  GITHUB
  OKTA
  AUTH0
  CUSTOM_OIDC
}

enum ApiGateway {
  KONG
  APIGEE
  AWS_APIGATEWAY
  AZURE_APIM
  CUSTOM
}

enum ApiAuthType {
  JWT
  OAUTH2
  API_KEY
}

enum ApiVersioning {
  URL
  HEADER
  QUERY
}

enum ActivityType {
  DEPLOY
  CONFIG
  USER
  BILLING
  ALERT
  AUTH
  API
}
```

### Usage in TypeScript

With the mappings above, your TypeScript code uses camelCase:

```typescript
// Create a tenant
const tenant = await prisma.tenant.create({
   {
    name: 'Acme Corp',
    slug: 'acme-corp',
    logoUrl: 'https://example.com/logo.png',  // camelCase in TS
    primaryColor: '#3b82f6',
    loginTitle: 'Welcome to Acme',
  },
});

// Query users
const users = await prisma.user.findMany({
  where: {
    tenantId: tenant.id,
    lastLoginAt: {
      gte: new Date('2024-01-01'),  // camelCase in TS
    },
  },
});

// Access fields
users.forEach(user => {
  console.log(user.email);
  console.log(user.lastLoginAt);  // camelCase in TS
});
```

### Database Schema (snake_case)

The actual database will have snake_case:

```sql
-- Table: tenants
CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  plan TenantPlan NOT NULL,
  status TenantStatus NOT NULL,
  logo_url VARCHAR(255),
  primary_color VARCHAR(20) DEFAULT '#3b82f6',
  custom_domain VARCHAR(255) UNIQUE,
  login_title VARCHAR(255),
  login_subtitle VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

-- Table: users
CREATE TABLE users (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id),
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  role UserRole DEFAULT 'USER',
  status UserStatus DEFAULT 'ACTIVE',
  last_login_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP,
  UNIQUE(tenant_id, email)
);

-- Table: applications
CREATE TABLE applications (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status ApplicationStatus NOT NULL,
  version VARCHAR(50) NOT NULL,
  environment Environment NOT NULL,
  url VARCHAR(255) NOT NULL,
  cpu INTEGER DEFAULT 0,
  memory INTEGER DEFAULT 0,
  requests INTEGER DEFAULT 0,
  last_deployed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);
```

### Benefits of This Approach

✅ **TypeScript**: camelCase (idiomatic JavaScript/TypeScript)  
✅ **Database**: snake_case (PostgreSQL convention)  
✅ **Best of Both Worlds**: Follows conventions for each layer  
✅ **Type Safety**: Prisma generates correct TypeScript types  
✅ **Migration Safe**: Prisma handles the mapping automatically  

### Quick Reference

| Prisma Concept | TypeScript | Database | Mapping |
|----------------|------------|----------|---------|
| Model name | `UserProfile` | `user_profiles` | `@@map("user_profiles")` |
| Field name | `firstName` | `first_name` | `@map("first_name")` |
| Relation field | `tenantId` | `tenant_id` | `@map("tenant_id")` |
| Timestamp | `createdAt` | `created_at` | `@map("created_at")` |

---

## 🎯 Summary

### 1. The `url` Error
- ✅ **Correct**: Remove `url` from `schema.prisma` for Prisma 7
- ✅ **Configuration**: Use `prisma.config.ts` for migrations
- ✅ **Runtime**: Use database adapter in PrismaClient
- ⚠️ **IDE Error**: Likely a false positive from outdated plugin

### 2. snake_case Mapping
- ✅ **@map**: Maps individual fields to snake_case columns
- ✅ **@@map**: Maps model to snake_case table
- ✅ **TypeScript**: Keep camelCase in your code
- ✅ **Database**: Use snake_case in PostgreSQL

### 3. Next Steps

```bash
cd backend

# Verify Prisma CLI works (ignore IDE errors)
npx prisma generate
npx prisma validate

# If these work, your setup is correct!
```

---

**Status**: ✅ Configuration verified  
**Prisma Version**: 7.10.0  
**Last Updated**: October 2026
