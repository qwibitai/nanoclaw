#!/bin/bash
# NanoClaw deploy script — graceful restart that waits for active agent sessions
set -e

echo "Deploying NanoClaw..."

# Pull latest
git pull origin main

# Install dependencies needed to build both the core and the agent-runner
npm ci
npm --prefix container/agent-runner ci

# Build NanoClaw core and host-side agent-runner bundle
npm run build:core
npm run build:agent-runner

# Validate tmux runtime before we touch the running service
npm run smoke:runtime

# Trim dev dependencies after build so the deployed service matches runtime needs
npm prune --omit=dev
npm --prefix container/agent-runner prune --omit=dev

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

# Smoke-check the main service health endpoint after restart
npm run smoke:health

echo "Deploy complete."
