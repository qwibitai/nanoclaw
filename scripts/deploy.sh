#!/bin/bash
# deploy.sh — Build and restart NanoClaw after a merge to main.
#
# Called by .husky/post-merge hook or manually.
# Safety: builds BEFORE restart, keeps old version on failure, notifies on Telegram.
#
# Usage:
#   ./scripts/deploy.sh              # full deploy (build + restart + notify)
#   ./scripts/deploy.sh --build-only # build without restart (for testing)
#   ./scripts/deploy.sh --dry-run    # show what would happen, don't do it
#
# Environment:
#   DEPLOY_SKIP_RESTART=1  — skip systemctl restart (for CI/testing)
#   DEPLOY_SKIP_NOTIFY=1   — skip Telegram notification
#   DEPLOY_LOG             — log file path (default: logs/deploy.log)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_LOG="${DEPLOY_LOG:-$PROJECT_ROOT/logs/deploy.log}"

# Parse flags
BUILD_ONLY=false
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=true ;;
    --dry-run) DRY_RUN=true ;;
  esac
done

# Ensure log directory exists
mkdir -p "$(dirname "$DEPLOY_LOG")" 2>/dev/null || true

log() {
  local msg="[$(date -Iseconds)] $*"
  echo "$msg"
  echo "$msg" >> "$DEPLOY_LOG" 2>/dev/null || true
}

notify() {
  local text="$1"
  if [ "${DEPLOY_SKIP_NOTIFY:-}" = "1" ]; then
    log "NOTIFY (skipped): $text"
    return 0
  fi
  # Source the Telegram IPC helper
  local ipc_lib="$PROJECT_ROOT/.claude/kaizen/hooks/lib/send-telegram-ipc.sh"
  if [ -f "$ipc_lib" ]; then
    CLAUDE_PROJECT_DIR="$PROJECT_ROOT" source "$ipc_lib"
    send_telegram_ipc "$text" || log "WARNING: Telegram notification failed"
  else
    log "WARNING: send-telegram-ipc.sh not found, skipping notification"
  fi
}

# Guard: only deploy from the main checkout on the main branch
guard_main_checkout() {
  local git_dir git_common current_branch
  git_dir=$(git -C "$PROJECT_ROOT" rev-parse --git-dir 2>/dev/null)
  git_common=$(git -C "$PROJECT_ROOT" rev-parse --git-common-dir 2>/dev/null)

  # Check we're in the main checkout (not a worktree)
  if [ "$git_dir" != "$git_common" ]; then
    log "ERROR: deploy.sh must run from the main checkout, not a worktree"
    return 1
  fi

  current_branch=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$current_branch" != "main" ]; then
    log "SKIP: not on main branch (on: $current_branch)"
    return 1
  fi

  return 0
}

# Detect what changed to determine deploy actions needed
detect_changes() {
  # Compare HEAD with HEAD~1 to see what the merge brought in
  local changed_files
  changed_files=$(git -C "$PROJECT_ROOT" diff --name-only HEAD~1..HEAD 2>/dev/null || echo "")

  NEEDS_NPM_INSTALL=false
  NEEDS_BUILD=false
  NEEDS_CONTAINER_BUILD=false
  NEEDS_RESTART=false

  if echo "$changed_files" | grep -q "package.json\|package-lock.json"; then
    NEEDS_NPM_INSTALL=true
    NEEDS_BUILD=true
    NEEDS_RESTART=true
  fi

  if echo "$changed_files" | grep -q "^src/\|^container/agent-runner/src/"; then
    NEEDS_BUILD=true
    NEEDS_RESTART=true
  fi

  if echo "$changed_files" | grep -qE "^container/Dockerfile|^container/build\.sh"; then
    NEEDS_CONTAINER_BUILD=true
    NEEDS_RESTART=true
  fi

  # If nothing code-related changed (docs only), skip everything
  if ! $NEEDS_BUILD && ! $NEEDS_CONTAINER_BUILD && ! $NEEDS_NPM_INSTALL; then
    if echo "$changed_files" | grep -qE "\.(ts|js|json|sh)$"; then
      # Scripts or config changed — rebuild to be safe
      NEEDS_BUILD=true
      NEEDS_RESTART=true
    fi
  fi
}

