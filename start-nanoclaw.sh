#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /Users/gavriel/nanoclaw-sandbox-workspace/nanoclaw.pid)

set -euo pipefail

cd "/Users/gavriel/nanoclaw-sandbox-workspace"

# Stop existing instance if running
if [ -f "/Users/gavriel/nanoclaw-sandbox-workspace/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/Users/gavriel/nanoclaw-sandbox-workspace/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/usr/bin/node" "/Users/gavriel/nanoclaw-sandbox-workspace/dist/index.js" \
  >> "/Users/gavriel/nanoclaw-sandbox-workspace/logs/nanoclaw.log" \
  2>> "/Users/gavriel/nanoclaw-sandbox-workspace/logs/nanoclaw.error.log" &

echo $! > "/Users/gavriel/nanoclaw-sandbox-workspace/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /Users/gavriel/nanoclaw-sandbox-workspace/logs/nanoclaw.log"
