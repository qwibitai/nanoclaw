#!/bin/bash
# Build the NanoClaw agent container image
# Usage: ./build.sh [tag] [--variant full|minimal]
#   full    (default) includes Chromium + agent-browser for browser automation
#   minimal no browser, smaller image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
VARIANT="full"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"

for arg in "$@"; do
  case $arg in
    --variant=*) VARIANT="${arg#--variant=}" ;;
    --variant) shift; VARIANT="$1" ;;
  esac
done

DOCKERFILE="Dockerfile.${VARIANT}"

if [ ! -f "$DOCKERFILE" ]; then
  echo "Error: Unknown variant '${VARIANT}'. Use 'full' or 'minimal'." >&2
  exit 1
fi

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"
echo "Variant: ${VARIANT} (${DOCKERFILE})"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" -f "${DOCKERFILE}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
