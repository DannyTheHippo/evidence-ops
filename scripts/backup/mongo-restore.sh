#!/usr/bin/env bash
set -euo pipefail

# Restores a mongodump archive (as produced by mongo-backup.sh) into the compose-run `mongo`
# service.
#
#   scripts/backup/mongo-restore.sh <archive.gz>          # dry run: prints the target, changes nothing
#   scripts/backup/mongo-restore.sh <archive.gz> --yes    # restores for real
#
# Without --yes this prints exactly what would be overwritten — the container, the database,
# and every collection currently in it with its document count — and exits without touching
# anything. A restore that silently replaces a live database on a typo'd invocation is a
# footgun, not a tool.
#
# Restores with `--drop --nsInclude='evidence-ops.*'`, so only collections in this database are
# ever touched. `--drop` replaces every collection PRESENT IN THE ARCHIVE; a live collection not
# in the archive is left alone — this restores what was backed up, it does not wipe the whole
# database first.
#
# After a successful restore this verifies Atlas Search indexes on evidence_chunks are present.
# `--drop` also drops each collection's search indexes, and the restored `migrations` changelog
# already records migration 0003 (search-index creation) as applied — so a plain `migrate:up`
# afterward no-ops and retrieval silently returns zero rows until the indexes are rebuilt by
# hand. This script does not rebuild them automatically; it refuses to report success if they're
# missing and prints the recovery steps instead.

COMPOSE_SERVICE="mongo"
CONTAINER_NAME="evidence-ops-mongo"
DB_NAME="evidence-ops"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <archive.gz> [--yes]" >&2
  echo "  omit --yes for a dry run: prints the target and current collection counts, changes nothing" >&2
  exit 1
fi

ARCHIVE="$1"
CONFIRM="${2:-}"

if [[ ! -f "$ARCHIVE" ]]; then
  echo "error: archive not found: $ARCHIVE" >&2
  exit 1
fi

if ! docker compose exec -T "$COMPOSE_SERVICE" true >/dev/null 2>&1; then
  echo "error: '${COMPOSE_SERVICE}' service is not reachable via docker compose — is it up?" >&2
  exit 1
fi

if ! docker compose exec -T "$COMPOSE_SERVICE" which mongorestore >/dev/null 2>&1; then
  echo "error: mongorestore is not present in the '${COMPOSE_SERVICE}' container." >&2
  echo "fallback: run the official database-tools image against the same container's network:" >&2
  echo "  docker run --rm --network container:${CONTAINER_NAME} -v \"\$(pwd)\":/dump mongodb/mongodb-database-tools \\" >&2
  echo "    mongorestore --host=localhost --port=27017 --drop --nsInclude='${DB_NAME}.*' --archive=/dump/$(basename "$ARCHIVE") --gzip" >&2
  exit 1
fi

echo "target: container '${CONTAINER_NAME}' (compose service '${COMPOSE_SERVICE}'), database '${DB_NAME}'"
echo "archive: ${ARCHIVE}"
echo "current collections that would be DROPPED and replaced (only where the archive has a matching collection):"
docker compose exec -T "$COMPOSE_SERVICE" mongosh --quiet "$DB_NAME" --eval '
  db.getCollectionNames().forEach(function (name) {
    print("  " + name + ": " + db.getCollection(name).countDocuments() + " docs");
  });
'

if [[ "$CONFIRM" != "--yes" ]]; then
  echo
  echo "dry run — no changes made. Re-run with --yes as the second argument to restore for real."
  exit 0
fi

echo
echo "restoring (this DROPS and replaces every collection present in the archive) ..."
if ! docker compose exec -T "$COMPOSE_SERVICE" mongorestore --drop --nsInclude="${DB_NAME}.*" --archive --gzip <"$ARCHIVE"; then
  echo "error: mongorestore exited nonzero — restore did not complete cleanly, do not treat this as a successful restore" >&2
  exit 1
fi

echo "verifying Atlas Search indexes on evidence_chunks ..."
SEARCH_INDEX_COUNT="$(docker compose exec -T "$COMPOSE_SERVICE" mongosh --quiet "$DB_NAME" --eval '
  print(db.evidence_chunks.aggregate([{ $listSearchIndexes: {} }]).toArray().length)
')"

if [[ "$SEARCH_INDEX_COUNT" == "0" ]]; then
  echo "WARNING: restore completed but evidence_chunks has 0 search indexes." >&2
  echo "  retrieval will silently return zero rows until these are rebuilt. Recovery:" >&2
  echo "  1. docker compose exec -T ${COMPOSE_SERVICE} mongosh ${DB_NAME} --eval 'db.migrations.deleteOne({fileName: /0003-search-indexes/})'" >&2
  echo "  2. npm run migrate:up" >&2
  exit 1
fi

echo "restore complete: ${SEARCH_INDEX_COUNT} search index(es) present on evidence_chunks"
