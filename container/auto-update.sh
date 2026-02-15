#!/bin/bash
# Auto-update script for OmniClaw instances
# Pulls latest code from main, rebuilds container + host, and restarts the service
#
# Supports: macOS (launchd), Linux (systemd), Docker (docker-compose)
# Usage:    ./container/auto-update.sh
# Env vars: NANOCLAW_BRANCH (default: main), NANOCLAW_SERVICE (default: nanoclaw)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOCKFILE="/tmp/nanoclaw-update.lock"
BRANCH="${NANOCLAW_BRANCH:-main}"
LOG_DATE="$(date '+%Y-%m-%d %H:%M:%S')"

log() { echo "[$LOG_DATE] $1"; }

log "OmniClaw Auto-Update Starting..."
log "Repository: $REPO_DIR"
log "Target branch: $BRANCH"

# Check if running inside container
if [ -f /.dockerenv ]; then
    log "ERROR: This script should be run on the host, not inside the container"
    exit 1
fi

# Acquire lock to prevent concurrent updates (use mkdir for macOS compat — no flock)
if ! mkdir "$LOCKFILE" 2>/dev/null; then
    # Check if stale lock (older than 30 minutes)
    if [ "$(uname)" = "Darwin" ]; then
        LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCKFILE" 2>/dev/null || echo 0) ))
    else
        LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCKFILE" 2>/dev/null || echo 0) ))
    fi
    if [ "$LOCK_AGE" -gt 1800 ]; then
        log "Removing stale lock (${LOCK_AGE}s old)"
        rm -rf "$LOCKFILE"
        mkdir "$LOCKFILE"
    else
        log "Another update is already running (lock: $LOCKFILE, age: ${LOCK_AGE}s)"
        exit 0
    fi
fi
trap 'rm -rf "$LOCKFILE"' EXIT

cd "$REPO_DIR"

# Ensure we're on the target branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
    log "WARNING: On branch '$CURRENT_BRANCH', expected '$BRANCH'. Skipping update."
    exit 0
fi

# Bail on dirty working tree
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    log "WARNING: Uncommitted changes detected. Skipping update."
    exit 0
fi

# Fetch latest changes
log "Fetching origin/$BRANCH..."
git fetch origin "$BRANCH" --quiet

# Compare commits
LOCAL_COMMIT=$(git rev-parse HEAD)
REMOTE_COMMIT=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL_COMMIT" = "$REMOTE_COMMIT" ]; then
    log "Already up to date (${LOCAL_COMMIT:0:8})"
    exit 0
fi

log "Updates available: ${LOCAL_COMMIT:0:8} -> ${REMOTE_COMMIT:0:8}"

# Show what's new
git log --oneline "${LOCAL_COMMIT}..${REMOTE_COMMIT}" | while read -r line; do
    log "  $line"
done

# Pull
log "Pulling latest code..."
git pull --ff-only origin "$BRANCH"

# Write update info for container to read
UPDATE_INFO_FILENAME="${UPDATE_INFO_FILENAME:-.nanoclaw-update-info.json}"
UPDATE_INFO_FILE="$REPO_DIR/data/$UPDATE_INFO_FILENAME"
mkdir -p "$(dirname "$UPDATE_INFO_FILE")"

# Generate commit log JSON safely
if command -v jq &> /dev/null; then
  # Use jq for safe JSON generation
  COMMIT_LOG=$(git log --format='%H%x1e%h%x1e%s%x1e%an%x1e%aI' "${LOCAL_COMMIT}..${REMOTE_COMMIT}" | \
    jq -Rs 'split("\n") | map(select(length > 0) | split("\u001e") | {hash: .[0], short: .[1], subject: .[2], author: .[3], date: .[4]})')
