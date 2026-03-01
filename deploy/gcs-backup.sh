#!/usr/bin/env bash
set -euo pipefail

BUCKET="${GCS_BACKUP_BUCKET:?GCS_BACKUP_BUCKET not set}"
PROJECT_DIR="${HOME}/nanoclaw"
LOG_TAG="nanoclaw-rsync"

log() { logger -t "$LOG_TAG" "$1"; }

# Validate bucket name to prevent injection
if [[ ! "$BUCKET" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]]; then
  log "ERROR: Invalid bucket name: $BUCKET"
  exit 1
fi

log "=== GCS rsync starting ==="

FAILED=0

# Sync each data directory explicitly (include-list approach)
for dir_pair in \
  "groups/:groups/" \
  "store/auth/:store/auth/" \
  "data/sessions/:data/sessions/"; do

  SRC="${dir_pair%%:*}"
  DST="${dir_pair##*:}"

  if [ ! -d "${PROJECT_DIR}/${SRC}" ]; then
    log "Skipping ${SRC} (does not exist)"
    continue
  fi

  log "Syncing ${SRC}..."
  gcloud storage rsync \
    "${PROJECT_DIR}/${SRC}" \
    "gs://${BUCKET}/rsync/${DST}" \
    --recursive \
    --checksums-only \
    --continue-on-error \
    2>&1 | logger -t "$LOG_TAG" || FAILED=1
done

# Write sentinel for monitoring (only on success)
if [ "$FAILED" -eq 0 ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | \
    gcloud storage cp - "gs://${BUCKET}/rsync/LAST_SYNC" 2>&1 | logger -t "$LOG_TAG"
  log "=== GCS rsync complete ==="
else
  log "=== GCS rsync completed with errors ==="
  exit 1
fi
