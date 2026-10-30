#!/bin/sh
# One backup, run by schedule.sh every night (or by hand: deploy/backup.sh).
#
# 1. Dumps every database on the server, and the roles (pg_dumpall), and packs
#    the audit archive (log entries already moved out of the databases).
# 2. Proves the dump restores: into a throwaway Postgres in this container,
#    checking the control plane's tables are there (BACKUP_VERIFY=false skips).
# 3. Encrypts both files to BACKUP_AGE_RECIPIENT, when set (an age public key;
#    the private key stays off this server, so a copy of the backups is
#    useless to whoever takes it).
# 4. Copies them to object storage, when BACKUP_S3_BUCKET is set, and removes
#    copies there older than BACKUP_KEEP_DAYS.
# 5. Keeps the newest BACKUP_KEEP_LOCAL here, and tells BACKUP_PING_URL
#    (healthchecks.io or similar) it worked, or that it failed, so a backup
#    that stops happening raises an alert.
#
# Settings come from the environment (deploy/docker-compose.yml, the backup service).
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
AUDIT_ARCHIVE_DIR="${AUDIT_ARCHIVE_DIR:-/audit-archive}"
KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-7}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
VERIFY="${BACKUP_VERIFY:-true}"
RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
BUCKET="${BACKUP_S3_BUCKET:-}"
PREFIX="${BACKUP_S3_PREFIX:-multitenant}"
PING="${BACKUP_PING_URL:-}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$BACKUP_DIR/.partial-$stamp"
log() { echo "$(date -u +%FT%TZ) backup: $*"; }

ping_url() { [ -z "$PING" ] || curl -fsS -m 10 --retry 3 -o /dev/null "$PING$1" || log "could not reach BACKUP_PING_URL"; }
fail() {
  log "FAILED: $*"
  rm -rf "$work"
  printf '{"status":"failed","at":"%s","error":"%s"}\n' "$(date -u +%FT%TZ)" "$(echo "$*" | tr '"\\\n\t' "''  " | cut -c1-500)" > "$BACKUP_DIR/last-backup.json"
  ping_url /fail
  exit 1
}
trap 'fail "stopped at line $LINENO"' INT TERM

mkdir -p "$BACKUP_DIR"
mkdir "$work"
ping_url /start

# 1. The dump and the audit archive
log "dumping all databases"
pg_dumpall --clean --if-exists 2> "$work/dump.err" | gzip > "$work/db-$stamp.sql.gz" || fail "pg_dumpall: $(tail -3 "$work/dump.err")"
# A pipe hides pg_dumpall's exit status: an empty or cut-off dump fails here
gzip -t "$work/db-$stamp.sql.gz" || fail "the dump is not a complete gzip file"
[ -s "$work/dump.err" ] && fail "pg_dumpall: $(tail -3 "$work/dump.err")"
zcat "$work/db-$stamp.sql.gz" | tail -5 | grep -q "PostgreSQL database cluster dump complete" || fail "the dump is incomplete"
rm "$work/dump.err"
if [ -d "$AUDIT_ARCHIVE_DIR" ]; then
  tar -C "$AUDIT_ARCHIVE_DIR" -czf "$work/audit-archive-$stamp.tar.gz" . || fail "packing the audit archive"
fi

# 2. Does it restore?
if [ "$VERIFY" = "true" ]; then
  log "test-restoring the dump"
  verify.sh "$work/db-$stamp.sql.gz" || fail "the dump did not restore cleanly (see above)"
fi

# 3. Encryption
if [ -n "$RECIPIENT" ]; then
  for f in "$work"/*.gz; do
    age -r "$RECIPIENT" -o "$f.age" "$f" || fail "encrypting $(basename "$f")"
    rm "$f"
  done
fi

# 4. Off this server
if [ -n "$BUCKET" ]; then
  log "copying to object storage ($BUCKET/$PREFIX)"
  rclone copy --no-traverse "$work" "offsite:$BUCKET/$PREFIX" --exclude ".*" 2>&1 | tail -5 || true
  for f in "$work"/*; do
    rclone lsf "offsite:$BUCKET/$PREFIX/$(basename "$f")" 2>/dev/null | grep -q . || fail "$(basename "$f") is not in object storage after copying it"
  done
  rclone delete --min-age "${KEEP_DAYS}d" "offsite:$BUCKET/$PREFIX" 2>&1 | tail -3 || log "removing old copies from object storage failed"
fi

# 5. Done: keep the newest here
mv "$work"/* "$BACKUP_DIR"/
rmdir "$work"
for kind in db audit-archive; do
  ls -1t "$BACKUP_DIR"/$kind-* 2>/dev/null | tail -n +"$((KEEP_LOCAL + 1))" | xargs -r rm --
done
size="$(du -ch "$BACKUP_DIR"/*-"$stamp".* | tail -1 | cut -f1)"
printf '{"status":"ok","at":"%s","files":"%s","size":"%s","offsite":%s,"encrypted":%s,"verified":%s}\n' \
  "$(date -u +%FT%TZ)" "$stamp" "$size" \
  "$([ -n "$BUCKET" ] && echo true || echo false)" "$([ -n "$RECIPIENT" ] && echo true || echo false)" \
  "$([ "$VERIFY" = "true" ] && echo true || echo false)" > "$BACKUP_DIR/last-backup.json"
ping_url ""
log "done: $stamp ($size)$([ -n "$BUCKET" ] && echo ", copied to object storage")"
