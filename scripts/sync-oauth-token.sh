#!/bin/bash
# Sync OAuth token from Claude Code keychain to nanoclaw .env
ENV_FILE="/Users/gabrielratner/projects/nanoclaw/.env"

NEW_TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | python3 -c "
import sys,json
try:
    d = json.loads(sys.stdin.read().strip())
    print(d.get('claudeAiOauth', {}).get('accessToken', ''))
except: pass
" 2>/dev/null)

[ -z "$NEW_TOKEN" ] && exit 0

CURRENT_TOKEN=$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2)
[ "$NEW_TOKEN" = "$CURRENT_TOKEN" ] && exit 0

sed -i '' "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${NEW_TOKEN}|" "$ENV_FILE"
echo "$(date): Token updated, restarting nanoclaw"
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
