#!/usr/bin/env bash
set -euo pipefail

# Backs up the compose-run `mongo` service via mongodump, through `docker compose exec`.
#
#   scripts/backup/mongo-backup.sh <output-archive.gz>
#
# Run from the repo root with `mongo` already up (`docker compose up -d mongo`). The archive is
# a single gzip file (`mongodump --archive --gzip`), scoped to the `evidence-ops` database only
# — a bare `--archive` would also pull `admin`/`config`, and restoring those back risks
# colliding with the target cluster's own bookkeeping.
#
# No default output path inside this tree: an archive is real tenant data and does not belong
# in a project directory that gets committed. Pass a path outside the repo (or a gitignored one
# of your own).
#
# Fallback: if the `mongo` image ships no `mongodump` (mongodb/mongodb-atlas-local is not
# guaranteed to bundle the database tools on every tag), this script fails loudly and prints the
# equivalent invocation against the official `mongodb/mongodb-database-tools` image, attached to
# the mongo container's own network namespace (`--network container:<name>`) so no compose
# network name has to be guessed.

COMPOSE_SERVICE="mongo"
CONTAINER_NAME="evidence-ops-mongo"
DB_NAME="evidence-ops"

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <output-archive.gz>" >&2
  echo "  writes a gzip mongodump archive of the '${DB_NAME}' database" >&2
  exit 1
fi

OUT="$1"
TMP="${OUT}.tmp"

if ! docker compose exec -T "$COMPOSE_SERVICE" true >/dev/null 2>&1; then
  echo "error: '${COMPOSE_SERVICE}' service is not reachable via docker compose — is it up? ('docker compose up -d mongo')" >&2
  exit 1
fi

if ! docker compose exec -T "$COMPOSE_SERVICE" which mongodump >/dev/null 2>&1; then
  echo "error: mongodump is not present in the '${COMPOSE_SERVICE}' container." >&2
  echo "fallback: run the official database-tools image against the same container's network:" >&2
  echo "  docker run --rm --network container:${CONTAINER_NAME} -v \"\$(pwd)\":/dump mongodb/mongodb-database-tools \\" >&2
  echo "    mongodump --host=localhost --port=27017 --db=${DB_NAME} --archive=/dump/$(basename "$OUT") --gzip" >&2
  exit 1
fi

# Cleans up a partial file on any failure below; cleared right before the final `mv` so a
# successful run never removes the archive it just produced.
trap 'rm -f "$TMP"' EXIT

echo "backing up '${DB_NAME}' from '${COMPOSE_SERVICE}' to ${OUT} ..."
if ! docker compose exec -T "$COMPOSE_SERVICE" mongodump --db="$DB_NAME" --archive --gzip >"$TMP"; then
  echo "error: mongodump exited nonzero — no archive written" >&2
  exit 1
fi

if [[ ! -s "$TMP" ]]; then
  echo "error: mongodump produced an empty archive — refusing to keep it" >&2
  exit 1
fi

if ! gzip -t "$TMP" 2>/dev/null; then
  echo "error: archive failed gzip integrity check — refusing to keep it" >&2
  exit 1
fi

mv "$TMP" "$OUT"
trap - EXIT
echo "wrote $(du -h "$OUT" | cut -f1) to $OUT"