elif command -v python3 &> /dev/null; then
  # Fallback to python3 if jq not available
  COMMIT_LOG=$(git log --format='%H%x1e%h%x1e%s%x1e%an%x1e%aI' "${LOCAL_COMMIT}..${REMOTE_COMMIT}" | \
    python3 -c "import sys, json; commits = [dict(zip(['hash','short','subject','author','date'], line.strip().split('\x1e'))) for line in sys.stdin if line.strip()]; print(json.dumps(commits))")
else
  # Minimal fallback - just use empty array
  log "Warning: Neither jq nor python3 available, commit log will be empty"
  COMMIT_LOG="[]"
fi

cat > "$UPDATE_INFO_FILE" <<EOF
{
  "updated": true,
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "oldCommit": "${LOCAL_COMMIT}",
  "newCommit": "${REMOTE_COMMIT}",
  "commitLog": ${COMMIT_LOG}
}
EOF
log "Wrote update info to $UPDATE_INFO_FILE"

# Build host-side TypeScript
log "Building host code..."
if command -v bun &> /dev/null; then
    bun run build
elif command -v npm &> /dev/null; then
    npm run build
fi

# Rebuild container image
log "Rebuilding container..."
if [ -f "docker-compose.yml" ]; then
    if command -v docker-compose &> /dev/null; then
        docker-compose build
    else
        docker compose build
    fi
elif [ -f "container/build.sh" ]; then
    bash container/build.sh
else
    log "No container build method found, skipping container rebuild"
fi

# Wait for agents to be idle before restarting
# Check for recent [agent-runner] activity in the log
IDLE_THRESHOLD="${NANOCLAW_IDLE_THRESHOLD:-120}"
MAX_WAIT="${NANOCLAW_MAX_WAIT:-600}"
LOG_FILE="$REPO_DIR/logs/nanoclaw.log"
WAITED=0

while [ "$WAITED" -lt "$MAX_WAIT" ] && [ -f "$LOG_FILE" ]; do
    LAST_AGENT_LINE=$(tail -500 "$LOG_FILE" | grep -a '\[agent-runner\]' | tail -1)
    if [ -z "$LAST_AGENT_LINE" ]; then
        break  # No agent activity in recent logs, safe to restart
    fi
    # Extract epoch timestamp from structured log ("time":1234567890123)
    LAST_TS=$(echo "$LAST_AGENT_LINE" | sed -n 's/.*"time":\([0-9]*\).*/\1/p')
    if [ -z "$LAST_TS" ]; then
        break  # Can't parse timestamp, proceed
    fi
    LAST_TS_SEC=$((LAST_TS / 1000))
    NOW_SEC=$(date +%s)
    AGE=$((NOW_SEC - LAST_TS_SEC))
    if [ "$AGE" -ge "$IDLE_THRESHOLD" ]; then
        log "Agents idle (last activity ${AGE}s ago)"
        break
    fi
    log "Agents active (last activity ${AGE}s ago). Waiting..."
    sleep 30
    WAITED=$((WAITED + 30))
done

if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    log "WARNING: Agents still active after ${MAX_WAIT}s wait. Restarting anyway."
fi

# Restart service
log "Restarting service..."
if [ -f "docker-compose.yml" ]; then
    # Docker Compose
    if command -v docker-compose &> /dev/null; then
        docker-compose down && docker-compose up -d
    else
        docker compose down && docker compose up -d
    fi
elif [ "$(uname)" = "Darwin" ] && launchctl list 2>/dev/null | grep -q com.nanoclaw; then
    # macOS launchd
    launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
    log "Kicked com.nanoclaw via launchd"
elif command -v systemctl &> /dev/null; then
    # Linux systemd
    SERVICE_NAME="${NANOCLAW_SERVICE:-nanoclaw}"
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        sudo systemctl restart "$SERVICE_NAME"
        log "Restarted systemd service: $SERVICE_NAME"
    else
        log "Service $SERVICE_NAME not active, skipping restart"
    fi
else
    log "No service manager found — manual restart required"
fi

log "Update complete! Now at ${REMOTE_COMMIT:0:8}"
