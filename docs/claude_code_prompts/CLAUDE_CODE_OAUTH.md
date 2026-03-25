# Claude Code Prompt: OAuth Token Auto-Refresh

## Context

NanoClaw's credential proxy reads `CLAUDE_CODE_OAUTH_TOKEN` from `.env`
to authenticate API calls via the Max subscription. The OAuth token is
stored in `~/.claude/.credentials.json` by the Claude Code CLI and
expires after ~24 hours. When it expires, the credential proxy can't
authenticate and all agent calls fail.

The Claude Code CLI handles token refresh automatically when it runs,
updating `~/.claude/.credentials.json`. We need a small script that:
1. Reads the current token from `~/.claude/.credentials.json`
2. Checks if it's expired or close to expiring
3. If so, triggers a refresh via `claude` CLI
4. Updates the `CLAUDE_CODE_OAUTH_TOKEN` in `.env`
5. Optionally restarts the NanoClaw service so the proxy picks up
   the new token

## Implementation

Create `scripts/refresh-oauth.sh` in the shoggoth/nanoclaw directory:

```bash
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
```

Then set up a cron job:

```bash
chmod +x scripts/refresh-oauth.sh

# Run every 12 hours
crontab -e
# Add:
0 */12 * * * /home/square/shoggoth/scripts/refresh-oauth.sh >> /home/square/shoggoth/logs/oauth-refresh.log 2>&1
```

Make sure `jq` is installed:
```bash
sudo apt-get install -y jq
```

Test it:
```bash
mkdir -p logs
./scripts/refresh-oauth.sh
# Should output: OAuth token updated, NanoClaw restarted
# Verify: send a WhatsApp message, check it works
```

Commit: "add OAuth token auto-refresh script with cron"
