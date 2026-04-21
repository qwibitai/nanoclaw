#!/bin/bash
# Deploy NanoClaw — rebuild and distribute dist/ to all instances.
# Usage: ./deploy.sh [--restart]
set -e
cd "$(dirname "$0")"

echo "Building..."
npm run build

# Dirs where dist/ must be copied. Each agent plist points to one of these.
# nanoclaw-bot is the runtime dir for Romy (its plist points to nanoclaw-bot/dist/index.js)
CODE_DIRS=(nanoclaw-sam nanoclaw-thais nanoclaw-alan nanoclaw-alex nanoclaw-bot)

# launchd services to kickstart on --restart
SERVICES=(com.nanoclaw com.nanoclaw.sam com.nanoclaw.thais com.nanoclaw.alan com.nanoclaw.alex)

for inst in "${CODE_DIRS[@]}"; do
  dir="/Users/boty/$inst"
  if [ -d "$dir" ]; then
    # Remove old dist (symlink or directory)
    rm -rf "$dir/dist"
    cp -R dist "$dir/dist"
    echo "  $inst: dist/ updated"
  fi
done

echo "Build distributed to ${#CODE_DIRS[@]} instances."

if [ "$1" = "--restart" ]; then
  echo "Restarting services..."
  for svc in "${SERVICES[@]}"; do
    launchctl kickstart -k "gui/$(id -u)/$svc" || echo "  warn: $svc kickstart failed"
  done
  echo "All services restarted."
fi

echo "Done."
