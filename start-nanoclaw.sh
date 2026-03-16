#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill $(cat "$PROJECT_ROOT/nanoclaw.pid")

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

mkdir -p "$PROJECT_ROOT/logs"

# Stop existing instance if running
if [ -f "$PROJECT_ROOT/nanoclaw.pid" ]; then
  OLD_PID=$(cat "$PROJECT_ROOT/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup node "$PROJECT_ROOT/dist/index.js" \
  >> "$PROJECT_ROOT/logs/nanoclaw.log" \
  2>> "$PROJECT_ROOT/logs/nanoclaw.error.log" &

echo $! > "$PROJECT_ROOT/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f $PROJECT_ROOT/logs/nanoclaw.log"
