#!/bin/bash
set -e

# Configure git identity and credential helper for GitHub
git config --global user.name "NanoClaw Bot"
git config --global user.email "bot@nanoclaw.dev"

# Use gh as git credential helper (gh auth is handled by OneCLI proxy)
if command -v gh &>/dev/null; then
  gh auth setup-git 2>/dev/null || true
fi

# Fast path: use pre-built dist if source hasn't changed (saves ~5-8s)
# Compare mounted src/ timestamp against the pre-built dist
SRC_NEWEST=$(find /app/src -name "*.ts" -newer /app/dist-prebuilt/index.js 2>/dev/null | head -1)
if [ -z "$SRC_NEWEST" ] && [ -f /app/dist-prebuilt/index.js ]; then
  cp -r /app/dist-prebuilt /tmp/dist 2>/dev/null
else
  cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
fi
ln -sf /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist 2>/dev/null || true
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
