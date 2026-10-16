# Quick Start Guide

Get the multi-tenant backend up and running in 5 minutes!

## Prerequisites

- Node.js 24+
- PostgreSQL 14+ (or Docker)
- npm or yarn

## Option 1: Using Docker (Recommended)

The easiest way to get started is with Docker Compose:

```bash
cd backend
docker-compose up -d
```

This will:
- Start PostgreSQL database
- Start the backend API
- Run migrations automatically
- Seed the database with sample data

Access the API at: `http://localhost:4000`
API Documentation: `http://localhost:4000/docs`

## Option 2: Manual Setup

### 1. Start PostgreSQL

```bash
# Using Homebrew (macOS)
brew install postgresql
brew services start postgresql

# Create database
createdb multitenant
```

### 2. Install Dependencies

```bash
cd backend
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/multitenant?schema=public"
JWT_SECRET="change-this-to-a-secure-random-string-at-least-32-chars"
```

### 4. Set Up Database

```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# Seed database
npm run prisma:seed
```

### 5. Start Server

```bash
npm run dev
```

## Testing the API

### 1. Register a New Tenant

```bash
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@test.com",
    "name": "Test Admin",
    "tenantName": "Test Company",
    "tenantSlug": "test-company"
  }'
```

Save the `token` and `tenant.id` from the response.

### 2. Login

```bash
curl -X POST http://localhost:4000/bff/auth/login -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@acme-corp.com",
    "password": "admin123",
    "tenantSlug": "acme-corp"
  }'
```

### 3. Access Protected Routes

```bash
curl http://localhost:4000/tenants/current \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-tenant-id: YOUR_TENANT_ID"
```

### 4. View API Documentation

Open `http://localhost:4000/docs` in your browser.

## Sample Data

The seed script creates:
- 4 tenants (Acme Corp, TechStart, Global Media, Startup Labs)
- 8 users (2 per tenant)
- 8 applications (2 per tenant)
- Database, auth, and API configurations
- Sample activities

### Login with Sample Data

```bash
# Acme Corporation
curl -X POST http://localhost:4000/bff/auth/login -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@acme-corp.com",
    "password": "admin123",
    "tenantSlug": "acme-corp"
  }'
```

To get tenant IDs:
```bash
npm run prisma:studio
```

## Common Issues

### Database Connection Error

```
Error: Can't reach database server at `localhost:5432`
```

**Solution**: Make sure PostgreSQL is running:
```bash
# macOS
brew services start postgresql

# Linux
sudo systemctl start postgresql

# Docker
docker-compose up -d postgres
```

### Port Already in Use

```
Error: listen EADDRINUSE: address already in use :::3000
```

**Solution**: Change the port in `.env`:
```env
PORT=3001
```

### Migration Errors

```bash
# Reset and re-run migrations
npm run db:reset
npm run prisma:migrate
npm run prisma:seed
```

## Next Steps

1. **Explore the API**: Visit `http://localhost:4000/docs`
2. **Configure Multi-Tenancy**: Set up database isolation strategies
3. **Add SSO Providers**: Configure authentication providers
4. **Set Up BFF**: Enable Backend for Frontend pattern
5. **Connect Frontend**: Use the API from your React application

## Useful Commands

```bash
# Development
npm run dev              # Start dev server with hot reload

# Database
npm run prisma:studio    # Open database GUI
npm run prisma:seed      # Seed sample data
npm run db:reset         # Reset database

# Production
npm run build            # Build for production
npm start                # Start production server

# Docker
docker-compose up -d     # Start all services
docker-compose down      # Stop all services
docker-compose logs -f   # View logs
```

## Support

- Check the [full README](./README.md) for detailed documentation
- View API docs at `http://localhost:4000/docs`
- Open Prisma Studio: `npm run prisma:studio`

Happy coding! 🚀
