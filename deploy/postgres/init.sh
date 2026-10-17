#!/bin/sh
# First start of the database container only (the postgres image runs
# /docker-entrypoint-initdb.d/* when the data directory is empty):
#  - the control plane: database "multitenant", owned by its own login role,
#    which is not a superuser
#  - the tenant database server: the three roles and the shared tenant
#    database from setup-roles.sql
# Passwords come from the compose file's environment (deploy/.env).
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v control_password="$CONTROL_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE platform_app LOGIN PASSWORD %L', :'control_password') \gexec
CREATE DATABASE multitenant OWNER platform_app;
REVOKE ALL ON DATABASE multitenant FROM PUBLIC;
GRANT CONNECT ON DATABASE multitenant TO platform_app;
\connect multitenant
ALTER SCHEMA public OWNER TO platform_app;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v shared_db=multitenant_tenants \
  -v role_prefix="${TENANT_ROLE_PREFIX:-tnt_}" \
  -v owner_password="$TENANT_OWNER_PASSWORD" \
  -v provisioner_password="$TENANT_PROVISIONER_PASSWORD" \
  -v platform_password="$TENANT_PLATFORM_PASSWORD" \
  -f /opt/multitenant/setup-roles.sql
