# Multi-Tenant BFF & API Backend

A production-ready Node.js 24 backend implementing Backend for Frontend (BFF) and API services for multi-tenant application management, built with Fastify, Prisma, and PostgreSQL.

## 🚀 Features

### Core Architecture
- **Fastify 5**: High-performance web framework for Node.js
- **Prisma 6**: Next-generation ORM for PostgreSQL
- **TypeScript 5.7**: Full type safety and modern JavaScript features
- **Node.js 24**: Latest LTS with performance improvements

### Multi-Tenancy Support
- **Database per Tenant**: Complete isolation with dedicated databases
- **Schema per Tenant**: Shared database with isolated schemas
- **Shared Tables**: Row-level security with tenant_id column
- **Tenant Context Middleware**: Automatic tenant extraction and validation

### Security
- **JWT Authentication**: Secure token-based authentication
- **Rate Limiting**: Per-tenant rate limiting to prevent abuse
- **CORS Configuration**: Configurable cross-origin resource sharing
- **Helmet**: Security headers for all responses
- **Input Validation**: Zod schemas for request validation

### BFF Pattern Implementation
- **Token Management**: Server-side OAuth token handling
- **API Aggregation**: Combine multiple backend calls into single requests
- **Tenant Isolation**: Automatic tenant context injection
- **Security**: Keep sensitive credentials server-side

### API Features
- **RESTful Design**: Clean, predictable API endpoints
- **Swagger Documentation**: Auto-generated API docs at `/docs`
- **Pagination**: Consistent pagination across all list endpoints
- **Filtering**: Flexible filtering with query parameters
- **Activity Logging**: Comprehensive audit trail

## 📁 Project Structure

```
backend/
├── prisma/
│   ├── schema.prisma          # Database schema
│   └── seed.ts                # Database seed script
├── src/
│   ├── config/
│   │   └── env.ts             # Environment configuration
│   ├── lib/
│   │   └── prisma.ts          # Prisma client singleton
│   ├── middleware/
│   │   ├── error-handler.ts   # Global error handling
│   │   └── tenant-context.ts  # Tenant extraction middleware
│   ├── routes/
│   │   ├── auth.ts            # Authentication routes
│   │   ├── tenants.ts         # Tenant management
│   │   ├── users.ts           # User management
│   │   ├── applications.ts    # Application management
│   │   ├── activities.ts      # Activity logs
│   │   ├── database.ts        # Database configuration
│   │   ├── auth-config.ts     # Auth provider configuration
│   │   ├── api-config.ts      # API configuration
│   │   ├── bff.ts             # BFF aggregation routes
│   │   └── health.ts          # Health check endpoints
│   └── server.ts              # Fastify server setup
├── .env.example               # Environment variables template
├── package.json               # Dependencies and scripts
└── tsconfig.json              # TypeScript configuration
```

## 🛠️ Technology Stack

- **Runtime**: Node.js 24
- **Framework**: Fastify 5.1.0
- **ORM**: Prisma 6.1.0
- **Database**: PostgreSQL
- **Authentication**: JWT (@fastify/jwt)
- **Validation**: Zod
- **Documentation**: Swagger (@fastify/swagger-ui)
- **Security**: Helmet, CORS, Rate Limiting

## 📋 Prerequisites

- Node.js 24 or higher
- PostgreSQL 14 or higher
- npm or yarn

## 🚀 Getting Started

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Set Up Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and configure:
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/multitenant?schema=public"
JWT_SECRET="your-super-secret-jwt-key-change-in-production"
```

### 3. Set Up Database

```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# Seed database with sample data
npm run prisma:seed
```

### 4. Start Development Server

```bash
npm run dev
```

The server will start at `http://localhost:4000`

### 5. Access API Documentation

Open `http://localhost:4000/docs` in your browser to view the Swagger UI.

## 🔐 Authentication

### Register a New Tenant

```bash
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "name": "Admin User",
    "tenantName": "Example Corp",
    "tenantSlug": "example-corp"
  }'
```

