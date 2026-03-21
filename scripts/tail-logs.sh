#!/usr/bin/env bash
# Tail NanoClaw logs — main process + latest container log
set -euo pipefail

NANOCLAW_DIR="${NANOCLAW_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
MAIN_LOG="$NANOCLAW_DIR/logs/nanoclaw.log"

echo "=== NanoClaw Log Locations ==="
echo "Main log:      $MAIN_LOG"
echo "Error log:     $NANOCLAW_DIR/logs/nanoclaw.error.log"
echo "Container logs: $NANOCLAW_DIR/groups/*/logs/"
echo "IPC audit:      $NANOCLAW_DIR/data/ipc/*/audit/"
echo ""

# Find the latest container log
LATEST_CONTAINER_LOG=$(find "$NANOCLAW_DIR/groups" -name "container-*.log" -type f 2>/dev/null | sort | tail -1)

if [ -n "$LATEST_CONTAINER_LOG" ]; then
  echo "Latest container log: $LATEST_CONTAINER_LOG"
  echo ""
  echo "Tailing main log + latest container log (Ctrl+C to stop)..."
  tail -f "$MAIN_LOG" "$LATEST_CONTAINER_LOG"
else
  echo "No container logs found yet."
  echo ""
  echo "Tailing main log (Ctrl+C to stop)..."
  tail -f "$MAIN_LOG"
fi
