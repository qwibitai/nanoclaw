#!/usr/bin/env bash
# NanoClaw daily backup to USB drive
# Backs up: store/ (SQLite DB), groups/ (memory), data/ (config)
# Retains: 30 days of snapshots

set -euo pipefail

NANOCLAW_DIR="/home/jorgenclaw/NanoClaw"
BACKUP_ROOT="/media/jorgenclaw/NanoClaw/backups"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M")
DEST="$BACKUP_ROOT/$TIMESTAMP"
RETENTION_DAYS=30
LOG="$NANOCLAW_DIR/logs/backup.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"
}

# Check drive is mounted
if ! mountpoint -q /media/jorgenclaw/NanoClaw; then
  log "ERROR: USB drive not mounted at /media/jorgenclaw/NanoClaw — backup aborted"
  exit 1
fi

mkdir -p "$DEST"

log "Starting backup → $DEST"

# Copy critical directories (exclude node_modules and symlinks — exFAT doesn't support them)
for dir in store groups data; do
  if [ -d "$NANOCLAW_DIR/$dir" ]; then
    rsync -a --no-links --exclude='node_modules/' "$NANOCLAW_DIR/$dir/" "$DEST/$dir/"
    log "  Copied $dir/"
  fi
done

log "Backup complete"

# Prune backups older than 30 days
PRUNED=$(find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d -mtime +$RETENTION_DAYS)
if [ -n "$PRUNED" ]; then
  echo "$PRUNED" | xargs rm -rf
  log "Pruned old backups: $(echo "$PRUNED" | wc -l) removed"
fi

# Report disk usage
USED=$(df -h /media/jorgenclaw/NanoClaw | awk 'NR==2{print $3"/"$2" ("$5" used)"}')
log "Drive usage: $USED"
