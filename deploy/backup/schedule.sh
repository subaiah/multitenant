#!/bin/sh
# The backup service's main process: run backup.sh every day at BACKUP_TIME
# (HH:MM, in TZ; UTC unless TZ is set). A failed backup is logged and
# reported (BACKUP_PING_URL), and the next one runs the next day as usual.
set -u
at="${BACKUP_TIME:-02:15}"
case "$at" in
  [01][0-9]:[0-5][0-9]|2[0-3]:[0-5][0-9]) ;;
  *) echo "backup: BACKUP_TIME must be HH:MM (got '$at')" >&2; exit 1 ;;
esac
echo "backup: scheduled daily at $at ($(date +%Z)); next: $(date -d "@$(next_run.sh "$at")" '+%F %H:%M %Z')"
while true; do
  next="$(next_run.sh "$at")"
  sleep $((next - $(date +%s)))
  backup.sh || true
  sleep 61 # past this minute, so the same time isn't picked again
done
