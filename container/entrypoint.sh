#!/bin/bash
set -e

# Source environment variables from mounted env file
[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)

# Cap JS heap to prevent OOM
export NODE_OPTIONS="--max-old-space-size=2048"

# Configure git with GitHub token
if [ -n "$GITHUB_TOKEN" ]; then
  gh auth setup-git 2>/dev/null || true
  git config --global user.name "${GIT_AUTHOR_NAME:-NanoClaw Agent}"
  git config --global user.email "${GIT_AUTHOR_EMAIL:-nanoclaw@users.noreply.github.com}"
fi

# SSH key setup (synced via S3 or mounted)
if [ -f /workspace/sync/ssh/id_ed25519 ]; then
  mkdir -p ~/.ssh
  cp /workspace/sync/ssh/id_ed25519 ~/.ssh/id_ed25519
  chmod 600 ~/.ssh/id_ed25519
  ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null || true
fi

# Buffer stdin then run agent.
# If /tmp/input.json already exists (pre-written by Sprites backend),
# skip the stdin buffering step. Apple Container requires EOF to flush stdin pipe.
if [ ! -s /tmp/input.json ]; then
  cat > /tmp/input.json
fi
bun /app/src/index.ts < /tmp/input.json
