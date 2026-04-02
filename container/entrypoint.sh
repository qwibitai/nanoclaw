#!/bin/bash
# NanoClaw Agent Container Entrypoint
# Reads JSON from stdin, runs the agent, outputs JSON to stdout.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
set -e

# Plugin initialization — shell scripts declared by plugin modules, baked into image at build time
for f in /app/plugin-init/*.sh; do
  [ -f "$f" ] && . "$f"
done

cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
