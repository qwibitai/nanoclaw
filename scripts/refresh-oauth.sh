#!/bin/bash
# Refresh OAuth token for credential proxy
# Run via cron every 12 hours

set -e

CREDS_FILE="$HOME/.claude/.credentials.json"
ENV_FILE="$HOME/shoggoth/.env"

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
  # Claude CLI refreshes the token when it makes any API call
  # A minimal invocation that triggers refresh:
  claude -p "echo ok" --max-turns 1 2>/dev/null || true
  echo "Token refreshed"
fi

# Read the (possibly refreshed) token
NEW_TOKEN=$(jq -r '.claudeAiOauth.accessToken' "$CREDS_FILE")

# Update .env
# Remove old token line and append new one
sed -i '/^CLAUDE_CODE_OAUTH_TOKEN=/d' "$ENV_FILE"
echo "CLAUDE_CODE_OAUTH_TOKEN=${NEW_TOKEN}" >> "$ENV_FILE"

echo "OAuth token updated in .env"

# Restart NanoClaw to pick up new token
systemctl --user restart nanoclaw
echo "NanoClaw restarted"
