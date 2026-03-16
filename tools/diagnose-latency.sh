#!/bin/bash
# diagnose-latency.sh — Investigate message processing latency
# Usage: ./tools/diagnose-latency.sh [minutes-ago]
# Default: last 10 minutes

MINUTES=${1:-10}
LOG_FILE="logs/nanoclaw.log"
ERROR_LOG="logs/nanoclaw.error.log"

echo "=== NanoClaw Latency Diagnosis (last ${MINUTES}min) ==="
echo ""

# Service status
echo "--- Service Status ---"
systemctl --user status nanoclaw 2>/dev/null | head -5
echo ""

# Active containers
echo "--- Active Containers ---"
docker ps --filter "name=nanoclaw-" --format "{{.Names}}\t{{.Status}}\t{{.RunningFor}}" 2>/dev/null
CONTAINER=$(docker ps --filter "name=nanoclaw-" --format "{{.Names}}" 2>/dev/null | head -1)
echo ""

# Recent log events
echo "--- Recent Log Events ---"
if [ -f "$LOG_FILE" ]; then
  # Extract timestamps and event types
  echo "Messages received:"
  grep "New messages" "$LOG_FILE" | tail -5
  echo ""
  echo "Container spawns:"
  grep "Spawning container" "$LOG_FILE" | tail -5
  echo ""
  echo "Replies sent:"
  grep "message sent\|output:" "$LOG_FILE" | tail -5
  echo ""
  echo "Errors:"
  grep -i "error\|fail" "$LOG_FILE" | tail -5
fi
echo ""

# Container analysis
if [ -n "$CONTAINER" ]; then
  echo "--- Container: $CONTAINER ---"

  CREATED=$(docker inspect "$CONTAINER" --format '{{.Created}}' 2>/dev/null)
  echo "Created: $CREATED"

  MSG_COUNT=$(docker logs "$CONTAINER" 2>&1 | grep -c "\[msg #")
  echo "Internal messages: $MSG_COUNT"

  OUTPUT_COUNT=$(docker logs "$CONTAINER" 2>&1 | grep -c "OUTPUT_START")
  echo "Replies sent (OUTPUT_START): $OUTPUT_COUNT"

  RATE_LIMITS=$(docker logs "$CONTAINER" 2>&1 | grep -c "rate_limit")
  echo "Rate limit events: $RATE_LIMITS"

  TASKS=$(docker logs "$CONTAINER" 2>&1 | grep "task_started\|Task notification" | tail -5)
  if [ -n "$TASKS" ]; then
    echo ""
    echo "Tasks:"
    echo "$TASKS"
  fi

  echo ""
  echo "Last 5 messages:"
  docker logs "$CONTAINER" 2>&1 | grep "\[msg #" | tail -5
fi
echo ""

# Error log
if [ -f "$ERROR_LOG" ] && [ -s "$ERROR_LOG" ]; then
  echo "--- Error Log (last 10 lines) ---"
  tail -10 "$ERROR_LOG"
fi
