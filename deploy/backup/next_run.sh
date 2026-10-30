#!/bin/sh
# Seconds since the epoch of the next HH:MM in local time (TZ): today if it's
# still ahead, else tomorrow. Arithmetic only, so busybox's date is enough.
set -eu
num() { v="${1#0}"; echo "${v:-0}"; } # "08" is not octal here
h="$(num "${1%:*}")"; m="$(num "${1#*:}")"
set -- $(date '+%s %H %M %S')
now="$1"; cur=$(( $(num "$2") * 3600 + $(num "$3") * 60 + $(num "$4") ))
delta=$(( h * 3600 + m * 60 - cur ))
[ "$delta" -gt 0 ] || delta=$((delta + 86400))
echo $((now + delta))
