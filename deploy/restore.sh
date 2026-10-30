#!/bin/sh
# Restore a backup made by the backup service.
#
#   deploy/restore.sh list                          what there is to restore
#   deploy/restore.sh <stamp> [age private key]     restore it (asks first)
#
# <stamp> is the date part of the file names, like 20261030T021500Z. The API,
# the worker and the web server are stopped while the databases are replaced,
# then everything is started again. Encrypted backups need the private key
# file made with age-keygen (docs/DEPLOYMENT.md, "Backups").
set -eu
cd "$(dirname "$0")"

if [ "${1:-}" = "list" ] || [ -z "${1:-}" ]; then
  docker compose run --rm --no-deps backup restore.sh list
  [ -n "${1:-}" ] || echo "Usage: deploy/restore.sh <stamp> [age private key file]"
  exit 0
fi

stamp="$1"
key="${2:-}"
mount=""
if [ -n "$key" ]; then
  [ -f "$key" ] || { echo "No such file: $key" >&2; exit 1; }
  mount="-v $(cd "$(dirname "$key")" && pwd)/$(basename "$key"):/run/age-identity:ro"
fi

printf 'This replaces ALL current data with the backup from %s. Type "restore" to go on: ' "$stamp"
read -r answer
[ "$answer" = "restore" ] || { echo "Stopped; nothing changed."; exit 1; }

docker compose stop web api worker 2>/dev/null || docker compose stop web api
# shellcheck disable=SC2086
if docker compose run --rm $mount backup restore.sh "$stamp"; then
  docker compose up -d
  echo "Restored $stamp; everything is running again."
else
  echo "The restore failed (see above). Data may be partly restored: fix the problem and run this again, or restore another backup." >&2
  echo "Start the app again with: docker compose up -d" >&2
  exit 1
fi
