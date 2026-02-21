#!/bin/bash
set -e

# In dev, /app/src is bind-mounted with live source — recompile to /tmp/dist.
# In production (DinD), the mount is empty — fall back to pre-built /app/dist.
if ls /app/src/*.ts /app/src/**/*.ts 2>/dev/null | head -1 | grep -q .; then
  cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
  ln -s /app/node_modules /tmp/dist/node_modules
  chmod -R a-w /tmp/dist
  DIST=/tmp/dist
else
  DIST=/app/dist
fi

cat > /tmp/input.json
node "$DIST/index.js" < /tmp/input.json
