#!/usr/bin/env bash
# NanoClaw startup script with Docker daemon auto-start and process supervision.
# Runs in the foreground — use a process manager (tmux, screen, or init) to keep it alive.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs"
RESTART_DELAY=5   # seconds between NanoClaw restarts
MAX_RESTARTS=0    # 0 = unlimited

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [start.sh] $*"
}

# ---------------------------------------------------------------------------
# Ensure Docker daemon is running
# ---------------------------------------------------------------------------
ensure_docker() {
  if docker info >/dev/null 2>&1; then
    log "Docker daemon already running."
    return 0
  fi

  log "Docker daemon not running — starting dockerd..."
  dockerd >> "$LOG_DIR/dockerd.log" 2>&1 &
  local DOCKER_PID=$!

  # Wait up to 30 s for Docker to become available
  local waited=0
  while ! docker info >/dev/null 2>&1; do
    if (( waited >= 30 )); then
      log "ERROR: Docker daemon failed to start within 30 seconds."
      return 1
    fi
    sleep 1
    (( waited++ )) || true
  done

  log "Docker daemon started (PID $DOCKER_PID)."
}

# ---------------------------------------------------------------------------
# Main loop: restart NanoClaw on exit
# ---------------------------------------------------------------------------
cd "$PROJECT_DIR"
ensure_docker

log "Starting NanoClaw supervision loop (restart_delay=${RESTART_DELAY}s)..."

restart_count=0
while true; do
  log "Starting NanoClaw (attempt $((restart_count + 1)))..."

  # Ensure Docker is still up before each start
  if ! docker info >/dev/null 2>&1; then
    log "Docker daemon died — restarting it..."
    ensure_docker || { log "Cannot start Docker. Waiting ${RESTART_DELAY}s..."; sleep "$RESTART_DELAY"; continue; }
  fi

  # Run NanoClaw; capture exit code
  set +e
  node dist/index.js >> "$LOG_DIR/nanoclaw.log" 2>> "$LOG_DIR/nanoclaw.error.log"
  EXIT_CODE=$?
  set -e

  (( restart_count++ )) || true
  log "NanoClaw exited with code $EXIT_CODE (total restarts: $restart_count)."

  if (( MAX_RESTARTS > 0 && restart_count >= MAX_RESTARTS )); then
    log "Reached max restarts ($MAX_RESTARTS). Exiting."
    exit 1
  fi

  log "Restarting in ${RESTART_DELAY}s..."
  sleep "$RESTART_DELAY"
done
