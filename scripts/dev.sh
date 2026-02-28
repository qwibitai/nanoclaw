#!/bin/bash
# Launch a NanoClaw dev container with the repo mounted.
# Usage: ./scripts/dev.sh [branch]  (defaults to current branch)

set -euo pipefail

PROJECT_DIR="$HOME/nanoclaw"
BRANCH="${1:-$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD)}"
IMAGE_NAME="nanoclaw-dev"
DEV_DIR=""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[dev]${NC} $*"; }
warn() { echo -e "${YELLOW}[dev]${NC} $*"; }
err()  { echo -e "${RED}[dev]${NC} $*" >&2; }

cleanup() {
  if [[ -n "$DEV_DIR" && -d "$DEV_DIR" ]]; then
    echo ""
    read -rp "Clean up worktree at $DEV_DIR? [Y/n] " answer
    if [[ "${answer:-Y}" =~ ^[Yy]$ ]]; then
      git -C "$PROJECT_DIR" worktree remove --force "$DEV_DIR" 2>/dev/null || rm -rf "$DEV_DIR"
      log "Worktree cleaned up"
    else
      warn "Worktree left at $DEV_DIR — clean up manually with: git worktree remove $DEV_DIR"
    fi
  fi
}
trap cleanup EXIT

# --- Build dev container image if needed ---

if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  log "Building dev container image..."
  docker build -t "$IMAGE_NAME" "$PROJECT_DIR/container/dev"
fi

# --- Create a fresh worktree ---

DEV_DIR="$(mktemp -d /tmp/nanoclaw-dev-XXXX)"
rmdir "$DEV_DIR"

log "Creating dev worktree at $DEV_DIR (branch: $BRANCH)"
if git -C "$PROJECT_DIR" rev-parse "origin/$BRANCH" &>/dev/null; then
  git -C "$PROJECT_DIR" worktree add "$DEV_DIR" "origin/$BRANCH" --detach
else
  git -C "$PROJECT_DIR" worktree add "$DEV_DIR" "$BRANCH"
fi

# --- Launch container ---

log "Starting dev container..."
log "  Workspace: $DEV_DIR"
log "  Branch: $BRANCH"
echo ""

DOCKER_ARGS=(
  -it --rm
  --name "nanoclaw-dev-$$"
  -v "$DEV_DIR:/workspace"
  -w /workspace
)

# Mount Claude Code auth if available
if [[ -d "$HOME/.claude" ]]; then
  DOCKER_ARGS+=(-v "$HOME/.claude:/home/node/.claude")
fi

# Pass through environment variables if set
[[ -n "${GH_TOKEN:-}" ]]          && DOCKER_ARGS+=(-e "GH_TOKEN=$GH_TOKEN")
[[ -n "${ANTHROPIC_API_KEY:-}" ]] && DOCKER_ARGS+=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
[[ -n "${GITHUB_TOKEN:-}" ]]      && DOCKER_ARGS+=(-e "GITHUB_TOKEN=$GITHUB_TOKEN")

# Port forward for dev server
DOCKER_ARGS+=(-p 9200:9100)

docker run "${DOCKER_ARGS[@]}" "$IMAGE_NAME"
