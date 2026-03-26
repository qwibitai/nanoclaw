#!/bin/bash
# Build the NanoClaw K8s / WebSocket management container image
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

IMAGE_NAME="nanoclaw-ws"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw WS management container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Compile TypeScript — dist/ files are COPY'd into the image
npm run build

${CONTAINER_RUNTIME} build -f container/Dockerfile.ws -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Run with:"
echo "  ${CONTAINER_RUNTIME} run -p 18789:18789 -e MANAGEMENT_TOKEN=secret -e ANTHROPIC_API_KEY=sk-... ${IMAGE_NAME}:${TAG}"
