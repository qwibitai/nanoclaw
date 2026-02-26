#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-$ROOT_DIR/store/messages.db}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
STALE_QUEUED_MS="${STALE_QUEUED_MS:-600000}"

pass_count=0
warn_count=0
fail_count=0

TMP_OUT="$(mktemp /tmp/jarvis-preflight.XXXXXX)"
trap 'rm -f "$TMP_OUT"' EXIT

pass() {
  echo "[PASS] $1"
  pass_count=$((pass_count + 1))
}

warn() {
  echo "[WARN] $1"
  warn_count=$((warn_count + 1))
}

fail() {
  echo "[FAIL] $1"
  fail_count=$((fail_count + 1))
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

run_check() {
  local label="$1"
  shift
  if "$@" >"$TMP_OUT" 2>&1; then
    pass "$label"
    return
  fi
  local err
  err="$(tr '\n' ' ' <"$TMP_OUT" | sed 's/[[:space:]]\+/ /g')"
  fail "$label ($err)"
}

echo "== Jarvis Preflight =="
echo "repo: $ROOT_DIR"

if have_cmd container; then
  run_check "container system status" container system status
  run_check "container builder status" container builder status
else
  fail "container CLI not found"
fi

if have_cmd launchctl; then
  service_line="$( (launchctl list || true) | awk '$3=="com.nanoclaw"{print $1" "$2" "$3}' )"
  if [ -z "$service_line" ]; then
    fail "launchd service com.nanoclaw not registered"
  else
    service_pid="$(awk '{print $1}' <<<"$service_line")"
    service_status="$(awk '{print $2}' <<<"$service_line")"
    if [[ "$service_pid" =~ ^[0-9]+$ ]] && [ "$service_pid" -gt 0 ]; then
      pass "launchd service com.nanoclaw running (pid=$service_pid)"
    else
      fail "launchd service com.nanoclaw not running (pid=$service_pid status=$service_status)"
    fi
  fi
else
  warn "launchctl not available; skipping service check"
fi

if [ -f "$ENV_FILE" ]; then
  has_oauth=0
  has_api=0
  if grep -Eq '^[[:space:]]*CLAUDE_CODE_OAUTH_TOKEN=.+' "$ENV_FILE"; then
    has_oauth=1
  fi
  if grep -Eq '^[[:space:]]*ANTHROPIC_API_KEY=.+' "$ENV_FILE"; then
    has_api=1
  fi

  if [ "$has_oauth" -eq 1 ] || [ "$has_api" -eq 1 ]; then
    pass ".env contains auth token(s)"
  else
    fail ".env missing CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY"
  fi

  if grep -Eq '^[[:space:]]*OAUTH_API_FALLBACK_ENABLED=(true|TRUE|1)$' "$ENV_FILE"; then
    if grep -Eq '^[[:space:]]*ANTHROPIC_BASE_URL=.+' "$ENV_FILE"; then
      pass "fallback enabled with ANTHROPIC_BASE_URL configured"
    else
      fail "fallback enabled but ANTHROPIC_BASE_URL is missing"
    fi
  fi
else
  fail ".env not found ($ENV_FILE)"
fi

if [ -f "$ROOT_DIR/logs/nanoclaw.log" ]; then
  pass "logs/nanoclaw.log exists"
  if grep -Eq 'Connected to WhatsApp|Connection closed|connection.*close' "$ROOT_DIR/logs/nanoclaw.log"; then
    pass "WhatsApp connection events found in log history"
  else
    warn "No WhatsApp connection events found in logs/nanoclaw.log"
  fi
else
  warn "logs/nanoclaw.log not found"
fi

if [ -f "$DB_PATH" ]; then
  pass "sqlite DB exists ($DB_PATH)"
  if have_cmd sqlite3; then
    if sqlite3 "$DB_PATH" ".schema worker_runs" | grep -q "CREATE TABLE"; then
      status_counts="$(sqlite3 "$DB_PATH" "SELECT status || ':' || COUNT(*) FROM worker_runs GROUP BY status ORDER BY status;" 2>/dev/null || true)"
      if [ -n "$status_counts" ]; then
        echo "[INFO] worker_runs status counts:"
        while IFS= read -r row; do
          [ -n "$row" ] && echo "  - $row"
        done <<<"$status_counts"
      else
        warn "worker_runs table has no rows"
      fi

      stale_queued="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE status='queued' AND started_at < ((strftime('%s','now')*1000)-$STALE_QUEUED_MS);" 2>/dev/null || echo 0)"
      stale_running="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM worker_runs WHERE status='running' AND started_at < ((strftime('%s','now')*1000)-3600000);" 2>/dev/null || echo 0)"

      if [[ "$stale_queued" =~ ^[0-9]+$ ]] && [ "$stale_queued" -eq 0 ]; then
        pass "no stale queued worker runs older than $STALE_QUEUED_MS ms"
      else
        fail "stale queued worker runs detected: $stale_queued"
      fi

      if [[ "$stale_running" =~ ^[0-9]+$ ]] && [ "$stale_running" -gt 0 ]; then
        warn "long-running worker runs (>60m): $stale_running"
      else
        pass "no long-running worker runs (>60m)"
      fi
    else
      warn "worker_runs table not found in $DB_PATH"
    fi
  else
    warn "sqlite3 command not found; skipped DB health checks"
  fi
else
  fail "sqlite DB missing ($DB_PATH)"
fi

echo
echo "Summary: pass=$pass_count warn=$warn_count fail=$fail_count"
if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
