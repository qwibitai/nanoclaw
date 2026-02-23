#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "$0")")"
PROJECT_ROOT="$(realpath "$SCRIPT_DIR/../..")"
CREDENTIALS="$HOME/.claude/.credentials.json"
DOTENV="$PROJECT_ROOT/.env"
LOGFILE="$PROJECT_ROOT/logs/oauth-refresh.log"
TIMER_NAME="nanoclaw-oauth-refresh-next"
BUFFER_MS=$((5 * 60 * 1000))  # 5 minutes

log() {
  echo "$(date -Iseconds) $*" >> "$LOGFILE"
}

# --- Read credentials ---
if [[ ! -f "$CREDENTIALS" ]]; then
  log "ERROR: $CREDENTIALS not found"
  exit 1
fi

access_token=$(jq -r '.claudeAiOauth.accessToken' "$CREDENTIALS")
expires_at=$(jq -r '.claudeAiOauth.expiresAt' "$CREDENTIALS")

if [[ -z "$access_token" || "$access_token" == "null" ]]; then
  log "ERROR: no accessToken in credentials"
  exit 1
fi

if [[ -z "$expires_at" || "$expires_at" == "null" ]]; then
  log "WARN: no expiresAt in credentials, forcing refresh"
  expires_at=0
fi

now_ms=$(($(date +%s) * 1000))
remaining_ms=$((expires_at - now_ms))

# --- Refresh if expired or expiring within buffer ---
if (( remaining_ms <= BUFFER_MS )); then
  log "Token expired or expiring soon (remaining_ms=$remaining_ms), invoking claude CLI to refresh"

  # Find claude binary — check PATH, then common locations
  CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
  if [[ -z "$CLAUDE_BIN" ]]; then
    for candidate in "$HOME/.claude/local/claude" "$HOME/.local/bin/claude"; do
      if [[ -x "$candidate" ]]; then
        CLAUDE_BIN="$candidate"
        break
      fi
    done
  fi

  if [[ -z "$CLAUDE_BIN" ]]; then
    log "ERROR: claude binary not found in PATH or common locations"
    exit 1
  fi

  if "$CLAUDE_BIN" -p "ok" --no-session-persistence 2>>"$LOGFILE" >/dev/null; then
    log "Claude CLI refreshed token successfully"
    # Re-read credentials after CLI refresh
    access_token=$(jq -r '.claudeAiOauth.accessToken' "$CREDENTIALS")
    expires_at=$(jq -r '.claudeAiOauth.expiresAt' "$CREDENTIALS")

    if [[ -z "$access_token" || "$access_token" == "null" ]]; then
      log "ERROR: no accessToken after CLI refresh"
      exit 1
    fi
  else
    cli_exit=$?
    log "ERROR: claude CLI refresh failed (exit $cli_exit). User may need to run 'claude login'."
    exit 1
  fi
else
  log "Token still fresh (remaining_ms=$remaining_ms), syncing to .env"
fi

# --- Update .env ---
if [[ -f "$DOTENV" ]]; then
  grep -v '^CLAUDE_CODE_OAUTH_TOKEN=' "$DOTENV" > "$DOTENV.tmp" || true
else
  : > "$DOTENV.tmp"
fi
echo "CLAUDE_CODE_OAUTH_TOKEN=${access_token}" >> "$DOTENV.tmp"
mv "$DOTENV.tmp" "$DOTENV"
log "Updated .env with token (expires_at=$expires_at)"

# --- Schedule next run ---
systemctl --user stop "$TIMER_NAME.timer" 2>/dev/null || true
systemctl --user reset-failed "$TIMER_NAME.service" 2>/dev/null || true

now_ms=$(($(date +%s) * 1000))
remaining_ms=$((expires_at - now_ms))
schedule_buffer_ms=$((30 * 60 * 1000))

if (( remaining_ms > schedule_buffer_ms )); then
  next_run_ms=$((expires_at - schedule_buffer_ms))
else
  next_run_ms=$((now_ms + 5 * 60 * 1000))
  log "WARN: token expires in <30 min, scheduling retry in 5 min"
fi

next_run_sec=$((next_run_ms / 1000))
next_run_time=$(date -d "@$next_run_sec" -Iseconds)

if systemd-run --user \
  --unit="$TIMER_NAME" \
  --on-calendar="$(date -d "@$next_run_sec" '+%Y-%m-%d %H:%M:%S')" \
  --description="NanoClaw OAuth token refresh" \
  "$(realpath "$0")"; then
  log "Scheduled next refresh at $next_run_time"
else
  log "ERROR: systemd-run failed (exit $?), next refresh NOT scheduled"
fi
