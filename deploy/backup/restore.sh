#!/bin/sh
# Inside the backup container (deploy/restore.sh runs it, with the API stopped):
#
#   restore.sh list                  backups here and in object storage
#   restore.sh <stamp>               restore that backup: databases and audit archive
#
# <stamp> is the part of the file names like 20261030T021500Z. Files are taken
# from /backups, or fetched from object storage. Encrypted ones (.age) need the
# private key at /run/age-identity (deploy/restore.sh mounts it).
set -eu
BACKUP_DIR="${BACKUP_DIR:-/backups}"
AUDIT_ARCHIVE_DIR="${AUDIT_ARCHIVE_DIR:-/audit-archive}"
BUCKET="${BACKUP_S3_BUCKET:-}"
PREFIX="${BACKUP_S3_PREFIX:-multitenant}"
IDENTITY="${BACKUP_AGE_IDENTITY:-/run/age-identity}"

if [ "${1:-}" = "list" ]; then
  echo "On this server ($BACKUP_DIR):"
  ls -1 "$BACKUP_DIR" | grep -E '^(db|audit-archive)-' | sed 's/^/  /' || echo "  (none)"
  if [ -n "$BUCKET" ]; then
    echo "In object storage ($BUCKET/$PREFIX):"
    rclone lsf "offsite:$BUCKET/$PREFIX" | sed 's/^/  /' || echo "  (could not list)"
  fi
  exit 0
fi

stamp="${1:?usage: restore.sh list | restore.sh <stamp, like 20261030T021500Z>}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Find a file for this stamp: here first, then in object storage
fetch() { # kind -> path of the readable (decrypted) file, or nothing
  for name in "$1-$stamp.$2" "$1-$stamp.$2.age"; do
    src=""
    if [ -f "$BACKUP_DIR/$name" ]; then
      src="$BACKUP_DIR/$name"
    elif [ -n "$BUCKET" ] && rclone lsf "offsite:$BUCKET/$PREFIX/$name" 2>/dev/null | grep -q .; then
      echo "fetching $name from object storage" >&2
      rclone copyto "offsite:$BUCKET/$PREFIX/$name" "$tmp/$name" >&2
      src="$tmp/$name"
    fi
    [ -n "$src" ] || continue
    case "$name" in
      *.age)
        [ -s "$IDENTITY" ] || { echo "$name is encrypted: give deploy/restore.sh the age private key file" >&2; exit 1; }
        age -d -i "$IDENTITY" -o "$tmp/${name%.age}" "$src" >&2
        echo "$tmp/${name%.age}" ;;
      *) echo "$src" ;;
    esac
    return 0
  done
}

db="$(fetch db sql.gz)"
[ -n "$db" ] || { echo "No database backup for $stamp (restore.sh list shows them)" >&2; exit 1; }
gzip -t "$db"

echo "restoring the databases from $stamp"
# The dump drops and recreates every database and role. The role running it
# can't drop itself; that error is expected.
zcat "$db" | psql -X -d postgres -q 2>&1 | grep -E 'ERROR' | grep -v -E "current user cannot be dropped|role \"${PGUSER:-postgres}\" already exists" | head -20 || true

archive="$(fetch audit-archive tar.gz || true)"
if [ -n "$archive" ]; then
  echo "restoring the audit archive"
  mkdir -p "$AUDIT_ARCHIVE_DIR"
  tar -C "$AUDIT_ARCHIVE_DIR" -xzf "$archive"
fi
echo "restored $stamp"
