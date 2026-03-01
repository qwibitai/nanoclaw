#!/usr/bin/env bash
set -euo pipefail

BUCKET="${GCS_BACKUP_BUCKET:?GCS_BACKUP_BUCKET not set}"
PROJECT_DIR="${HOME}/nanoclaw"
DB_PATH="${PROJECT_DIR}/store/messages.db"

# Validate bucket name to prevent injection
if [[ ! "$BUCKET" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]]; then
  echo "ERROR: Invalid bucket name: $BUCKET"
  exit 1
fi

echo "1. Stopping services..."
systemctl --user stop nanoclaw 2>/dev/null || true
systemctl --user stop nanoclaw-rsync.timer 2>/dev/null || true
systemctl --user stop litestream 2>/dev/null || true
sleep 2  # Wait for processes to fully exit

echo "2. Backing up existing DB (if present)..."
if [ -f "$DB_PATH" ]; then
  cp "$DB_PATH" "${DB_PATH}.pre-restore" 2>/dev/null || true
fi

echo "3. Restoring SQLite from Litestream..."
rm -f "$DB_PATH" "${DB_PATH}-wal" "${DB_PATH}-shm"
rm -rf "${DB_PATH}-litestream"
litestream restore -parallelism 16 -config "${HOME}/.config/litestream.yml" "$DB_PATH" || {
  echo "WARNING: Litestream restore failed (fresh deploy?)"
}

if [ -f "$DB_PATH" ]; then
  echo "4. Checking database integrity..."
  INTEGRITY=$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;" 2>&1)
  if [ "$INTEGRITY" != "ok" ]; then
    echo "WARNING: Database integrity check returned: $INTEGRITY"
    echo "         Proceeding anyway -- check manually if issues arise."
  else
    echo "   Database integrity OK."
  fi
fi

echo "5. Restoring files from rsync backup..."
mkdir -p "${PROJECT_DIR}/groups" "${PROJECT_DIR}/store/auth" "${PROJECT_DIR}/data/sessions"

gcloud storage rsync \
  "gs://${BUCKET}/rsync/groups/" \
  "${PROJECT_DIR}/groups/" \
  --recursive || echo "WARNING: groups restore failed"

gcloud storage rsync \
  "gs://${BUCKET}/rsync/store/auth/" \
  "${PROJECT_DIR}/store/auth/" \
  --recursive || echo "WARNING: auth restore failed"

gcloud storage rsync \
  "gs://${BUCKET}/rsync/data/sessions/" \
  "${PROJECT_DIR}/data/sessions/" \
  --recursive || echo "WARNING: sessions restore failed"

echo "6. Starting services..."
systemctl --user start litestream
systemctl --user start nanoclaw
systemctl --user start nanoclaw-rsync.timer

echo ""
echo "7. Verifying services..."
systemctl --user status litestream nanoclaw --no-pager || true

echo ""
echo "Restore complete."
echo ""
echo "NOTE: WhatsApp auth tokens may be stale. If the bot does not connect,"
echo "      re-authenticate by scanning the QR code (npm run setup)."
