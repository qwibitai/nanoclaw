#!/bin/bash
# Atomic deploy for NanoClaw
# Builds in an isolated git worktree, validates, then rsyncs artifacts to production.
# Usage: ./scripts/deploy.sh [branch]  (defaults to main)

set -euo pipefail

BRANCH="${1:-main}"
PROJECT_DIR="$HOME/nanoclaw"
MONITOR_PORT="${MONITOR_PORT:-9100}"
BUILD_DIR=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
err()  { echo -e "${RED}[deploy]${NC} $*" >&2; }

cleanup() {
  if [[ -n "$BUILD_DIR" && -d "$BUILD_DIR" ]]; then
    log "Cleaning up worktree at $BUILD_DIR"
    git -C "$PROJECT_DIR" worktree remove --force "$BUILD_DIR" 2>/dev/null || rm -rf "$BUILD_DIR"
  fi
}
trap cleanup EXIT

# --- Pre-flight checks ---

if [[ ! -d "$PROJECT_DIR/.git" ]]; then
  err "Not a git repo: $PROJECT_DIR"
  exit 1
fi

# Fetch latest from remote
log "Fetching latest from origin..."
git -C "$PROJECT_DIR" fetch origin

# Verify the branch exists on the remote
if ! git -C "$PROJECT_DIR" rev-parse "origin/$BRANCH" &>/dev/null; then
  err "Branch 'origin/$BRANCH' not found on remote"
  exit 1
fi

# --- Build in isolated worktree ---

BUILD_DIR="$(mktemp -d /tmp/nanoclaw-build-XXXX)"
# mktemp creates the dir; remove it so git worktree add can create it
rmdir "$BUILD_DIR"

log "Creating build worktree at $BUILD_DIR (branch: $BRANCH)"
git -C "$PROJECT_DIR" worktree add "$BUILD_DIR" "origin/$BRANCH" --detach

cd "$BUILD_DIR"

log "Installing dependencies..."
npm ci --ignore-scripts 2>&1 | tail -1
# Rebuild native modules for this platform
npm rebuild 2>&1 | tail -1

log "Building..."
npm run build

log "Running tests..."
npm test

log "Build and tests passed!"

# --- Deploy artifacts ---

log "Syncing dist/ to production..."
rsync -a --delete "$BUILD_DIR/dist/" "$PROJECT_DIR/dist/"

log "Syncing node_modules/ to production..."
rsync -a --delete "$BUILD_DIR/node_modules/" "$PROJECT_DIR/node_modules/"

# Update the git ref in production so `git log` reflects what's deployed
git -C "$PROJECT_DIR" checkout --detach "origin/$BRANCH" -- 2>/dev/null || true
# Reset to the deployed commit on the branch (keeps working tree intact since we rsynced)
git -C "$PROJECT_DIR" update-ref HEAD "$(git -C "$BUILD_DIR" rev-parse HEAD)"

# --- Snapshot strategies and restart ---

# Try to snapshot active strategies before restart (non-fatal if monitor isn't running)
if curl -sf -X POST "http://localhost:$MONITOR_PORT/api/deploy/snapshot" -o /dev/null 2>/dev/null; then
  log "Strategy snapshot saved"
else
  warn "Could not snapshot strategies (monitor may not be running)"
fi

log "Restarting service..."
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null || true
sleep 1
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

log "Deploy complete! Deployed $BRANCH ($(git -C "$BUILD_DIR" rev-parse --short HEAD))"
