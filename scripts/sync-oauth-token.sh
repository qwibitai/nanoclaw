#!/bin/bash
# Syncs the Claude Code OAuth token from keychain into NanoClaw's .env.
# If the access token is within 3 hours of expiry (or already expired),
# uses the refresh token to obtain a new one and writes it back to the keychain.
# Runs every 2 hours via launchd (com.nanoclaw.token-sync).

set -e

ENV_FILE="$HOME/NanoClaw/.env"
KEYCHAIN_SERVICE="Claude Code-credentials"
CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
TOKEN_ENDPOINT="https://platform.claude.com/v1/oauth/token"
REFRESH_THRESHOLD_SECS=10800  # 3 hours

# Read credentials from keychain
CREDS=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)
if [ -z "$CREDS" ]; then
  echo "$(date): ERROR - could not read $KEYCHAIN_SERVICE from keychain" >&2
  exit 1
fi

# Parse access token, refresh token, and seconds remaining
PARSED=$(echo "$CREDS" | python3 -c "
import json, sys, time
d = json.load(sys.stdin)
o = d.get('claudeAiOauth', {})
access  = o.get('accessToken', '')
refresh = o.get('refreshToken', '')
expires = o.get('expiresAt', 0)
now     = int(time.time() * 1000)   # expiresAt is ms
remaining_secs = (expires - now) // 1000
print(access)
print(refresh)
print(remaining_secs)
")

ACCESS_TOKEN=$(echo "$PARSED" | sed -n '1p')
REFRESH_TOKEN=$(echo "$PARSED" | sed -n '2p')
REMAINING_SECS=$(echo "$PARSED" | sed -n '3p')

if [ -z "$ACCESS_TOKEN" ]; then
  echo "$(date): ERROR - could not parse accessToken" >&2
  exit 1
fi

echo "$(date): access token has ${REMAINING_SECS}s remaining"

# Refresh if within 3 hours of expiry or already expired
if [ "$REMAINING_SECS" -lt "$REFRESH_THRESHOLD_SECS" ]; then
  echo "$(date): token expiring soon or expired — refreshing..."

  if [ -z "$REFRESH_TOKEN" ]; then
    echo "$(date): ERROR - no refresh token available; cannot refresh" >&2
    exit 1
  fi

  RESPONSE=$(curl -sf -X POST "$TOKEN_ENDPOINT" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "grant_type=refresh_token" \
    --data-urlencode "refresh_token=$REFRESH_TOKEN" \
    --data-urlencode "client_id=$CLIENT_ID" 2>&1)

  if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
    echo "$(date): ERROR - token refresh request failed: $RESPONSE" >&2
    exit 1
  fi

  NEW_CREDS=$(echo "$RESPONSE" | python3 -c "
import json, sys, time
r = json.load(sys.stdin)
if 'error' in r:
    raise ValueError(r.get('error_description', r['error']))
access      = r.get('access_token', '')
refresh_new = r.get('refresh_token', '')
expires_in  = r.get('expires_in', 57600)
expires_at  = int((time.time() + expires_in) * 1000)
print(access)
print(refresh_new)
print(expires_at)
" 2>&1)

  if [ $? -ne 0 ]; then
    echo "$(date): ERROR - failed to parse refresh response: $NEW_CREDS" >&2
    echo "$(date): Response was: $RESPONSE" >&2
    exit 1
  fi

  NEW_ACCESS=$(echo "$NEW_CREDS" | sed -n '1p')
  NEW_REFRESH=$(echo "$NEW_CREDS" | sed -n '2p')
  NEW_EXPIRES=$(echo "$NEW_CREDS" | sed -n '3p')

  if [ -z "$NEW_ACCESS" ]; then
    echo "$(date): ERROR - refresh returned empty access token" >&2
    exit 1
  fi

  # Write updated credentials back to keychain
  UPDATED_JSON=$(echo "$CREDS" | NEW_ACCESS="$NEW_ACCESS" NEW_EXPIRES="$NEW_EXPIRES" NEW_REFRESH="$NEW_REFRESH" python3 -c "
import json, sys, os
d = json.loads(sys.stdin.read())
o = d.setdefault('claudeAiOauth', {})
o['accessToken'] = os.environ['NEW_ACCESS']
o['expiresAt']   = int(os.environ['NEW_EXPIRES'])
new_refresh = os.environ.get('NEW_REFRESH', '')
if new_refresh:
    o['refreshToken'] = new_refresh
print(json.dumps(d))
")

  security delete-generic-password -s "$KEYCHAIN_SERVICE" 2>/dev/null || true
  security add-generic-password -s "$KEYCHAIN_SERVICE" -a "$USER" -w "$UPDATED_JSON"

  ACCESS_TOKEN="$NEW_ACCESS"
  echo "$(date): token refreshed and written to keychain"
fi

# Update .env if token changed
CURRENT_TOKEN=$(grep "^CLAUDE_CODE_OAUTH_TOKEN=" "$ENV_FILE" 2>/dev/null | cut -d= -f2-)

if [ "$ACCESS_TOKEN" = "$CURRENT_TOKEN" ]; then
  echo "$(date): .env token unchanged, skipping restart"
  exit 0
fi

sed -i '' "s|CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$ACCESS_TOKEN|" "$ENV_FILE"
echo "$(date): .env updated, restarting NanoClaw"

launchctl kickstart -k "gui/$(id -u)/com.nanoclaw" 2>/dev/null || true
