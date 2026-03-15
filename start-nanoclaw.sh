#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /home/user/GenTech_Agency/nanoclaw.pid)

set -euo pipefail

cd "/home/user/GenTech_Agency"

# Stop existing instance if running
if [ -f "/home/user/GenTech_Agency/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/home/user/GenTech_Agency/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/opt/node22/bin/node" "/home/user/GenTech_Agency/dist/index.js" \
  >> "/home/user/GenTech_Agency/logs/nanoclaw.log" \
  2>> "/home/user/GenTech_Agency/logs/nanoclaw.error.log" &

echo $! > "/home/user/GenTech_Agency/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /home/user/GenTech_Agency/logs/nanoclaw.log"
