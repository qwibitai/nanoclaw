#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"

# Auto-detect container runtime (Docker preferred, Apple Container fallback)
if docker info >/dev/null 2>&1; then
  CLI="docker"
elif container system status >/dev/null 2>&1; then
  CLI="container"
else
  echo "Error: No container runtime found."
  echo "Install Docker (https://docs.docker.com/get-docker/)"
  echo "or Apple Container (https://github.com/apple/container/releases)."
  exit 1
fi

echo "Building NanoClaw agent container image..."
echo "Runtime: ${CLI}"
echo "Image: ${IMAGE_NAME}:${TAG}"

$CLI build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | $CLI run -i ${IMAGE_NAME}:${TAG}"
