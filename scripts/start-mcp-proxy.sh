#!/bin/bash
# Start MS Graph MCP server behind mcp-proxy for container access.
# Containers reach it via http://host.docker.internal:8080/mcp
#
# Usage: ./scripts/start-mcp-proxy.sh
# Stop:  kill $(cat mcp-proxy.pid)

set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${MCP_PROXY_PORT:-8080}"
PID_FILE="mcp-proxy.pid"
LOG_FILE="logs/mcp-proxy.log"

mkdir -p logs

# Stop existing instance
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing mcp-proxy (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

echo "Starting mcp-proxy on port $PORT..."
nohup mcp-proxy --port "$PORT" -- npx -y @softeria/ms-365-mcp-server \
  >> "$LOG_FILE" 2>&1 &

echo $! > "$PID_FILE"
echo "mcp-proxy started (PID $!) on port $PORT"
echo "Logs: tail -f $LOG_FILE"

# Health check
sleep 3
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "✓ mcp-proxy is running"
else
  echo "✗ mcp-proxy failed to start — check $LOG_FILE"
  exit 1
fi
