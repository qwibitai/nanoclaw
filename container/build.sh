#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Add Docker Desktop credential helpers to PATH (macOS)
if [ -d "/Applications/Docker.app/Contents/Resources/bin" ]; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi

# Find docker (may be in /usr/local/opt/docker/bin on macOS with Homebrew)
if command -v docker &> /dev/null; then
  DOCKER=docker
elif [ -x /usr/local/opt/docker/bin/docker ]; then
  DOCKER=/usr/local/opt/docker/bin/docker
elif [ -x /usr/local/bin/docker ]; then
  DOCKER=/usr/local/bin/docker
else
  echo "Error: docker not found" >&2
  exit 1
fi

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Build with Docker
$DOCKER build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | docker run -i ${IMAGE_NAME}:${TAG}"
