#!/bin/bash
set -e

# Copy extensions into src directory for unified compilation
if [ -d /app/extensions ] && [ "$(ls -A /app/extensions 2>/dev/null)" ]; then
  cp /app/extensions/*.ts /app/src/ 2>/dev/null || true
fi

# Recompile agent-runner source (may be customized per group)
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Buffer stdin (JSON with secrets — deleted by agent-runner after read)
cat > /tmp/input.json

# Drop privileges first, then sanitize environment.
# gosu must run before env -i: gosu overrides HOME from /etc/passwd,
# and when the target UID doesn't exist (e.g. macOS 501), it sets HOME=/.
# Running env -i after gosu ensures our explicit HOME takes effect.
exec gosu "${RUN_UID:-1000}:${RUN_GID:-1000}" \
  env -i \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  HOME="/home/node" \
  NODE_PATH="/usr/local/lib/node_modules" \
  AGENT_BROWSER_EXECUTABLE_PATH="/usr/bin/chromium" \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/usr/bin/chromium" \
  TZ="${TZ:-UTC}" \
  node /tmp/dist/index.js < /tmp/input.json
