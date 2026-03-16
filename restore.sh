#!/bin/bash
# restore.sh — Restore NanoClaw backup archive
# Works on both local (macOS/Linux) and VPS deployments.
# Usage: bash restore.sh <backup-file> [deploy-path]

set -euo pipefail

BACKUP_FILE="${1:-}"
DEPLOY_PATH="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: bash restore.sh <backup-file.tar.gz> [deploy-path]"
  echo ""
  echo "  backup-file:  Path to nanoclaw-backup-*.tar.gz"
  echo "  deploy-path:  Where to restore (default: current directory)"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: $BACKUP_FILE"
  exit 1
fi

echo "============================================"
echo "  NanoClaw Restore"
echo "============================================"
echo ""
echo "  Backup:  ${BACKUP_FILE}"
echo "  Target:  ${DEPLOY_PATH}"
echo ""

# Stop service if running (safe — ignores errors if not running)
echo "  Stopping service..."
systemctl stop nanoclaw 2>/dev/null || \
  systemctl --user stop nanoclaw 2>/dev/null || \
  true

# Extract archive
TEMP_DIR=$(mktemp -d)
tar -xzf "$BACKUP_FILE" -C "$TEMP_DIR"
BACKUP_DIR=$(ls "$TEMP_DIR")

# Restore database
if [ -f "$TEMP_DIR/$BACKUP_DIR/messages.db" ]; then
  mkdir -p "$DEPLOY_PATH/store"
  cp "$TEMP_DIR/$BACKUP_DIR/messages.db" "$DEPLOY_PATH/store/"
  echo "  [1/6] Database ✓"
else
  echo "  [1/6] Database — not in backup"
fi

# Restore environment
if [ -f "$TEMP_DIR/$BACKUP_DIR/.env" ]; then
  if [ -f "$DEPLOY_PATH/.env" ]; then
    # Backup existing .env before overwriting
    cp "$DEPLOY_PATH/.env" "$DEPLOY_PATH/.env.pre-restore"
    echo "  [2/6] Environment ✓ (existing .env backed up to .env.pre-restore)"
  else
    echo "  [2/6] Environment ✓"
  fi
  cp "$TEMP_DIR/$BACKUP_DIR/.env" "$DEPLOY_PATH/"
else
  echo "  [2/6] Environment — not in backup"
fi

# Restore groups
if [ -d "$TEMP_DIR/$BACKUP_DIR/groups" ]; then
  cp -r "$TEMP_DIR/$BACKUP_DIR/groups" "$DEPLOY_PATH/"
  echo "  [3/6] Groups ✓"
else
  echo "  [3/6] Groups — not in backup"
fi

# Restore session data
if [ -d "$TEMP_DIR/$BACKUP_DIR/data" ]; then
  cp -r "$TEMP_DIR/$BACKUP_DIR/data" "$DEPLOY_PATH/"
  echo "  [4/6] Session data ✓"
else
  echo "  [4/6] Session data — not in backup"
fi

# Restore allowlists
HOME_DIR="${HOME:-$(eval echo ~)}"
mkdir -p "$HOME_DIR/.config/nanoclaw"
ALLOWLIST_COUNT=0
if [ -f "$TEMP_DIR/$BACKUP_DIR/config/mount-allowlist.json" ]; then
  cp "$TEMP_DIR/$BACKUP_DIR/config/mount-allowlist.json" "$HOME_DIR/.config/nanoclaw/"
  ALLOWLIST_COUNT=$((ALLOWLIST_COUNT + 1))
fi
if [ -f "$TEMP_DIR/$BACKUP_DIR/config/sender-allowlist.json" ]; then
  cp "$TEMP_DIR/$BACKUP_DIR/config/sender-allowlist.json" "$HOME_DIR/.config/nanoclaw/"
  ALLOWLIST_COUNT=$((ALLOWLIST_COUNT + 1))
fi
echo "  [5/6] Allowlists ✓ (${ALLOWLIST_COUNT} files)"

# Restore logs
if [ -d "$TEMP_DIR/$BACKUP_DIR/logs" ]; then
  mkdir -p "$DEPLOY_PATH/logs"
  cp -r "$TEMP_DIR/$BACKUP_DIR/logs/"* "$DEPLOY_PATH/logs/" 2>/dev/null || true
  echo "  [6/6] Logs ✓"
else
  echo "  [6/6] Logs — not in backup"
fi

rm -rf "$TEMP_DIR"

echo ""
echo "============================================"
echo "  Restore complete!"
echo "============================================"
echo ""
echo "  Next steps:"
echo "    1. Review .env and update any VPS-specific settings"
echo "    2. Run: bash deploy.sh    (on VPS)"
echo "       Or:  npm run build && npm start   (local)"
echo ""
echo "  If switching from subscription to API key (or vice versa):"
echo "    Edit .env and set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN"
echo "    Both can be set for automatic fallback"
echo ""
