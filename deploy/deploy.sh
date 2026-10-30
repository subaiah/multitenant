#!/bin/sh
# Switch this server to prebuilt images (the Deploy workflow runs it over SSH,
# .github/workflows/deploy.yml; you can run it by hand too):
#
#   deploy/deploy.sh <api image> <web image>
#
# 1. records the images in deploy/.env (API_IMAGE, WEB_IMAGE), so a later
#    plain `docker compose up -d` keeps using them;
# 2. pulls them, runs the release step (migrations) and restarts what changed;
# 3. removes images no container uses any more.
#
# The checkout (compose file, Caddyfile, init scripts) must already be at the
# commit the images were built from: the workflow does `git checkout <sha>`
# before calling this.
set -eu
cd "$(dirname "$0")"
api="$1"
web="$2"

[ -f .env ] || { echo "deploy/.env is missing: set the server up first (docs/DEPLOYMENT.md)" >&2; exit 1; }

set_env() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
set_env API_IMAGE "$api"
set_env WEB_IMAGE "$web"
# Shown with each error in error tracking: the commit the images were built from
set_env APP_VERSION "${api##*:}"

docker compose pull migrate api web
# The backup service's small image is built here, from this checkout
docker compose build backup
# The release step first, on its own: if a migration fails, the running API
# keeps serving the old version and the deploy stops here
docker compose run --rm migrate
docker compose up -d --no-build --remove-orphans
docker image prune -f >/dev/null
echo "Deployed $api and $web"
