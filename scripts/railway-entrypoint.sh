#!/bin/bash
# Railway entrypoint: starts the Docker daemon, builds the agent image,
# then hands off to the NanoClaw Node.js app.
#
# The container must run in privileged mode for dockerd to work.
# Enable it under: Railway service → Settings → Deploy → Privileged

set -e

# ---------------------------------------------------------------------------
# 1. Start Docker daemon in the background
# ---------------------------------------------------------------------------
echo "[entrypoint] Starting Docker daemon..."
# --iptables=false: Railway kernels use nf_tables backend which dockerd cannot
# manage without host-level privileges. Disabling iptables management avoids
# the "Permission denied" crash; container networking still works via CNI.
dockerd --host unix:///var/run/docker.sock \
        --iptables=false \
        --bridge=none \
        --log-level error \
        &
DOCKERD_PID=$!

echo "[entrypoint] Waiting for Docker daemon to become ready..."
for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    echo "[entrypoint] Docker daemon ready (${i}s)"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "[entrypoint] ERROR: Docker daemon did not start within 60 seconds."
    echo "[entrypoint] Make sure the Railway service has 'Privileged' mode enabled."
    exit 1
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# 2. Build the nanoclaw-agent container image IN THE BACKGROUND so that
#    Node.js can start immediately and answer Railway's healthcheck.
#    Set SKIP_CONTAINER_BUILD=1 to skip (e.g., when pulling from a registry).
# ---------------------------------------------------------------------------
if [ -z "$SKIP_CONTAINER_BUILD" ]; then
  echo "[entrypoint] Building nanoclaw-agent image in background (this may take a few minutes on first deploy)..."
  (cd /app && ./container/build.sh && echo "[entrypoint] Agent image built successfully.") &
else
  echo "[entrypoint] Skipping container build (SKIP_CONTAINER_BUILD is set)."
fi

# ---------------------------------------------------------------------------
# 3. Start the NanoClaw Node.js application immediately.
#    The /health endpoint becomes available right away; agent tasks that
#    arrive before the image is ready will fail gracefully and can be retried.
# ---------------------------------------------------------------------------
echo "[entrypoint] Starting NanoClaw..."
cd /app
exec node dist/index.js
