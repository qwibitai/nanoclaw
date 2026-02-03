#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"

# Auto-detect container runtime (same logic as src/config.ts)
detect_runtime() {
  if [ -n "$CONTAINER_RUNTIME" ]; then
    echo "$CONTAINER_RUNTIME"
    return
  fi

  # On macOS, prefer Apple Container; elsewhere prefer Podman
  if [ "$(uname)" = "Darwin" ]; then
    RUNTIMES="container podman docker"
  else
    RUNTIMES="podman docker"
  fi

  for rt in $RUNTIMES; do
    if command -v "$rt" &> /dev/null && "$rt" version &> /dev/null; then
      echo "$rt"
      return
    fi
  done

  echo ""
}

RUNTIME=$(detect_runtime)
if [ -z "$RUNTIME" ]; then
  echo "Error: No container runtime found. Install Podman or Docker."
  exit 1
fi

echo "Building NanoClaw agent container image..."
echo "Runtime: ${RUNTIME}"
echo "Image: ${IMAGE_NAME}:${TAG}"

$RUNTIME build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | $RUNTIME run -i ${IMAGE_NAME}:${TAG}"
