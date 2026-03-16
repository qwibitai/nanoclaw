#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Auto-select Dockerfile: use offline base image if available, otherwise VPS (pulls from Docker Hub)
if ${CONTAINER_RUNTIME} image inspect nanoclaw-base:latest &>/dev/null; then
  DOCKERFILE="Dockerfile"
  echo "Using offline Dockerfile (nanoclaw-base image found)"
elif [ -f Dockerfile.vps ]; then
  DOCKERFILE="Dockerfile.vps"
  echo "Using VPS Dockerfile (pulling from Docker Hub)"
else
  DOCKERFILE="Dockerfile"
  echo "Using default Dockerfile"
fi

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -f "${DOCKERFILE}" -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
