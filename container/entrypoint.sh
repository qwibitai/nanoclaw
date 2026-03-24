#!/bin/bash
set -e

# Bootstrap boty-agent modules
if [ -d "/home/node/agents/boty/.git" ]; then
  cd /home/node/agents/boty && git pull --ff-only || true
else
  mkdir -p /home/node/agents && git clone https://github.com/Yacine0801/boty-agent.git /home/node/agents/boty || true
fi

cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
