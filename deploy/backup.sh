#!/bin/sh
# Back up now, instead of waiting for the nightly run. The backup service
# (deploy/backup/, the `backup` service in docker-compose.yml) does the work
# and sends it to object storage when that's set up; files land in
# deploy/backups/. Restore with deploy/restore.sh. docs/DEPLOYMENT.md has the
# details.
set -eu
cd "$(dirname "$0")"
docker compose exec -T backup backup.sh
