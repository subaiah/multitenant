#!/bin/sh
# Restore a dump into a throwaway Postgres and check it's usable: the
# platform's databases exist and the control plane has its tables and tenants.
#
#   verify.sh <db-....sql.gz>        (unencrypted; backup.sh runs it before encrypting)
#
# Runs as root in the backup container: the temporary server runs as postgres.
set -eu
dump="$1"
tmp="$(mktemp -d /tmp/verify.XXXXXX)"
port=55432
chown postgres "$tmp"
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/sh -c "$*"; else sh -c "$*"; fi; }
# The same superuser name as the server dumped from, as in a real restore
superuser="${PGUSER:-postgres}"
psql_t() { psql -X -h "$tmp" -p "$port" -U "$superuser" -At "$@"; }
cleanup() { as_pg "${pg_ctl:-pg_ctl} -D '$tmp/data' -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT

initdb="$(command -v initdb)"; pg_ctl="$(command -v pg_ctl)"  # su may reset PATH
as_pg "$initdb -D '$tmp/data' -U '$superuser' --auth=trust >/dev/null"
as_pg "$pg_ctl -D '$tmp/data' -o '-p $port -k $tmp -c listen_addresses= -c fsync=off -c max_connections=50' -l '$tmp/log' -w start >/dev/null"

# The dump drops and recreates everything, the role restoring it included
# (that one statement fails, harmlessly): count anything else that failed
errors="$(zcat "$dump" | PGHOST= psql -X -h "$tmp" -p "$port" -U "$superuser" -d postgres -q 2>&1 >/dev/null | grep -E '^(psql:.*)?ERROR' | grep -v -E "current user cannot be dropped|role \"$superuser\" already exists" || true)"
if [ -n "$errors" ]; then
  echo "verify: restoring reported errors:" >&2
  echo "$errors" | head -10 >&2
  exit 1
fi

dbs="$(PGHOST= psql_t -d postgres -c "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'")"
control="${CONTROL_DATABASE:-multitenant}"
echo ",$dbs," | grep -q ",$control," || { echo "verify: no $control database in the dump (found: $dbs)" >&2; exit 1; }
tables="$(PGHOST= psql_t -d "$control" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
migrations="$(PGHOST= psql_t -d "$control" -c 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')"
tenants="$(PGHOST= psql_t -d "$control" -c 'SELECT count(*) FROM tenants')"
[ "$tables" -gt 10 ] && [ "$migrations" -gt 0 ] || { echo "verify: the control plane looks empty ($tables tables, $migrations migrations)" >&2; exit 1; }
echo "verify: restored OK: databases $dbs; control plane $tables tables, $migrations migrations, $tenants tenants"
