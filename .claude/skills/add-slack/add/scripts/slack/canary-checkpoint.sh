#!/bin/bash
# Canary checkpoint script — collects C1-C5 diagnostic data and outputs machine-readable JSON evidence
# Usage: ./scripts/slack/canary-checkpoint.sh [--dry-run]
#
# Exit codes:
#   0 = all criteria pass
#   1 = one or more criteria fail

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/nanoclaw.log"
ENV_FILE="$PROJECT_ROOT/.env"
EVIDENCE_DIR="$PROJECT_ROOT/.sisyphus/evidence"

mkdir -p "$EVIDENCE_DIR"

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TIMESTAMP_FILE=$(date -u +%Y%m%dT%H%M%SZ)
EVIDENCE_FILE="$EVIDENCE_DIR/r4-canary-${TIMESTAMP_FILE}.json"

# ─── Helpers ────────────────────────────────────────────────────────────────

pid_log_count() {
  local pid="$1"
  local pattern="$2"
  if [[ -f "$LOG_FILE" ]]; then
    # pino-pretty headline format is: [time] LEVEL (PID): message
    grep "($pid):" "$LOG_FILE" 2>/dev/null | (grep -E "$pattern" 2>/dev/null || true) | wc -l | tr -d ' '
  else
    echo 0
  fi
}

pid_log_sum_field() {
  local pid="$1"
  local entry_pattern="$2"
  local field_name="$3"
  if [[ -f "$LOG_FILE" ]]; then
    awk -v pid="$pid" -v entry_pattern="$entry_pattern" -v field_name="$field_name" '
      BEGIN {
        in_entry = 0;
        sum = 0;
        esc = sprintf("%c", 27)
      }
      {
        line = $0
        gsub(esc "\\[[0-9;]*m", "", line)

        if (line ~ "\\(" pid "\\):") {
          in_entry = (line ~ entry_pattern)
          next
        }

        if (in_entry && line ~ field_name ":[[:space:]]*[0-9]+") {
          sub(".*" field_name ":[[:space:]]*", "", line)
          if (match(line, /^[0-9]+/)) {
            sum += substr(line, RSTART, RLENGTH)
          }
          in_entry = 0
        }
      }
      END {
        print sum + 0
      }
    ' "$LOG_FILE"
  else
    echo 0
  fi
}

log_count_all() {
  local pattern="$1"
  if [[ -f "$LOG_FILE" ]]; then
    (grep -E "$pattern" "$LOG_FILE" 2>/dev/null || true) | wc -l | tr -d ' '
  else
    echo 0
  fi
}

# ─── Discover PID ───────────────────────────────────────────────────────────

PID=$(pgrep -f 'dist/index.js' | head -1 || true)
PID_SOURCE="process"

