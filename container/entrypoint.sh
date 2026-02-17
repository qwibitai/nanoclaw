#!/bin/bash
set -e

# Source environment variables from mounted env file
[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)

# Cap JS heap to prevent OOM
export NODE_OPTIONS="--max-old-space-size=2048"

# Cap Go heap for tsgo (TypeScript native compiler) — Go doesn't auto-detect
# container memory limits, so without this tsgo allocates unbounded memory and hangs.
# Set to 75% of available RAM, leaving headroom for OS + other processes.
# See: https://github.com/microsoft/typescript-go/issues/2125
TOTAL_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
export GOMEMLIMIT=$(( TOTAL_KB * 3 / 4 / 1024 ))MiB

# Configure git with GitHub token
if [ -n "$GITHUB_TOKEN" ]; then
  gh auth setup-git 2>/dev/null || true
  git config --global user.name "${GIT_AUTHOR_NAME:-NanoClaw Agent}"
  git config --global user.email "${GIT_AUTHOR_EMAIL:-nanoclaw@users.noreply.github.com}"

  # Authenticate Graphite CLI if available and not already authenticated
  if command -v gt &> /dev/null; then
    if ! gt auth status &> /dev/null; then
      echo "$GITHUB_TOKEN" | gt auth --token - 2>/dev/null || true
    fi
  fi
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
