#!/bin/bash
# Starts Claude Code for unattended remote-control operation.
# Supervised by com.gabrielratner.claude-remote launchd agent (KeepAlive=true).
# launchd handles lifecycle — if Claude exits, launchd restarts this script.

export PATH="/Users/gabrielratner/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

LOG="$HOME/NanoClaw/logs/claude-autostart.log"
exec >> "$LOG" 2>&1

echo "$(date): claude-autostart: waiting for network..."

# Wait up to 90s for network (DNS check — avoids HTTP response code issues)
for i in $(seq 1 18); do
  if /usr/bin/host api.anthropic.com > /dev/null 2>&1; then
    echo "$(date): claude-autostart: network ready (attempt $i)"
    break
  fi
  echo "$(date): claude-autostart: no network yet, retrying... ($i/18)"
  sleep 5
done

# Extra pause so Tailscale and login items finish initializing
sleep 5

echo "$(date): claude-autostart: launching Claude..."
exec /Users/gabrielratner/.local/bin/claude \
  --dangerously-skip-permissions \
  --channels plugin:telegram@claude-plugins-official
