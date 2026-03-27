#!/bin/bash
# Wait for Docker to be ready before starting NanoClaw

DOCKER_SOCK="/Users/gabrielratner/.docker/run/docker.sock"
MAX_WAIT=120
ELAPSED=0

# Launch Docker Desktop if not running
if ! /usr/local/bin/docker info &>/dev/null; then
    open -a Docker
fi

# Wait for Docker socket to be available
while [ ! -S "$DOCKER_SOCK" ] || ! /usr/local/bin/docker info &>/dev/null; do
    if [ $ELAPSED -ge $MAX_WAIT ]; then
        echo "$(date): Timed out waiting for Docker" >&2
        exit 1
    fi
    sleep 5
    ELAPSED=$((ELAPSED + 5))
done

echo "$(date): Docker ready after ${ELAPSED}s, starting NanoClaw"
exec /opt/homebrew/Cellar/node/25.8.1_1/bin/node /Users/gabrielratner/NanoClaw/dist/index.js
