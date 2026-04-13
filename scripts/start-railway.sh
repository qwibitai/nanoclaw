#!/usr/bin/env sh
set -eu

cd /app

# Start Docker daemon inside the container (DinD)
dockerd \
  --host=unix:///var/run/docker.sock \
  --host=tcp://127.0.0.1:2375 \
  --storage-driver=vfs \
  >/tmp/dockerd.log 2>&1 &

# Wait for Docker daemon to become ready
tries=0
until docker info >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 90 ]; then
    echo "Docker daemon did not start in time"
    tail -n 200 /tmp/dockerd.log || true
    exit 1
  fi
  sleep 1
done

echo "Docker daemon ready"

# Build the agent image expected by the host runtime
./container/build.sh

# Start LearnClaw host process
exec npm start
