-- One-time setup of the tenant database server, run by a superuser.
-- Creates the three roles the platform uses and the shared tenant database.
--
--   psql "postgresql://postgres@host/postgres" \
--     -v shared_db=multitenant_tenants \
--     -v owner_password=... -v provisioner_password=... -v platform_password=... \
--     [-v role_prefix=tnt_] \
--     -f prisma/tenant/setup-roles.sql
--
-- role_prefix must match TENANT_ROLE_PREFIX (default tnt_). Several
-- environments on one server (dev, test, e2e) can share the three roles, but
-- each needs its own shared_db and role_prefix, since role names are server-wide.
--
-- Then set (see .env.example):
--   TENANT_DATABASE_URL    = postgresql://tenant_owner:<owner_password>@host/<shared_db>
--   TENANT_PROVISIONER_URL = postgresql://tenant_provisioner:<provisioner_password>@host/postgres
--   TENANT_PLATFORM_URL    = postgresql://tenant_platform:<platform_password>@host/<shared_db>
--
-- Safe to re-run: existing roles get their passwords reset to the given ones.
\set ON_ERROR_STOP on
\if :{?role_prefix}
\else
  \set role_prefix tnt_
\endif
\set shared_group :role_prefix shared

-- Migration owner: owns every tenant table and runs tenant migrations
-- (lib/tenant-migrations.ts). CREATEDB lets `prisma migrate dev` make its
-- shadow database. Subject to row-level security like everyone else (FORCE).
SELECT format('CREATE ROLE tenant_owner LOGIN CREATEDB PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_owner') \gexec
ALTER ROLE tenant_owner WITH LOGIN CREATEDB NOSUPERUSER NOBYPASSRLS PASSWORD :'owner_password';

-- Provisioner: creates and drops tenant roles and tenant databases
-- (lib/provisioning.ts). Not a superuser.
SELECT format('CREATE ROLE tenant_provisioner LOGIN CREATEROLE CREATEDB PASSWORD %L', :'provisioner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_provisioner') \gexec
ALTER ROLE tenant_provisioner WITH LOGIN CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS PASSWORD :'provisioner_password';
-- ...so it can create tenant databases owned by the migration owner, and drop them
GRANT tenant_owner TO tenant_provisioner;
-- ...and end the connections still open to a database it's dropping (DROP DATABASE ... WITH (FORCE))
GRANT pg_signal_backend TO tenant_provisioner;

-- Platform role: bypasses row-level security, for cross-tenant platform work
-- (usage snapshots, re-encrypting secrets). Never used for tenant requests.
SELECT format('CREATE ROLE tenant_platform LOGIN BYPASSRLS PASSWORD %L', :'platform_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_platform') \gexec
ALTER ROLE tenant_platform WITH LOGIN BYPASSRLS NOSUPERUSER PASSWORD :'platform_password';

-- Group of every shared-tables tenant role: may use the shared tables, where
-- row-level security separates tenants. The provisioner adds members.
SELECT format('CREATE ROLE %I NOLOGIN', :'shared_group')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'shared_group') \gexec
SELECT format('GRANT %I TO tenant_provisioner WITH ADMIN OPTION', :'shared_group') \gexec

-- The shared tenant database, owned by the migration owner. Only the roles
-- that need it may connect (Postgres lets every role connect by default).
SELECT format('CREATE DATABASE %I OWNER tenant_owner', :'shared_db')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'shared_db') \gexec
SELECT format('ALTER DATABASE %I OWNER TO tenant_owner', :'shared_db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'shared_db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, tenant_platform, tenant_provisioner', :'shared_db', :'shared_group') \gexec

\connect :shared_db
ALTER SCHEMA public OWNER TO tenant_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA public TO %I, tenant_platform', :'shared_group') \gexec