if [[ -z "$PID" ]] && [[ "$DRY_RUN" == "true" ]] && [[ -f "$LOG_FILE" ]]; then
  PID=$(awk '
    BEGIN {
      pid = ""
      esc = sprintf("%c", 27)
    }
    {
      line = $0
      gsub(esc "\\[[0-9;]*m", "", line)
      if (match(line, /\([0-9]+\):/)) {
        pid = substr(line, RSTART + 1, RLENGTH - 3)
      }
    }
    END {
      if (pid != "") {
        print pid
      }
    }
  ' "$LOG_FILE" 2>/dev/null || true)

  if [[ -n "$PID" ]]; then
    PID_SOURCE="dry_run_log"
  fi
fi

if [[ -z "$PID" ]]; then
  # Service not running — all criteria fail
  RESULT=$(cat <<EOF
{
  "timestamp": "$TIMESTAMP",
  "pid": null,
  "uptime_seconds": 0,
  "criteria": {
    "C1": { "name": "token_validity", "pass": false, "detail": "service not running" },
    "C2": { "name": "socket_reconnect_health", "pass": false, "detail": "service not running" },
    "C3": { "name": "rate_limit_recovery", "pass": false, "detail": "service not running" },
    "C4": { "name": "message_pipeline", "pass": false, "detail": "service not running" },
    "C5": { "name": "stable_runtime", "pass": false, "detail": "service not running" }
  },
  "verdict": "FAIL",
  "rollback_triggers": ["service_not_running"]
}
EOF
)
  echo "$RESULT"
  if [[ "$DRY_RUN" == "false" ]]; then
    echo "$RESULT" > "$EVIDENCE_FILE"
  fi
  exit 1
fi

# ─── Uptime ─────────────────────────────────────────────────────────────────

UPTIME_SECONDS=0
if command -v ps &>/dev/null; then
  # ps -o etimes gives elapsed time in seconds
  UPTIME_SECONDS=$(ps -o etimes= -p "$PID" 2>/dev/null | tr -d ' ' || echo 0)
  UPTIME_SECONDS=${UPTIME_SECONDS:-0}
fi

DRY_RUN_SAMPLE_DETAIL=""
if [[ "$DRY_RUN" == "true" ]]; then
  SAMPLE_SOCKET_RECONNECT_COUNT=$(pid_log_count "$PID" "Reconnected in|socket_reconnect")
  SAMPLE_NEW_MESSAGE_COUNT=$(pid_log_sum_field "$PID" "New messages" "count")
  SAMPLE_SOURCE="pid_filtered"

  if [[ "$SAMPLE_SOCKET_RECONNECT_COUNT" -eq 0 ]] && [[ "$SAMPLE_NEW_MESSAGE_COUNT" -eq 0 ]]; then
    SAMPLE_SOCKET_RECONNECT_COUNT=$(log_count_all "Reconnected in|socket_reconnect")
    SAMPLE_NEW_MESSAGE_COUNT=$(log_count_all "New messages")
    SAMPLE_SOURCE="global_fallback"
  fi

  if [[ "$SAMPLE_SOCKET_RECONNECT_COUNT" -eq 0 ]] && [[ "$SAMPLE_NEW_MESSAGE_COUNT" -eq 0 ]]; then
    SAMPLE_SOCKET_RECONNECT_COUNT=3
    SAMPLE_NEW_MESSAGE_COUNT=12
    SAMPLE_SOURCE="synthetic_fallback"
  fi

  DRY_RUN_SAMPLE_DETAIL="dry_run_samples: socket_reconnect_count=$SAMPLE_SOCKET_RECONNECT_COUNT, new_message_count=$SAMPLE_NEW_MESSAGE_COUNT, source=$SAMPLE_SOURCE, pid_source=$PID_SOURCE"
fi

# ─── C1: Token Validity ──────────────────────────────────────────────────────

C1_PASS=false
C1_DETAIL="no SLACK_BOT_TOKEN found"

if [[ -f "$ENV_FILE" ]]; then
  BOT_TOKEN=$(grep '^SLACK_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
fi

if [[ "$DRY_RUN" == "true" ]]; then
  C1_PASS=true
  C1_DETAIL="dry-run: skipping auth.test API call"
elif [[ -n "${BOT_TOKEN:-}" ]]; then
  AUTH_RESPONSE=$(curl -sf --max-time 10 \
    -H "Authorization: Bearer $BOT_TOKEN" \
    "https://slack.com/api/auth.test" 2>/dev/null || echo '{"ok":false,"error":"curl_failed"}')
  AUTH_OK=$(echo "$AUTH_RESPONSE" | grep -o '"ok":true' || true)
  if [[ -n "$AUTH_OK" ]]; then
    AUTH_TEAM=$(echo "$AUTH_RESPONSE" | grep -o '"team":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
    C1_PASS=true
    C1_DETAIL="auth.test succeeded, team: $AUTH_TEAM"
  else
    AUTH_ERROR=$(echo "$AUTH_RESPONSE" | grep -o '"error":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
    C1_PASS=false
    C1_DETAIL="auth.test failed: $AUTH_ERROR"
  fi
else
  C1_PASS=false
  C1_DETAIL="SLACK_BOT_TOKEN not set in .env"
fi

# ─── C2: Socket Reconnect Health ─────────────────────────────────────────────

STALE_COUNT=$(pid_log_count "$PID" "socket_stale")
RECONNECT_COUNT=$(pid_log_count "$PID" "socket_reconnect")
BREAKER_COUNT=$(pid_log_count "$PID" "breaker_open")

# Calculate reconnects/hour based on uptime
RECONNECTS_PER_HOUR=0
if [[ "$UPTIME_SECONDS" -gt 0 ]]; then
  RECONNECTS_PER_HOUR=$(echo "scale=2; $RECONNECT_COUNT * 3600 / $UPTIME_SECONDS" | bc 2>/dev/null | tr -d '\n' || echo 0)
fi

# Extract max recovery time from logs (socket_reconnect events have duration_ms field)
MAX_RECOVERY_MS=0
if [[ -f "$LOG_FILE" ]]; then
  MAX_RECOVERY_MS=$(grep "($PID):" "$LOG_FILE" 2>/dev/null | \
    (grep "socket_reconnect" 2>/dev/null || true) | \
    (grep -o '"duration_ms":[0-9]*' 2>/dev/null || true) | \
    cut -d: -f2 | \
    sort -n | tail -1)
  MAX_RECOVERY_MS=${MAX_RECOVERY_MS:-0}
fi

# C2 thresholds: reconnects/hour ≤ 2, max recovery < 30000ms, no breaker_open
C2_PASS=true
C2_FAIL_REASONS=()

# Use integer comparison for reconnects/hour (truncate decimal)
RECONNECTS_PER_HOUR_INT=$(echo "$RECONNECTS_PER_HOUR" | cut -d. -f1)
RECONNECTS_PER_HOUR_INT=${RECONNECTS_PER_HOUR_INT:-0}

if [[ "$RECONNECTS_PER_HOUR_INT" -gt 5 ]]; then
  C2_PASS=false
  C2_FAIL_REASONS+=("reconnects/hour: $RECONNECTS_PER_HOUR > 5 (rollback threshold)")
elif [[ "$RECONNECTS_PER_HOUR_INT" -gt 2 ]]; then
  C2_PASS=false
  C2_FAIL_REASONS+=("reconnects/hour: $RECONNECTS_PER_HOUR > 2 (pass threshold)")
fi

if [[ "$MAX_RECOVERY_MS" -gt 60000 ]]; then
  C2_PASS=false
  C2_FAIL_REASONS+=("max_recovery_ms: $MAX_RECOVERY_MS > 60000 (rollback threshold)")
elif [[ "$MAX_RECOVERY_MS" -gt 30000 ]]; then
  C2_PASS=false
  C2_FAIL_REASONS+=("max_recovery_ms: $MAX_RECOVERY_MS > 30000 (pass threshold)")
fi

if [[ "$BREAKER_COUNT" -gt 0 ]]; then
  C2_PASS=false
  C2_FAIL_REASONS+=("breaker_open: $BREAKER_COUNT events")
fi

if [[ "${#C2_FAIL_REASONS[@]}" -gt 0 ]]; then
  C2_DETAIL=$(IFS='; '; echo "${C2_FAIL_REASONS[*]}")
else
  C2_DETAIL="reconnects/hour: $RECONNECTS_PER_HOUR, max_recovery_ms: $MAX_RECOVERY_MS"
fi

if [[ -n "$DRY_RUN_SAMPLE_DETAIL" ]]; then
  C2_DETAIL="$C2_DETAIL; $DRY_RUN_SAMPLE_DETAIL"
fi

# ─── C3: Rate Limit Recovery ─────────────────────────────────────────────────

RATE_LIMIT_COUNT=$(pid_log_count "$PID" "slack_rate_limited|rate_limited|Slack rate limited")
SEND_FAILED_COUNT=$(pid_log_count "$PID" "send_failed_non_delivery|slack_send_failed|Message send failed, treating as non-delivery|Failed to send Slack message after retries")

if [[ "$RATE_LIMIT_COUNT" -eq 0 ]]; then
  C3_PASS=true
  C3_DETAIL="rate_limit_count: 0, send_failed_count: $SEND_FAILED_COUNT"
elif [[ "$SEND_FAILED_COUNT" -eq 0 ]]; then
  C3_PASS=true
  C3_DETAIL="rate_limit_count: $RATE_LIMIT_COUNT, send_failed_count: 0 (recovered)"
else
  C3_PASS=false
  C3_DETAIL="rate_limit_count: $RATE_LIMIT_COUNT, send_failed_count: $SEND_FAILED_COUNT (unrecovered rate-limit pattern)"
fi

# ─── C4: Message Pipeline ─────────────────────────────────────────────────────

# Check service is running and Slack is connected
SLACK_CONNECTED=false
SLACK_CONNECTED_COUNT=0
MESSAGE_COUNT=$(pid_log_sum_field "$PID" "Processing messages" "messageCount")
DUPLICATE_COUNT=$(pid_log_count "$PID" "duplicate_message|duplicate_event|duplicate_delivery|duplicate_response")
if [[ -f "$LOG_FILE" ]]; then
  SLACK_CONNECTED_COUNT=$(grep "($PID):" "$LOG_FILE" 2>/dev/null | \
    (grep -E "Slack bot connected|slack.*connected|SlackChannel.*connected" 2>/dev/null || true) | wc -l | tr -d ' ')
  if [[ "$SLACK_CONNECTED_COUNT" -gt 0 ]]; then
    SLACK_CONNECTED=true
  fi
fi

# Also check systemd service is active
SERVICE_ACTIVE=false
if command -v systemctl &>/dev/null; then
  if systemctl --user is-active nanoclaw &>/dev/null; then
    SERVICE_ACTIVE=true
  fi
fi

# Check process is alive
PROCESS_ALIVE=false
if kill -0 "$PID" 2>/dev/null; then
  PROCESS_ALIVE=true
fi

C4_PASS=true
C4_FAIL_REASONS=()

if [[ "$PROCESS_ALIVE" != "true" ]]; then
  C4_PASS=false
  C4_FAIL_REASONS+=("process_not_alive (pid: $PID)")
fi

if [[ "$SLACK_CONNECTED" != "true" ]]; then
  C4_PASS=false
  C4_FAIL_REASONS+=("no_slack_connect_event_for_pid")
fi

if [[ "$MESSAGE_COUNT" -lt 50 ]]; then
  C4_PASS=false
  C4_FAIL_REASONS+=("message_count: $MESSAGE_COUNT < 50")
fi

if [[ "$DUPLICATE_COUNT" -gt 0 ]]; then
  C4_PASS=false
  C4_FAIL_REASONS+=("duplicate_count: $DUPLICATE_COUNT > 0")
fi

if [[ "${#C4_FAIL_REASONS[@]}" -gt 0 ]]; then
  C4_DETAIL=$(IFS='; '; echo "${C4_FAIL_REASONS[*]}")
  C4_DETAIL="$C4_DETAIL; slack_connected_events: $SLACK_CONNECTED_COUNT; message_count: $MESSAGE_COUNT; duplicate_count: $DUPLICATE_COUNT"
else
  C4_DETAIL="slack_connected_events: $SLACK_CONNECTED_COUNT, message_count: $MESSAGE_COUNT, duplicate_count: $DUPLICATE_COUNT, pid: $PID"
fi

if [[ -n "$DRY_RUN_SAMPLE_DETAIL" ]]; then
  C4_DETAIL="$C4_DETAIL; $DRY_RUN_SAMPLE_DETAIL"
fi

# ─── C5: Stable Runtime ──────────────────────────────────────────────────────

# Check systemd restart count
RESTART_COUNT=0
if command -v systemctl &>/dev/null; then
  RESTART_COUNT=$(systemctl --user show nanoclaw --property=NRestarts 2>/dev/null | \
    cut -d= -f2 || echo 0)
  RESTART_COUNT=${RESTART_COUNT:-0}
fi

C5_PASS=true
C5_FAIL_REASONS=()

if [[ "$BREAKER_COUNT" -gt 0 ]]; then
  C5_PASS=false
  C5_FAIL_REASONS+=("breaker_open: $BREAKER_COUNT events")
fi

if [[ "$RESTART_COUNT" -gt 0 ]]; then
  C5_PASS=false
  C5_FAIL_REASONS+=("systemd_restarts: $RESTART_COUNT")
fi

if [[ "$PROCESS_ALIVE" == "false" ]]; then
  C5_PASS=false
  C5_FAIL_REASONS+=("process_not_alive")
fi

if [[ "${#C5_FAIL_REASONS[@]}" -gt 0 ]]; then
  C5_DETAIL=$(IFS='; '; echo "${C5_FAIL_REASONS[*]}")
else
  C5_DETAIL="uptime: ${UPTIME_SECONDS}s, breaker_open: $BREAKER_COUNT, restarts: $RESTART_COUNT"
fi

# ─── Verdict ─────────────────────────────────────────────────────────────────

ROLLBACK_TRIGGERS=()

[[ "$C1_PASS" == "false" ]] && ROLLBACK_TRIGGERS+=("C1_token_validity")
[[ "$C2_PASS" == "false" ]] && ROLLBACK_TRIGGERS+=("C2_socket_reconnect_health")
[[ "$C3_PASS" == "false" ]] && ROLLBACK_TRIGGERS+=("C3_rate_limit_recovery")
[[ "$C4_PASS" == "false" ]] && ROLLBACK_TRIGGERS+=("C4_message_pipeline")
[[ "$C5_PASS" == "false" ]] && ROLLBACK_TRIGGERS+=("C5_stable_runtime")

if [[ "${#ROLLBACK_TRIGGERS[@]}" -eq 0 ]]; then
  VERDICT="PASS"
  EXIT_CODE=0
else
  VERDICT="FAIL"
  EXIT_CODE=1
fi

# Build rollback_triggers JSON array
ROLLBACK_JSON="[]"
if [[ "${#ROLLBACK_TRIGGERS[@]}" -gt 0 ]]; then
  ROLLBACK_JSON="[$(printf '"%s",' "${ROLLBACK_TRIGGERS[@]}" | sed 's/,$//')]"
fi

# ─── Output JSON ─────────────────────────────────────────────────────────────

RESULT=$(cat <<EOF
{
  "timestamp": "$TIMESTAMP",
  "pid": $PID,
  "uptime_seconds": $UPTIME_SECONDS,
  "criteria": {
    "C1": { "name": "token_validity", "pass": $C1_PASS, "detail": "$C1_DETAIL" },
    "C2": { "name": "socket_reconnect_health", "pass": $C2_PASS, "detail": "$C2_DETAIL" },
    "C3": { "name": "rate_limit_recovery", "pass": $C3_PASS, "detail": "$C3_DETAIL" },
    "C4": { "name": "message_pipeline", "pass": $C4_PASS, "detail": "$C4_DETAIL" },
    "C5": { "name": "stable_runtime", "pass": $C5_PASS, "detail": "$C5_DETAIL" }
  },
  "verdict": "$VERDICT",
  "rollback_triggers": $ROLLBACK_JSON
}
EOF
)

echo "$RESULT"

if [[ "$DRY_RUN" == "false" ]]; then
  echo "$RESULT" > "$EVIDENCE_FILE"
  echo "" >&2
  echo "Evidence written to: $EVIDENCE_FILE" >&2
fi

exit $EXIT_CODE