Response:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "tenant": {
    "id": "uuid",
    "name": "Example Corp",
    "slug": "example-corp"
  },
  "user": {
    "id": "uuid",
    "email": "admin@example.com",
    "name": "Admin User",
    "role": "ADMIN"
  }
}
```

### Login

```bash
curl -X POST http://localhost:4000/bff/auth/login -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@acme-corp.com",
    "password": "admin123",
    "tenantSlug": "acme-corp"
  }'
```

### Using the Token

Include the JWT token in the Authorization header:

```bash
curl -X GET http://localhost:4000/tenants/current \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "x-tenant-id: uuid"
```

## 📡 API Endpoints

### Authentication
- `POST /auth/register` - Register new tenant and admin user
- `POST /bff/auth/login` - Sign in; sets the session cookies (see docs/AUTHENTICATION_METHODS.md for two-factor and single sign-on)
- `GET /auth/verify` - Verify JWT token

### Tenants
- `GET /tenants` - List all tenants (admin only)
- `GET /tenants/current` - Get current tenant
- `GET /tenants/:id` - Get tenant by ID
- `PATCH /tenants/:id` - Update tenant
- `DELETE /tenants/:id` - Delete tenant

### Users
- `GET /users` - List users for current tenant
- `GET /users/me` - Get current user
- `GET /users/:id` - Get user by ID
- `POST /users` - Create user
- `PATCH /users/:id` - Update user
- `DELETE /users/:id` - Delete user

### Applications
- `GET /applications` - List applications
- `GET /applications/:id` - Get application
- `POST /applications` - Create application
- `PATCH /applications/:id` - Update application
- `DELETE /applications/:id` - Delete application
- `POST /applications/:id/deploy` - Deploy application

### Activities
- `GET /activities` - List activities
- `GET /activities/stats` - Get activity statistics

### Database Configuration
- `GET /database` - Get database config
- `PATCH /database` - Update database config
- `GET /database/strategies` - Get available strategies

### Auth Configuration
- `GET /auth-config` - Get auth config
- `PATCH /auth-config` - Update auth config
- `GET /auth-config/providers` - List auth providers
- `POST /auth-config/providers` - Add auth provider
- `PATCH /auth-config/providers/:id` - Update provider
- `DELETE /auth-config/providers/:id` - Delete provider
- `GET /auth-config/available-providers` - Get available providers

### API Configuration
- `GET /api-config` - Get API config
- `PATCH /api-config` - Update API config
- `GET /api-config/gateways` - Get available gateways
- `GET /api-config/bff-info` - Get BFF pattern info

### BFF (Backend for Frontend)
- `GET /bff/dashboard` - Aggregated dashboard data
- `POST /bff/token/exchange` - Exchange tokens
- `GET /bff/tenant/:tenantId/data` - Aggregated tenant data
- `GET /bff/health` - BFF health check
- `GET /bff/apps/:appId/overview` - Application overview

### Health
- `GET /health` - Basic health check
- `GET /health/detailed` - Detailed health with DB status

## 🏗️ Multi-Tenancy Architecture

### Database Isolation Strategies

#### 1. Database per Tenant
```
Tenant A → Database A
Tenant B → Database B
```
- **Best for**: Enterprise, regulated industries
- **Pros**: Maximum isolation, independent scaling
- **Cons**: Higher cost, complex migrations

#### 2. Schema per Tenant
```
Tenant A → Schema A (in shared DB)
Tenant B → Schema B (in shared DB)
```
- **Best for**: Mid-market SaaS
- **Pros**: Good isolation, lower cost
- **Cons**: Schema migration complexity

#### 3. Shared Tables
```
All Tenants → Shared Tables with tenant_id
```
- **Best for**: Startups, free tiers
- **Pros**: Lowest cost, simplest operations
- **Cons**: Weakest isolation

### Tenant Context Flow

1. Request arrives with `x-tenant-id` header
2. `tenantContext` middleware extracts tenant ID
3. Middleware validates tenant exists and is active
4. Tenant is attached to request object
5. All subsequent operations use tenant context

## 🔒 Security Features

### JWT Authentication
- Tokens signed with HS256 algorithm
- Configurable expiration (default: 24h)
- Automatic token verification on protected routes

### Rate Limiting
- Per-tenant rate limiting
- Configurable limits and time windows
- Prevents abuse and DoS attacks

### Input Validation
- All inputs validated with Zod schemas
- Type-safe request/response handling
- Automatic validation error responses

### CORS
- Configurable allowed origins
- Credentials support
- Preflight request handling

## 📊 Database Schema

### Core Models

- **Tenant**: Organization/customer
- **User**: Users belonging to tenants
- **Application**: Applications per tenant
- **DatabaseConfig**: Database isolation strategy
- **AuthConfig**: Authentication settings
- **AuthProvider**: SSO provider configurations
- **ApiConfig**: API and BFF settings
- **Activity**: Audit log entries

### Relationships

```
Tenant 1──* User
Tenant 1──* Application
Tenant 1──1 DatabaseConfig
Tenant 1──1 AuthConfig
Tenant 1──1 ApiConfig
Tenant 1──* Activity
AuthConfig 1──* AuthProvider
```

## 🧪 Development

### Available Scripts

```bash
# Development
npm run dev          # Start dev server with hot reload

