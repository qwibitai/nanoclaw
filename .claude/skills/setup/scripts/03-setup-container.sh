#!/bin/bash
set -euo pipefail

# 03-setup-container.sh — Build container image and verify with test run

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [setup-container] $*" >> "$LOG_FILE"; }

# Parse args
RUNTIME=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --runtime) RUNTIME="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$RUNTIME" ]; then
  log "ERROR: --runtime flag is required (apple-container|docker)"
  cat <<EOF
=== NANOCLAW SETUP: SETUP_CONTAINER ===
RUNTIME: unknown
IMAGE: nanoclaw-agent:latest
BUILD_OK: false
TEST_OK: false
STATUS: failed
ERROR: missing_runtime_flag
LOG: logs/setup.log
=== END ===
EOF
  exit 4
fi

IMAGE="nanoclaw-agent:latest"

# Determine build/run commands based on runtime
case "$RUNTIME" in
  apple-container)
    if ! command -v container >/dev/null 2>&1; then
      log "Apple Container runtime not found"
      cat <<EOF
=== NANOCLAW SETUP: SETUP_CONTAINER ===
RUNTIME: apple-container
IMAGE: $IMAGE
BUILD_OK: false
TEST_OK: false
STATUS: failed
ERROR: runtime_not_available
LOG: logs/setup.log
=== END ===
EOF
      exit 2
    fi
    BUILD_CMD="container build"
    RUN_CMD="container"
    ;;
  docker)
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
      log "Docker runtime not available or not running"
      cat <<EOF
=== NANOCLAW SETUP: SETUP_CONTAINER ===
RUNTIME: docker
IMAGE: $IMAGE
BUILD_OK: false
TEST_OK: false
STATUS: failed
ERROR: runtime_not_available
LOG: logs/setup.log
=== END ===
EOF
      exit 2
    fi
    BUILD_CMD="docker build"
    RUN_CMD="docker"
    ;;
  *)
    log "Unknown runtime: $RUNTIME"
    cat <<EOF
=== NANOCLAW SETUP: SETUP_CONTAINER ===
RUNTIME: $RUNTIME
IMAGE: $IMAGE
BUILD_OK: false
TEST_OK: false
STATUS: failed
ERROR: unknown_runtime
LOG: logs/setup.log
=== END ===
EOF
    exit 4
    ;;
esac

log "Building container with $RUNTIME"

# Build
BUILD_OK="false"
if (cd "$PROJECT_ROOT/container" && $BUILD_CMD -t "$IMAGE" .) >> "$LOG_FILE" 2>&1; then
  BUILD_OK="true"
  log "Container build succeeded"
else
  log "Container build failed"
  cat <<EOF
=== NANOCLAW SETUP: SETUP_CONTAINER ===
RUNTIME: $RUNTIME
IMAGE: $IMAGE
BUILD_OK: false
TEST_OK: false
STATUS: failed
ERROR: build_failed
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

# Test
TEST_OK="false"
log "Testing container with echo command"
TEST_OUTPUT=$(echo '{}' | $RUN_CMD run -i --rm --entrypoint /bin/echo "$IMAGE" "Container OK" 2>>"$LOG_FILE") || true
if echo "$TEST_OUTPUT" | grep -q "Container OK"; then
  TEST_OK="true"
  log "Container test passed"
else
  log "Container test failed: $TEST_OUTPUT"
fi

STATUS="success"
if [ "$BUILD_OK" = "false" ] || [ "$TEST_OK" = "false" ]; then
  STATUS="failed"
fi

cat <<EOF
=== NANOCLAW SETUP: SETUP_CONTAINER ===
RUNTIME: $RUNTIME
IMAGE: $IMAGE
BUILD_OK: $BUILD_OK
TEST_OK: $TEST_OK
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
EOF

if [ "$STATUS" = "failed" ]; then
  exit 1
fi