# Run npm install if package.json changed
step_npm_install() {
  if ! $NEEDS_NPM_INSTALL; then
    log "npm install: skipped (no package.json changes)"
    return 0
  fi
  log "npm install: starting..."
  if $DRY_RUN; then
    log "npm install: DRY RUN — would run npm install"
    return 0
  fi
  if ! (cd "$PROJECT_ROOT" && npm install --omit=dev 2>&1 | tail -5); then
    log "ERROR: npm install failed"
    return 1
  fi
  log "npm install: done"
}

# Build TypeScript
step_build() {
  if ! $NEEDS_BUILD; then
    log "build: skipped (no source changes)"
    return 0
  fi
  log "build: starting..."
  if $DRY_RUN; then
    log "build: DRY RUN — would run npm run build"
    return 0
  fi
  if ! (cd "$PROJECT_ROOT" && npm run build 2>&1); then
    log "ERROR: build failed — keeping old version"
    notify "Auto-deploy FAILED: build error. Still running previous version."
    return 1
  fi
  log "build: done"
}

# Build container image (if Dockerfile changed)
step_container_build() {
  if ! $NEEDS_CONTAINER_BUILD; then
    log "container build: skipped (no Dockerfile changes)"
    return 0
  fi
  log "container build: starting..."
  if $DRY_RUN; then
    log "container build: DRY RUN — would run ./container/build.sh"
    return 0
  fi
  if ! "$PROJECT_ROOT/container/build.sh" 2>&1; then
    log "WARNING: container build failed — agents may use stale image"
    notify "Auto-deploy WARNING: container build failed. Agents may use stale image."
    # Don't fail the whole deploy — the harness itself is fine
  fi
  log "container build: done"
}

# Restart the systemd service
step_restart() {
  if $BUILD_ONLY; then
    log "restart: skipped (--build-only)"
    return 0
  fi
  if ! $NEEDS_RESTART; then
    log "restart: skipped (no restart needed)"
    return 0
  fi
  if [ "${DEPLOY_SKIP_RESTART:-}" = "1" ]; then
    log "restart: skipped (DEPLOY_SKIP_RESTART=1)"
    return 0
  fi
  if $DRY_RUN; then
    log "restart: DRY RUN — would run systemctl --user restart nanoclaw"
    return 0
  fi

  log "restart: stopping service..."
  systemctl --user restart nanoclaw 2>&1 || {
    log "ERROR: systemctl restart failed"
    notify "Auto-deploy FAILED: restart error. Service may be down."
    return 1
  }
  log "restart: service restarted"

  # Health check — wait for service to be active
  local attempts=0
  while [ $attempts -lt 6 ]; do
    sleep 2
    if systemctl --user is-active nanoclaw >/dev/null 2>&1; then
      log "health check: service is active"
      return 0
    fi
    attempts=$((attempts + 1))
    log "health check: waiting... (attempt $((attempts))/6)"
  done

  log "ERROR: health check failed — service not active after 12s"
  notify "Auto-deploy FAILED: service not healthy after restart. Check logs."
  return 1
}

# Main
main() {
  log "=========================================="
  log "deploy.sh starting (flags: $*)"

  if ! guard_main_checkout; then
    return 0  # Not an error — just not the right context
  fi

  detect_changes

  if ! $NEEDS_BUILD && ! $NEEDS_CONTAINER_BUILD && ! $NEEDS_NPM_INSTALL && ! $NEEDS_RESTART; then
    log "No code changes detected — nothing to deploy"
    notify "Merged to main. No code changes — no restart needed."
    return 0
  fi

  log "Deploy plan: npm_install=$NEEDS_NPM_INSTALL build=$NEEDS_BUILD container=$NEEDS_CONTAINER_BUILD restart=$NEEDS_RESTART"

  if $DRY_RUN; then
    log "DRY RUN — no changes will be made"
  fi

  # Notify start
  if ! $DRY_RUN; then
    notify "Auto-deploy starting: build=$NEEDS_BUILD container=$NEEDS_CONTAINER_BUILD restart=$NEEDS_RESTART"
  fi

  # Execute steps — fail fast on critical steps
  step_npm_install || return 1
  step_build || return 1
  step_container_build  # Non-fatal — warns but continues
  step_restart || return 1

  log "deploy.sh completed successfully"

  if ! $DRY_RUN && ! $BUILD_ONLY; then
    notify "Auto-deploy complete. Service restarted and healthy."
  fi

  return 0
}

# Allow sourcing for testing
if [ "${DEPLOY_TEST:-}" != "1" ]; then
  main "$@"
fi
