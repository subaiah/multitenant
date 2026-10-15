# Tenant isolation: setup and operations

Each tenant's data lives in one of three places, chosen when a platform admin creates the tenant:

| Mode | Where | Separated by |
| --- | --- | --- |
| Shared tables | The public schema of the shared tenant database | Row-level security |
| Own schema | A schema `tnt_<slug>` in the shared tenant database | Its own schema, plus row-level security |
| Own database | A database `tnt_<slug>` on the same server | Its own database, plus row-level security |

In every mode, the tenant's requests connect as its own Postgres login role (`tnt_<slug>`). Every tenant table has row-level security enabled and forced, with one policy: a row is visible, and writable, only when its `tenant_id` belongs to the connected role. Postgres enforces this on its own. It holds even if app code forgets a `where tenantId`, and even for raw SQL.

The control-plane database (`DATABASE_URL`) holds platform users, tenants and each tenant's encrypted connection details. It never holds tenant data.

## Roles

| Role | Can | Used for | Setting |
| --- | --- | --- | --- |
| `tenant_owner` (migration owner) | Owns every tenant table | Tenant migrations, row-level security, grants | `TENANT_DATABASE_URL` |
| `tenant_provisioner` | CREATEROLE, CREATEDB; not a superuser | Creating and dropping tenant roles and databases | `TENANT_PROVISIONER_URL` |
| `tenant_platform` | BYPASSRLS | Cross-tenant platform work: usage snapshots, re-encrypting secrets, data cleanup | `TENANT_PLATFORM_URL` |
| `tnt_<slug>`, one per tenant | Read and write rows in its own tables; no DDL | Every request of that tenant | Generated, stored encrypted in the control plane |
| `tnt_shared` (no login) | Use the shared tables | Every shared-tables tenant role is a member | None |

Nobody types a tenant's database password. The server generates it (32 random bytes) and sends Postgres only a SCRAM-SHA-256 verifier, so the password never appears in SQL or server logs. The password is stored encrypted inside the tenant's connection string.

## Setting up a server

Run this once as a superuser:

```sh
psql "postgresql://postgres@host/postgres" \
  -v shared_db=multitenant_tenants \
  -v owner_password=... -v provisioner_password=... -v platform_password=... \
  -f backend/prisma/tenant/setup-roles.sql
```

Then:

1. Set the three `TENANT_*_URL` settings (see `.env.example`).
2. Run `npm run tenant:migrate`. It creates the shared tables and their row-level security.

Several environments can share one server, say dev, test and e2e. Each needs its own `shared_db` and its own `TENANT_ROLE_PREFIX`, passed to the script as `-v role_prefix=dev_`, because role names are server-wide.

## Creating a tenant

A platform admin uses **New tenant** on the Tenants page, or `POST /tenants`. The tenant starts as `PENDING`, and a background job provisions it:

1. Picks the role name and generates a password. Both are kept, so a retry reuses them.
2. Creates the role (provisioner). A shared-tables tenant's role joins `tnt_shared`.
3. In own-database mode, creates the database (provisioner).
4. Applies every tenant migration, then row-level security and grants (migration owner).
5. As the tenant's own role, creates its defaults, built-in roles and first administrator.
6. Invites the first administrator.

The tenant is then `READY`. Until then, nobody can sign in or work inside it, platform admins included.

If a step fails, the tenant is `FAILED` and the Tenants page shows the error. Every step is safe to re-run, so **Retry setup** picks up where it stopped. A tenant left `PENDING` or `PROVISIONING` by a restart is resumed automatically after a couple of minutes.

The isolation mode can't be changed once a tenant has data. Moving data between modes needs a data-move tool, which doesn't exist yet.

## Deleting a tenant

**Delete tenant** in the tenant's panel, or `DELETE /tenants/:id`, works through these steps:

- **Shared tables:** deletes the tenant's rows from every tenant table, kit and product alike, and removes its role mapping.
- **Own schema:** drops the schema.
- **Own database:** drops the database. Its open connections are ended first.

Then it drops the role and the control-plane records. If a step fails, the tenant stays listed with the error, and deleting again retries.

## Migrations

Tenant migrations are the folders in `backend/prisma/tenant/migrations`. Create one with:

```sh
npm run prisma:migrate:tenant
```

This runs `prisma migrate dev` against the shared database, then `npm run tenant:migrate`.

`npm run tenant:migrate` applies pending migrations to every target: the shared database, each tenant schema and each tenant database.

- It records them in each target's own `_prisma_migrations` table. That's the same table Prisma uses, so the two agree on what's applied.
- After migrating, it re-applies row-level security to every table with a `tenant_id` column, and the grants. A new product table is covered without anyone writing a policy.
- Each tenant's database config records the latest migration and any error. A failed target is retried on the next run.
- Only one run at a time touches a target (advisory lock).

Keep changes backward compatible. During a rollout, tenants are on different migrations while the same app version serves them all. Split a breaking change across releases.

A data migration (an `UPDATE` backfill, say) must run as the platform role. The migration owner is subject to row-level security like everyone else, so it sees no rows.

With no migrations committed yet, `npm run tenant:baseline` writes a baseline of the whole tenant schema. CI uses it to start from empty.

## Platform pages

Tenant data is spread over many databases and schemas, so the tenant list and the platform dashboard read usage snapshots from the control plane (`tenant_usage`). These hold user and app counts, last activity, 14 days of activity and recent entries.

A background job refreshes the snapshots every `TENANT_USAGE_REFRESH_MS` (5 minutes by default), and once more when a tenant finishes provisioning. Pages show how old the figures are.

## Connections

Each app server keeps one small pool per tenant role:

- `TENANT_POOL_MAX` connections per pool (3 by default).
- At most `TENANT_CLIENT_CACHE_MAX` pools open (100 by default). The least recently used pool is closed first.
- Each role is limited to `TENANT_ROLE_CONNECTION_LIMIT` connections server-wide (10 by default), so one tenant can't take them all.

Past a few hundred active tenants on one server, put PgBouncer in front of it.

## Checks

These tests cover the mechanism:

- `test/isolation.test.ts` runs in every mode, using raw SQL as the tenant's role. It checks that:
  - every tenant table has row-level security enabled, forced and a policy
  - the role can't read or write other tenants' rows, read `tenant_roles`, run DDL or take another role
  - a schema-mode role can't reach the shared tables
  - a database-mode role can't connect anywhere else
  - the table owner sees nothing
  - a new table gets covered on the next migration run
- `test/tenants.test.ts` covers provisioning, retry and deletion in each mode.
- CI runs the whole suite four times:
  - with seeded tenants rotating through all three modes
  - once per mode
