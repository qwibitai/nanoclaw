#!/bin/bash
# telegram-e2e.sh — End-to-end verification via DB injection.
#
# Bots can't see their own messages via getUpdates, so we inject a test
# message directly into NanoClaw's SQLite database. The poll loop picks it
# up every 2 seconds, spawns a container, and sends the response to Telegram.
#
# We verify the full round-trip by watching the log for all four markers,
# then kill the container to leave a clean state.

E2E_TIMEOUT=120   # seconds to wait for full round-trip
E2E_POLL_INTERVAL=3  # seconds between log checks

# All four markers are required for a full E2E pass
MARKER_PROCESSING="Processing messages"
MARKER_CONTAINER="Spawning container agent"
MARKER_OUTPUT="Agent output:"
MARKER_SENT="Telegram message sent"

# ── Strip ANSI escape codes ──────────────────────────────────────────────────

strip_ansi() {
  sed 's/\x1b\[[0-9;]*m//g'
}

# ── Kill any running nanoclaw containers ─────────────────────────────────────
#
# Ensures a fresh container spawn so all four markers appear.

kill_nanoclaw_containers() {
  local containers
  containers=$(docker ps -q --filter name=nanoclaw- 2>/dev/null)
  if [ -n "$containers" ]; then
    log_info "Killing running nanoclaw containers..."
    docker kill $containers >/dev/null 2>&1 || true
    sleep 2
    log_ok "Containers killed"
  fi
}

# ── Inject test message into SQLite ──────────────────────────────────────────

inject_test_message() {
  local db_path="${CLONE_DIR}/store/messages.db"
  local ts
  ts=$(date +%s)
  local iso_ts
  iso_ts=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  local msg_id="e2e-${ts}"
  local prompt="Say exactly \"E2E_OK_${ts}\" and nothing else. Do not add any explanation."

  if [ ! -f "$db_path" ]; then
    log_error "Database not found: $db_path"
    return 1
  fi

  log_info "Injecting test message into DB (id=${msg_id})..."

  sqlite3 "$db_path" "INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES ('${msg_id}', '${TELEGRAM_TEST_CHAT_ID}', 'e2e-tester', 'E2E Test', '${prompt}', '${iso_ts}', 0, 0);"

  if [ $? -ne 0 ]; then
    log_error "Failed to inject message into database"
    return 1
  fi

  log_ok "Test message injected (chat=${TELEGRAM_TEST_CHAT_ID})"
  return 0
}

# ── Get new log lines since baseline ─────────────────────────────────────────
#
# Reads from the service's log file (StandardOutput=append:...nanoclaw.log).
# Falls back to journalctl --user if the log file has no new content.
# $1 = baseline line count to skip

get_new_logs() {
  local baseline="$1"
  local log_file="${CLONE_DIR}/logs/nanoclaw.log"

  # Primary: read the log file (systemd StandardOutput=append)
  if [ -f "$log_file" ]; then
    local lines
    lines=$(tail -n +"$((baseline + 1))" "$log_file" 2>/dev/null | strip_ansi)
    if [ -n "$lines" ]; then
      echo "$lines"
      return 0
    fi
  fi

  # Fallback: journalctl (for services that log to journal instead)
  local since="${E2E_JOURNAL_SINCE:-}"
  if [ -n "$since" ]; then
    if [ "$(id -u)" -eq 0 ] && [ -n "${TEST_USER:-}" ]; then
      run_as_user "journalctl --user -u nanoclaw --since '${since}' --no-pager -o cat 2>/dev/null" | strip_ansi
    else
      journalctl --user -u nanoclaw --since "$since" --no-pager -o cat 2>/dev/null | strip_ansi
    fi
  fi
}

# ── Poll logs for complete round-trip evidence ───────────────────────────────
#
# Watches service logs for four markers proving the full E2E path:
#   1. Processing messages    — poll loop picked up the injected message
#   2. Spawning container agent — fresh container was launched
#   3. Agent output:          — agent generated a response
#   4. Telegram message sent  — response delivered to Telegram API

wait_for_round_trip() {
  local log_file="${CLONE_DIR}/logs/nanoclaw.log"
  local start
  start=$(timer_start)

  # Baseline: only check log lines added after this point
  local baseline=0
  if [ -f "$log_file" ]; then
    baseline=$(wc -l < "$log_file")
  fi

  # Also capture timestamp for journalctl fallback
  export E2E_JOURNAL_SINCE
  E2E_JOURNAL_SINCE=$(date -u +"%Y-%m-%d %H:%M:%S" --date="2 seconds ago")

  log_info "Waiting up to ${E2E_TIMEOUT}s for round-trip..."
  log_info "  Log: $log_file (baseline: line ${baseline})"

  local found_processing=false
  local found_container=false
  local found_output=false
  local found_sent=false

  while true; do
    local elapsed
    elapsed=$(timer_elapsed "$start")

    if [ "$elapsed" -ge "$E2E_TIMEOUT" ]; then
      log_error "Timeout after ${E2E_TIMEOUT}s"
      if [ "$found_sent" = true ]; then
        log_error "All stages passed but pass condition not met (bug)"
      elif [ "$found_output" = true ]; then
        log_error "Agent responded but Telegram delivery not confirmed"
      elif [ "$found_container" = true ]; then
        log_error "Container spawned but no agent output"
      elif [ "$found_processing" = true ]; then
        log_error "Message picked up but container not spawned"
      else
        log_error "No activity detected in logs"
      fi

      log_error "Recent log lines:"
      get_new_logs "$baseline" | tail -20 | while IFS= read -r line; do
        log_error "  $line"
      done
      return 1
    fi

    local new_lines
    new_lines=$(get_new_logs "$baseline")

    if [ -n "$new_lines" ]; then
      if [ "$found_processing" = false ] && echo "$new_lines" | grep -q "$MARKER_PROCESSING"; then
        found_processing=true
        log_ok "  [${elapsed}s] Poll loop picked up message"
      fi

      if [ "$found_container" = false ] && echo "$new_lines" | grep -q "$MARKER_CONTAINER"; then
        found_container=true
        log_ok "  [${elapsed}s] Container spawned"
      fi

      if [ "$found_output" = false ] && echo "$new_lines" | grep -q "$MARKER_OUTPUT"; then
        found_output=true
        log_ok "  [${elapsed}s] Agent produced output"
      fi

      if [ "$found_sent" = false ] && echo "$new_lines" | grep -q "$MARKER_SENT"; then
        found_sent=true
        log_ok "  [${elapsed}s] Response sent to Telegram"
      fi

      # All four markers = full E2E pass
      if [ "$found_processing" = true ] && [ "$found_container" = true ] && \
         [ "$found_output" = true ] && [ "$found_sent" = true ]; then
        return 0
      fi
    fi

    sleep "$E2E_POLL_INTERVAL"
    local remaining=$((E2E_TIMEOUT - elapsed))
    log_info "  ...waiting (${remaining}s remaining)"
  done
}

# ── Full E2E check ────────────────────────────────────────────────────────────

run_telegram_e2e() {
  # Kill existing containers so we get a fresh spawn with all four markers
  kill_nanoclaw_containers

  if ! inject_test_message; then
    return 1
  fi

  if ! wait_for_round_trip; then
    return 1
  fi

  # Clean up: kill the container spawned by the test
  kill_nanoclaw_containers

  log_ok "E2E verification passed: full message round-trip confirmed"
  return 0
}
