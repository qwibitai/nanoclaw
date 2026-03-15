#!/bin/sh
set -e

echo "=== NanoClaw startup ==="

# Build agent image if not present on host
if ! docker image inspect nanoclaw-agent:latest > /dev/null 2>&1; then
    echo "Building nanoclaw-agent image..."
    cd /app/container && sh build.sh
    cd /app
else
    echo "nanoclaw-agent image found, skipping build."
fi

# Pre-create persistent data directory structure so volume mounts
# don't start empty and cause runtime errors on first boot
mkdir -p \
    /app/data/sessions \
    /app/data/env \
    /app/data/ipc \
    /app/logs \
    /app/store

echo "Starting NanoClaw..."
exec node dist/index.js
