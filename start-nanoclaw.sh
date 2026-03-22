#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /home/evan/workspace/github.com/evanli18/nanoclaw/nanoclaw.pid)

set -euo pipefail

cd "/home/evan/workspace/github.com/evanli18/nanoclaw"

# Stop existing instance if running
if [ -f "/home/evan/workspace/github.com/evanli18/nanoclaw/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/home/evan/workspace/github.com/evanli18/nanoclaw/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/home/evan/.nvm/versions/node/v22.22.1/bin/node" "/home/evan/workspace/github.com/evanli18/nanoclaw/dist/index.js" \
  >> "/home/evan/workspace/github.com/evanli18/nanoclaw/logs/nanoclaw.log" \
  2>> "/home/evan/workspace/github.com/evanli18/nanoclaw/logs/nanoclaw.error.log" &

echo $! > "/home/evan/workspace/github.com/evanli18/nanoclaw/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /home/evan/workspace/github.com/evanli18/nanoclaw/logs/nanoclaw.log"
