#!/bin/sh
# A backup of everything the platform can't recreate: every database on the
# server (control plane, shared tenant database, each database-per-tenant
# database, and the roles) and the audit archive files.
#
#   deploy/backup.sh [target directory]        (default ./backups)
#
# Run it from cron, e.g. nightly:  15 2 * * * cd /srv/multitenant && deploy/backup.sh
# and copy the result off this server (object storage, another machine). A
# backup on the same disk is not a backup. Restore steps: docs/DEPLOYMENT.md.
set -eu
cd "$(dirname "$0")"
target="${1:-./backups}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$target"

# Roles and every database, consistent per database
docker compose exec -T db pg_dumpall -U postgres --clean --if-exists | gzip > "$target/db-$stamp.sql.gz"
# Audit entries already moved out of the databases
docker compose run --rm --no-deps -T --entrypoint tar api -C /data -czf - audit-archive > "$target/audit-archive-$stamp.tar.gz"

# Keep the last 14 of each locally
for kind in db audit-archive; do
  ls -1t "$target"/$kind-*.gz 2>/dev/null | tail -n +15 | xargs -r rm --
done
echo "Backed up to $target/db-$stamp.sql.gz and $target/audit-archive-$stamp.tar.gz"
