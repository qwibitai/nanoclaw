#!/bin/bash
# Soak monitoring script — captures health metrics at regular intervals
# Usage: ./scripts/slack/soak-monitor.sh [interval_minutes] [total_minutes]

INTERVAL=${1:-15}
TOTAL=${2:-120}
EVIDENCE_FILE=".sisyphus/evidence/r4-soak.txt"
START_TIME=$(date +%s)
PREV_PID=""

echo "=== Phase B: Low-Traffic 2h Soak ===" > "$EVIDENCE_FILE"
echo "Start: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$EVIDENCE_FILE"
echo "Interval: ${INTERVAL}m, Total: ${TOTAL}m" >> "$EVIDENCE_FILE"
echo "" >> "$EVIDENCE_FILE"

CHECKPOINT=0
while true; do
  ELAPSED=$(( ($(date +%s) - START_TIME) / 60 ))
  if [ "$ELAPSED" -ge "$TOTAL" ]; then
    break
  fi
  
  CHECKPOINT=$((CHECKPOINT + 1))
  # Re-discover PID each checkpoint to survive restarts
  PID=$(pgrep -f 'dist/index.js' | head -1)

  echo "--- Checkpoint $CHECKPOINT (T+${ELAPSED}m) $(date -u +%Y-%m-%dT%H:%M:%SZ) ---" >> "$EVIDENCE_FILE"
  
  # Check if process is still running
  if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
    echo "FAIL: Process is no longer running!" >> "$EVIDENCE_FILE"
    echo "SOAK RESULT: FAIL — process died" >> "$EVIDENCE_FILE"
    exit 1
  fi
  
  # Count reconnect events
  STALE=$(grep "$PID" logs/nanoclaw.log 2>/dev/null | grep -c "socket_stale"; true)
  RECONNECT=$(grep "$PID" logs/nanoclaw.log 2>/dev/null | grep -c "socket_reconnect"; true)
  BREAKER=$(grep "$PID" logs/nanoclaw.log 2>/dev/null | grep -c "breaker_open"; true)
  RATE_LIMIT=$(grep "$PID" logs/nanoclaw.log 2>/dev/null | grep -c "rate_limited"; true)
  
  echo "  PID: $PID" >> "$EVIDENCE_FILE"

  # Detect PID change (service restarted)
  if [ -n "$PREV_PID" ] && [ "$PID" != "$PREV_PID" ]; then
    echo "  PID changed: $PREV_PID -> $PID" >> "$EVIDENCE_FILE"
  fi
  PREV_PID="$PID"

  echo "  Process: running" >> "$EVIDENCE_FILE"
  echo "  socket_stale events: $STALE" >> "$EVIDENCE_FILE"
  echo "  socket_reconnect events: $RECONNECT" >> "$EVIDENCE_FILE"
  echo "  breaker_open events: $BREAKER" >> "$EVIDENCE_FILE"
  echo "  rate_limited events: $RATE_LIMIT" >> "$EVIDENCE_FILE"
  
  # Calculate reconnects per hour — pure bash integer arithmetic (no bc dependency)
  if [ "$ELAPSED" -gt 0 ]; then
    RECONNECTS_PER_HOUR=$(( RECONNECT * 60 / ELAPSED ))
    echo "  reconnects/hour: $RECONNECTS_PER_HOUR" >> "$EVIDENCE_FILE"
  fi
  
  # Check thresholds
  if [ "$BREAKER" -gt 0 ]; then
    echo "  THRESHOLD BREACH: breaker_open > 0" >> "$EVIDENCE_FILE"
  fi
  
  echo "" >> "$EVIDENCE_FILE"
  sleep $((INTERVAL * 60))
done

echo "=== Soak Complete ===" >> "$EVIDENCE_FILE"
echo "End: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$EVIDENCE_FILE"
echo "Duration: ${TOTAL}m" >> "$EVIDENCE_FILE"

# Final counts
STALE=$(grep "$PID" logs/nanoclaw.log 2>/dev/null | grep -c "socket_stale"; true)
RECONNECT=$(grep "$PID" logs/nanoclaw.log 2>/dev/null | grep -c "socket_reconnect"; true)
BREAKER=$(grep "$PID" logs/nanoclaw.log 2>/dev/null | grep -c "breaker_open"; true)

echo "Final socket_stale: $STALE" >> "$EVIDENCE_FILE"
echo "Final socket_reconnect: $RECONNECT" >> "$EVIDENCE_FILE"
echo "Final breaker_open: $BREAKER" >> "$EVIDENCE_FILE"

if [ "$BREAKER" -eq 0 ] && [ "$RECONNECT" -le 4 ]; then
  echo "SOAK RESULT: PASS" >> "$EVIDENCE_FILE"
else
  echo "SOAK RESULT: FAIL" >> "$EVIDENCE_FILE"
fi
