#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Detect container runtime: prefer Docker if available, fall back to Apple Container
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    RUNTIME="docker"
elif command -v container &>/dev/null; then
    RUNTIME="container"
else
    echo "Error: No container runtime found. Install Docker or Apple Container."
    exit 1
fi

echo "Using runtime: ${RUNTIME}"

# Build with detected runtime
$RUNTIME build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
