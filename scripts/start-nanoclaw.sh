#!/bin/bash
# Wait for Docker daemon before starting nanoclaw
# Used by com.nanoclaw LaunchAgent to survive reboots

MAX_WAIT=120
WAITED=0

while ! /usr/local/bin/docker info &>/dev/null && ! /Users/gabrielratner/.docker/cli-plugins/../../../.docker/bin/docker info &>/dev/null; do
    if [ $WAITED -ge $MAX_WAIT ]; then
        echo "$(date): Docker not ready after ${MAX_WAIT}s, starting anyway"
        break
    fi
    sleep 5
    WAITED=$((WAITED + 5))
done

if [ $WAITED -gt 0 ] && [ $WAITED -lt $MAX_WAIT ]; then
    echo "$(date): Docker ready after ${WAITED}s"
fi

exec /opt/homebrew/bin/node /Users/gabrielratner/projects/nanoclaw/dist/index.js
