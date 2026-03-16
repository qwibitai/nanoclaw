#!/usr/bin/env bash
# smoke-test-vertical.sh — Run a vertical's container smoke tests inside the nanoclaw-agent image.
#
# Usage:
#   ./scripts/smoke-test-vertical.sh <vertical-name> <host-path>
#
# Example:
#   ./scripts/smoke-test-vertical.sh insurance ~/projects/garsson-insurance

set -euo pipefail

VERTICAL_NAME="${1:-}"
HOST_PATH="${2:-}"

if [[ -z "$VERTICAL_NAME" || -z "$HOST_PATH" ]]; then
  echo "Usage: $0 <vertical-name> <host-path>"
  echo "Example: $0 insurance ~/projects/garsson-insurance"
  exit 1
fi

HOST_PATH="$(cd "$HOST_PATH" && pwd)"

SMOKE_SCRIPT="tools/__tests__/smoke-container.sh"
IMAGE="nanoclaw-agent:latest"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

if [[ ! -d "$HOST_PATH" ]]; then
  echo "ERROR: Vertical path does not exist: $HOST_PATH"
  exit 1
fi

if [[ ! -f "$HOST_PATH/$SMOKE_SCRIPT" ]]; then
  echo "ERROR: Smoke script not found: $HOST_PATH/$SMOKE_SCRIPT"
  echo "The vertical must provide $SMOKE_SCRIPT"
  exit 1
fi

if ! $CONTAINER_RUNTIME image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Image $IMAGE not found. Building..."
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  "$PROJECT_ROOT/container/build.sh"
fi

echo "=== Smoke testing vertical: $VERTICAL_NAME ==="
echo "Host path: $HOST_PATH"
echo "Image: $IMAGE"
echo ""

$CONTAINER_RUNTIME run --rm \
  -v "$HOST_PATH:/workspace/extra/$VERTICAL_NAME:ro" \
  --entrypoint bash \
  "$IMAGE" \
  "/workspace/extra/$VERTICAL_NAME/$SMOKE_SCRIPT"

EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
  echo ""
  echo "=== PASSED: $VERTICAL_NAME smoke tests ==="
else
  echo ""
  echo "=== FAILED: $VERTICAL_NAME smoke tests (exit code $EXIT_CODE) ==="
fi

exit $EXIT_CODE
