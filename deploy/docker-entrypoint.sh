#!/bin/sh
set -e
# If ROOM_DB_PATH points at a real file (not :memory:), ensure its directory
# exists and is owned by bun, so the non-root process can write the SQLite DB.
# This fixes a pre-existing root-owned mounted volume on first start.
DB="${ROOM_DB_PATH:-}"
if [ -n "$DB" ] && [ "$DB" != ":memory:" ]; then
  dir=$(dirname "$DB")
  mkdir -p "$dir"
  chown -R bun:bun "$dir"
fi
exec su-exec bun "$@"
