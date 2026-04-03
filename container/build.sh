#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Generating plugin manifest..."
(cd "$PROJECT_DIR" && npx tsx scripts/generate-plugin-manifest.ts)

# Display what plugins contributed
echo ""
echo "Plugin contributions:"
if [ -f "$SCRIPT_DIR/plugins/binaries.json" ]; then
  BINARIES=$(cat "$SCRIPT_DIR/plugins/binaries.json" | grep -c '"name"' || echo "0")
  if [ "$BINARIES" -gt 0 ]; then
    echo "  Binaries (${BINARIES}):"
    cat "$SCRIPT_DIR/plugins/binaries.json" | grep '"name"' | sed 's/.*"name": "\([^"]*\)".*/    - \1/'
  fi
fi
if [ -f "$SCRIPT_DIR/plugins/directories.json" ]; then
  DIRS=$(cat "$SCRIPT_DIR/plugins/directories.json" | grep -c '/' || echo "0")
  if [ "$DIRS" -gt 0 ]; then
    echo "  Directories (${DIRS}):"
    cat "$SCRIPT_DIR/plugins/directories.json" | grep '/' | sed 's/.*"\([^"]*\)".*/    - \1/'
  fi
fi
if [ "$BINARIES" -eq 0 ] && [ "$DIRS" -eq 0 ]; then
  echo "  (none)"
fi
echo ""

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

cd "$SCRIPT_DIR"
${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
