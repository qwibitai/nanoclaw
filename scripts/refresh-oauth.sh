#!/bin/bash
# Refresh OAuth token for credential proxy
# Run via cron every 4 hours
#
# The credential proxy re-reads .env on each request, so updating
# the file is sufficient — no service restart needed.

set -e

CREDS_FILE="$HOME/.claude/.credentials.json"
ENV_FILE="$HOME/shoggoth/.env"

# Ensure XDG_RUNTIME_DIR is set (needed for systemctl --user from cron)
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# Check if credentials file exists
if [ ! -f "$CREDS_FILE" ]; then
  echo "ERROR: No credentials file at $CREDS_FILE"
  echo "Run 'claude /login' to authenticate"
  exit 1
fi

# Check expiry (requires jq)
EXPIRES_AT=$(jq -r '.claudeAiOauth.expiresAt' "$CREDS_FILE")
NOW_MS=$(date +%s%3N)

# Refresh if expiring within 2 hours (7200000 ms)
BUFFER=7200000
if [ "$((EXPIRES_AT - NOW_MS))" -lt "$BUFFER" ]; then
  echo "Token expiring soon, refreshing..."
  OLD_TOKEN=$(jq -r '.claudeAiOauth.accessToken' "$CREDS_FILE")

  # Claude CLI refreshes the token when it makes any API call
  # A minimal invocation that triggers refresh:
  claude -p "echo ok" --max-turns 1 2>/dev/null || true

  # Wait for credentials.json to be updated with the new token
  for i in $(seq 1 30); do
    NEW_CHECK=$(jq -r '.claudeAiOauth.accessToken' "$CREDS_FILE")
    if [ "$NEW_CHECK" != "$OLD_TOKEN" ]; then
      echo "Token refreshed after ${i}s"
      break
    fi
    sleep 1
  done

  if [ "$NEW_CHECK" = "$OLD_TOKEN" ]; then
    echo "WARNING: Token unchanged after refresh attempt — credentials.json may not have updated"
  fi
fi

# Read the (possibly refreshed) token
NEW_TOKEN=$(jq -r '.claudeAiOauth.accessToken' "$CREDS_FILE")

# Update .env — proxy re-reads on each request, no restart needed
sed -i '/^CLAUDE_CODE_OAUTH_TOKEN=/d' "$ENV_FILE"
echo "CLAUDE_CODE_OAUTH_TOKEN=${NEW_TOKEN}" >> "$ENV_FILE"

echo "OAuth token updated in .env"
