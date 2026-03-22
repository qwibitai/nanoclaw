#!/bin/bash
set -e

# Bootstrap auth credentials if Solo Vault key is available
if [[ -n "${SOLO_VAULT_BOOTSTRAP_KEY:-}" ]]; then
  source /app/agent-auth-init.sh
fi

cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
