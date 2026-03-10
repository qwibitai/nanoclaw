#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Check for package updates by comparing pinned Dockerfile versions to latest
check_package_updates() {
  local outdated=()

  # npm packages: match @scope/pkg@1.2.3 or pkg@1.2.3
  while IFS= read -r line; do
    if [[ "$line" =~ ([a-zA-Z@/._-]+)@([0-9]+\.[0-9]+\.[0-9]+) ]]; then
      local pkg="${BASH_REMATCH[1]}"
      local pinned="${BASH_REMATCH[2]}"
      local latest
      latest=$(npm view "$pkg" version 2>/dev/null) || continue
      if [ "$pinned" != "$latest" ]; then
        outdated+=("  $pkg: $pinned -> $latest (npm)")
      fi
    fi
  done < <(grep -E '@[0-9]+\.[0-9]+\.[0-9]+' Dockerfile | grep -v '^#')

  # pip packages: match pkg==1.2.3
  while IFS= read -r line; do
    if [[ "$line" =~ ([a-zA-Z_-]+)==([0-9]+\.[0-9]+\.[0-9]+) ]]; then
      local pkg="${BASH_REMATCH[1]}"
      local pinned="${BASH_REMATCH[2]}"
      local latest
      latest=$(pip index versions "$pkg" 2>/dev/null | head -1 | grep -oP '\((\K[0-9.]+)') || continue
      if [ "$pinned" != "$latest" ]; then
        outdated+=("  $pkg: $pinned -> $latest (pip)")
      fi
    fi
  done < <(grep -E '==[0-9]+\.[0-9]+\.[0-9]+' Dockerfile | grep -v '^#')

  if [ ${#outdated[@]} -gt 0 ]; then
    echo ""
    echo "Package updates available:"
    for line in "${outdated[@]}"; do
      echo "$line"
    done
    echo "   Update versions in container/Dockerfile, then rebuild."
    echo ""
  fi
}

check_package_updates

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
