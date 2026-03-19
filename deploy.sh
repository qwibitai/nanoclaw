#!/bin/bash
# NanoClaw deploy script — graceful restart that waits for active agent sessions
set -e

echo "Deploying NanoClaw..."

# Pull latest
git pull origin main

# Install dependencies
npm ci --production

# Build NanoClaw core
npm run build

# Build agent-runner
(cd container/agent-runner && npm ci --production && npm run build)

# Check for active agent sessions before restarting
ACTIVE=$(tmux ls 2>/dev/null | grep "^nanoclaw-" | wc -l)
if [ "$ACTIVE" -gt 0 ]; then
  echo "Waiting for $ACTIVE active agent session(s) to complete (max 120s)..."
  WAITED=0
  while [ "$WAITED" -lt 120 ]; do
    ACTIVE=$(tmux ls 2>/dev/null | grep "^nanoclaw-" | wc -l)
    if [ "$ACTIVE" -eq 0 ]; then
      echo "All sessions completed."
      break
    fi
    sleep 5
    WAITED=$((WAITED + 5))
  done
  ACTIVE=$(tmux ls 2>/dev/null | grep "^nanoclaw-" | wc -l)
  if [ "$ACTIVE" -gt 0 ]; then
    echo "Timeout reached, $ACTIVE session(s) still running — restarting anyway."
  fi
fi

# Restart (user service, no sudo needed)
systemctl --user restart nanoclaw

echo "Deploy complete."
