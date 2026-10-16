# Backend

The platform's API: Fastify 5 and TypeScript on Node 24, with Prisma 7 on PostgreSQL. It has two database planes:

- **The control plane:** platform users, tenants, and where each tenant's data lives.
- **The tenant plane:** each tenant's own data, separated by Postgres roles and row-level security.

Deploying it is covered in [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md). This page covers working on it.

## Local setup

You need Node 24 and PostgreSQL 14 or newer. A local server where you are a superuser is easiest.

```sh
npm install
cp .env.example .env              # then set DATABASE_URL and the TENANT_* URLs

# One-time: the tenant roles and the shared tenant database
createdb multitenant
psql -d postgres -v shared_db=multitenant_tenants \
  -v owner_password=owner -v provisioner_password=prov -v platform_password=plat \
  -f prisma/tenant/setup-roles.sql

npm run prisma:generate           # Prisma clients for both planes
npm run migrate                   # control-plane and tenant migrations, menu entries
npm run prisma:seed               # demo tenants and users (development only)
npm run dev                       # http://localhost:4000, API reference at /docs
```

Then start the frontend from the repository root (`npm install && npm run dev`) and open http://localhost:5173. The seed prints the demo accounts, for example `admin@platform.local` / `admin123`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Server with reload on change |
| `npm run build`, `npm start` | Compile to `dist/` and run it |
| `npm run migrate` | The release step: control-plane migrations, menu entries, then every tenant target |
| `npm run platform:admin -- <email>` | Invite a platform administrator (the first one on a new installation) |
| `npm test` | Integration tests against real databases (below) |
| `npm run prisma:migrate` | A new control-plane migration from `prisma/control/schema.prisma` |
| `npm run prisma:migrate:tenant` | A new tenant migration from `prisma/tenant/`, applied to every tenant |
| `npm run tenant:migrate` | Apply tenant migrations only |
| `npm run prisma:seed`, `npm run prisma:seed-menus` | Demo data; menu entries (`-- --reset` to replace them) |
| `npm run audit:verify`, `npm run audit:archive` | Check the audit logs' hash chains; archive old entries now |
| `npm run secrets:encrypt` | Re-encrypt stored secrets under the newest key (`-- --check` to report only) |

In the production image, the same commands are `node dist/cli/<name>.js`.

## Tests

The tests start the real server against real Postgres databases. Each run gets its own tenants and cleans up afterwards, so test files run in parallel. The tests need their own databases, set up the same way as above:

```sh
createdb test
psql -d postgres -v shared_db=test_tenant -v role_prefix=tst_ \
  -v owner_password=owner -v provisioner_password=prov -v platform_password=plat \
  -f prisma/tenant/setup-roles.sql

export DATABASE_URL=postgresql://localhost/test
export TENANT_DATABASE_URL=postgresql://tenant_owner:owner@localhost/test_tenant
export TENANT_PROVISIONER_URL=postgresql://tenant_provisioner:prov@localhost/postgres
export TENANT_PLATFORM_URL=postgresql://tenant_platform:plat@localhost/test_tenant
export TENANT_ROLE_PREFIX=tst_ NODE_ENV=test JWT_SECRET=test-jwt-secret-test-jwt-secret-1234
npm run migrate && npm test
```

Seeded tenants rotate through the three isolation modes. `TEST_TENANT_MODE=SHARED_TABLES` (or `SCHEMA_PER_TENANT`, `DATABASE_PER_TENANT`) puts every tenant in one mode, which is how CI runs the suite four times.

## Layout

| Path | What |
| --- | --- |
| `src/server.ts` | Plugins, route registration, start-up checks, background jobs |
| `src/routes/` | The API, one file per area |
| `src/middleware/` | `authenticate` (session, tenant), `authorize` (each route's `config.permission`), errors |
| `src/lib/` | Everything else: provisioning, tenant connections, migrations, sign-in, audit log, notifications, support sessions |
| `src/kit/` | Extension points shared with products: audit events, notification types, menu definitions |
| `src/product/` | A product's own tables, routes and permissions ([docs/extending.md](../docs/extending.md)) |
| `src/cli/` | Operational commands (`dist/cli` in the image) |
| `prisma/control/`, `prisma/tenant/` | Schemas and committed migrations of both planes; `setup-roles.sql` |
| `test/` | Integration tests |

## More

- [Tenant isolation: setup and operations](../docs/tenant-isolation.md)
- [Deploying and running in production](../docs/DEPLOYMENT.md)
- [Building a product on the kit](../docs/extending.md)
- [Signing in](docs/AUTHENTICATION_METHODS.md)
- [Roles and permissions](docs/RBAC_SYSTEM.md)
- [Platform roles and support access](docs/PLATFORM_ACCESS.md)
- [Audit log](docs/AUDIT_LOG.md)
- [Notifications](docs/NOTIFICATIONS.md)
