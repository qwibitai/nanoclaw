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

echo "Starting NanoClaw..."
exec node dist/index.js