# Production
npm run build        # Compile TypeScript
npm start            # Start production server

# Database
npm run prisma:generate        # Generate Prisma clients
npx prisma migrate deploy      # Apply control-plane migrations (prisma/control/migrations)
npm run tenant:migrate         # Apply tenant migrations to every tenant (prisma/tenant/migrations)
npm run prisma:migrate         # Make a control-plane migration after changing prisma/control
npm run prisma:migrate:tenant  # Make a tenant migration after changing prisma/tenant
npm run prisma:studio          # Open Prisma Studio
npm run prisma:seed            # Seed demo data
```

### Database setup and upgrades

Migrations are committed for both planes and are the history of the production schema.

A new database:

```bash
psql -U postgres -v shared_db=multitenant_tenants -v owner_password=... -v provisioner_password=... \
  -v platform_password=... -f prisma/tenant/setup-roles.sql
npx prisma migrate deploy
npm run tenant:migrate
npm run prisma:seed
```

A database created earlier with `db push` (before migrations were committed): mark the
starting point as applied once, then deploy as usual.

```bash
npx prisma migrate resolve --applied 00000000000000_init
npx prisma migrate deploy
npm run tenant:migrate   # tenants already on 00000000000000_baseline get the newer migrations
```

### Code Quality

- **TypeScript**: Strict mode enabled
- **ESLint**: Code linting (add your config)
- **Prettier**: Code formatting (add your config)

## 🚢 Production Deployment

### Environment Variables

Required for production:
```env
NODE_ENV=production
DATABASE_URL=postgresql://...
JWT_SECRET=<strong-random-secret>
CORS_ORIGIN=https://your-frontend.com
LOG_LEVEL=info
```

### Build and Start

```bash
npm run build
npm start
```

### Docker Deployment

Create a `Dockerfile`:
```dockerfile
FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY prisma ./prisma
RUN npx prisma generate

COPY dist ./dist

EXPOSE 3000

CMD ["node", "dist/server.js"]
```

## 📈 Monitoring

### Health Checks

```bash
# Basic health check
curl http://localhost:4000/health

# Detailed health with DB status
curl http://localhost:4000/health/detailed
```

### Logging

Logs are structured JSON in production, pretty-printed in development.

Log levels: `fatal`, `error`, `warn`, `info`, `debug`, `trace`

## 🔧 Configuration

### Rate Limiting

```env
RATE_LIMIT_MAX=1000           # Max requests
RATE_LIMIT_TIME_WINDOW=60000  # Time window in ms
```

### CORS

```env
CORS_ORIGIN=http://localhost:5173  # Comma-separated for multiple
```

### JWT

```env
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=24h
```

## 📚 Additional Resources

- [Fastify Documentation](https://www.fastify.io/docs/latest/)
- [Prisma Documentation](https://www.prisma.io/docs)
- [Zod Documentation](https://zod.dev/)
- [Node.js 24 Release Notes](https://nodejs.org/en/blog/release)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

MIT License - feel free to use this project for learning and commercial purposes.

## 🙏 Acknowledgments

- Fastify team for the amazing framework
- Prisma team for the excellent ORM
- Node.js community for continuous improvements
