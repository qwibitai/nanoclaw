#!/bin/bash
# backup.sh — Create portable NanoClaw backup archive
# Works on both local (macOS/Linux) and VPS deployments.
# Usage: bash backup.sh [output-dir]
# Creates: nanoclaw-backup-YYYY-MM-DD-HHMMSS.tar.gz

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${1:-$PROJECT_ROOT}"
TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
BACKUP_NAME="nanoclaw-backup-${TIMESTAMP}"
TEMP_DIR=$(mktemp -d)

echo "============================================"
echo "  NanoClaw Backup"
echo "============================================"
echo ""
echo "  Project:  ${PROJECT_ROOT}"
echo "  Output:   ${OUTPUT_DIR}/${BACKUP_NAME}.tar.gz"
echo ""

mkdir -p "$TEMP_DIR/$BACKUP_NAME"

# 1. Database (message history, sessions, tasks, registered groups)
if [ -f "$PROJECT_ROOT/store/messages.db" ]; then
  cp "$PROJECT_ROOT/store/messages.db" "$TEMP_DIR/$BACKUP_NAME/"
  echo "  [1/6] Database ✓ ($(du -h "$PROJECT_ROOT/store/messages.db" | cut -f1))"
else
  echo "  [1/6] Database — not found (fresh install)"
fi

# 2. Environment (secrets, API keys, tokens)
if [ -f "$PROJECT_ROOT/.env" ]; then
  cp "$PROJECT_ROOT/.env" "$TEMP_DIR/$BACKUP_NAME/"
  echo "  [2/6] Environment (.env) ✓"
else
  echo "  [2/6] Environment — not found"
fi

# 3. Groups (per-group agent memory, CLAUDE.md, group.json)
if [ -d "$PROJECT_ROOT/groups" ]; then
  cp -r "$PROJECT_ROOT/groups" "$TEMP_DIR/$BACKUP_NAME/"
  GROUP_COUNT=$(find "$PROJECT_ROOT/groups" -maxdepth 1 -mindepth 1 -type d | wc -l)
  echo "  [3/6] Groups ✓ (${GROUP_COUNT} groups)"
else
  echo "  [3/6] Groups — not found"
fi

# 4. Session data (Claude Agent SDK state, IPC queues, per-group agent-runner)
if [ -d "$PROJECT_ROOT/data" ]; then
  cp -r "$PROJECT_ROOT/data" "$TEMP_DIR/$BACKUP_NAME/"
  echo "  [4/6] Session data ✓ ($(du -sh "$PROJECT_ROOT/data" | cut -f1))"
else
  echo "  [4/6] Session data — not found (no agents have run yet)"
fi

# 5. Allowlists (stored outside project root for security)
HOME_DIR="${HOME:-$(eval echo ~)}"
mkdir -p "$TEMP_DIR/$BACKUP_NAME/config"
ALLOWLIST_COUNT=0
if [ -f "$HOME_DIR/.config/nanoclaw/mount-allowlist.json" ]; then
  cp "$HOME_DIR/.config/nanoclaw/mount-allowlist.json" "$TEMP_DIR/$BACKUP_NAME/config/"
  ALLOWLIST_COUNT=$((ALLOWLIST_COUNT + 1))
fi
if [ -f "$HOME_DIR/.config/nanoclaw/sender-allowlist.json" ]; then
  cp "$HOME_DIR/.config/nanoclaw/sender-allowlist.json" "$TEMP_DIR/$BACKUP_NAME/config/"
  ALLOWLIST_COUNT=$((ALLOWLIST_COUNT + 1))
fi
echo "  [5/6] Allowlists ✓ (${ALLOWLIST_COUNT} files)"

# 6. Logs (optional, for debugging migration issues)
if [ -d "$PROJECT_ROOT/logs" ]; then
  cp -r "$PROJECT_ROOT/logs" "$TEMP_DIR/$BACKUP_NAME/"
  echo "  [6/6] Logs ✓"
else
  echo "  [6/6] Logs — not found"
fi

# Create archive
echo ""
tar -czf "$OUTPUT_DIR/$BACKUP_NAME.tar.gz" -C "$TEMP_DIR" "$BACKUP_NAME"
rm -rf "$TEMP_DIR"

ARCHIVE_SIZE=$(du -h "$OUTPUT_DIR/$BACKUP_NAME.tar.gz" | cut -f1)
echo "============================================"
echo "  Backup complete: ${ARCHIVE_SIZE}"
echo "  ${OUTPUT_DIR}/${BACKUP_NAME}.tar.gz"
echo "============================================"
echo ""
echo "  To restore on another machine:"
echo "    scp ${BACKUP_NAME}.tar.gz user@host:/opt/gentech/"
echo "    bash restore.sh ${BACKUP_NAME}.tar.gz"
echo ""
