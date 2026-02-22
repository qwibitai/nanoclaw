#!/usr/bin/env bash
set -euo pipefail

CREDENTIALS="$HOME/.claude/.credentials.json"
DOTENV="$(dirname "$(realpath "$0")")/../.env"
LOGFILE="$(dirname "$(realpath "$0")")/../logs/oauth-refresh.log"
TIMER_NAME="nanoclaw-oauth-refresh-next"

log() {
  echo "$(date -Iseconds) $*" >> "$LOGFILE"
}

# Read credentials
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

# Update .env
if grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' "$DOTENV" 2>/dev/null; then
  sed -i "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${access_token}|" "$DOTENV"
else
  echo "CLAUDE_CODE_OAUTH_TOKEN=${access_token}" >> "$DOTENV"
fi
log "Updated .env with token (expires_at=$expires_at)"

# Cancel any existing scheduled refresh
systemctl --user stop "$TIMER_NAME.timer" 2>/dev/null || true

# Schedule next run 30 minutes before expiry
now_ms=$(($(date +%s) * 1000))
remaining_ms=$((expires_at - now_ms))
buffer_ms=$((30 * 60 * 1000))

if (( remaining_ms > buffer_ms )); then
  next_run_ms=$((expires_at - buffer_ms))
else
  # Token expires in less than 30 min — run again in 5 minutes
  next_run_ms=$((now_ms + 5 * 60 * 1000))
  log "WARN: token expires in <30 min, scheduling retry in 5 min"
fi

next_run_sec=$((next_run_ms / 1000))
next_run_time=$(date -d "@$next_run_sec" -Iseconds)

systemd-run --user \
  --unit="$TIMER_NAME" \
  --on-calendar="$(date -d "@$next_run_sec" '+%Y-%m-%d %H:%M:%S')" \
  --description="NanoClaw OAuth token refresh" \
  "$(realpath "$0")"

log "Scheduled next refresh at $next_run_time"
