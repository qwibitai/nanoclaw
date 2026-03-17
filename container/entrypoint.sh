#!/bin/bash
set -e

# If GITHUB_TOKEN is set (dev cases), configure git to use it for HTTPS auth
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global credential.helper \
    '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'
  git config --global user.email "nanoclaw-dev@garsson.io"
  git config --global user.name "NanoClaw Dev Agent"
fi

# Compile agent-runner TypeScript to /tmp/dist (read-only after build)
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Read container input (prompt, group info) from stdin, then run the agent
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
