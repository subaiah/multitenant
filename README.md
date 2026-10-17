# Multitenant platform

A starter kit for multi-tenant SaaS products. It has two portals:

- **Platform portal**, for the people who run the service: tenants, platform staff, support access, the platform audit log.
- **Tenant portal**, for each customer organization: its users, groups, roles, sign-in settings, audit and activity logs, notifications.

A product forks the kit and adds its own tables, API and screens behind a few extension points ([docs/extending.md](docs/extending.md)).

| Part | Stack | Where |
| --- | --- | --- |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS | `src/` |
| API | Fastify 5, TypeScript, Node 24 | `backend/` |
| Data | PostgreSQL with Prisma 7 | `backend/prisma/` |
| Deployment | Docker images, Docker Compose, Caddy | `deploy/` |

## What's in it

- **Tenant isolation, chosen per tenant.** Shared tables, a schema of its own, or a database of its own. In every mode, tenant requests connect as the tenant's own Postgres role, and row-level security keeps tenants apart even if app code forgets a filter. ([docs/tenant-isolation.md](docs/tenant-isolation.md))
- **Sign-in.**
  - Passwords with per-tenant policies, one-time email codes, and single sign-on with Entra ID, Google, Okta, Auth0, GitHub, or any OpenID Connect provider.
  - Authenticator-app two-factor, idle and maximum session lengths, and sign out everywhere.
  - Sessions live in httpOnly cookies. ([backend/docs/AUTHENTICATION_METHODS.md](backend/docs/AUTHENTICATION_METHODS.md))
- **Access control.**
  - Roles with granular permissions, groups, and role assignments scoped to organizations.
  - Delegation, access requests and access reviews.
  - Platform roles for staff. ([backend/docs/RBAC_SYSTEM.md](backend/docs/RBAC_SYSTEM.md))
- **Support access.** Platform staff see tenant data only through a time-limited support session that someone else approves. Sessions are read-only unless approved otherwise, the tenant sees them, and the tenant can end one at any time. ([backend/docs/PLATFORM_ACCESS.md](backend/docs/PLATFORM_ACCESS.md))
- **Audit log.**
  - Tamper-evident: each tenant's log and the platform's is a signed hash chain.
  - Entries are archived after a year. ([backend/docs/AUDIT_LOG.md](backend/docs/AUDIT_LOG.md))
- **Notifications.** In-app and email, with organization rules and personal preferences. Products can add their own types. ([backend/docs/NOTIFICATIONS.md](backend/docs/NOTIFICATIONS.md))

## Pages with sample data

Some pages show data the demo seed fills in, because nothing real reports it yet:

- deployed applications and their CPU, memory and request figures (the tenant's Applications and Infrastructure pages);
- the API gateway settings;
- the backup and encryption switches;
- the platform's Global Policies and Settings pages.

Production hides them unless `PREVIEW_FEATURES=true`.

## Getting started

- **Develop:** [backend/README.md](backend/README.md) covers the databases, the API and the tests. Then run the frontend from this folder:

  ```sh
  npm install
  npm run dev          # http://localhost:5173, talks to the API at VITE_API_URL (default http://localhost:4000)
  ```

- **Deploy:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) covers a first installation with Docker Compose, upgrades, backups, keys, scaling out and monitoring.
