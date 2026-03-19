#!/bin/bash
# Auto-deploy: poll origin/main for new commits, pull, rebuild, restart.
# Designed to run via systemd timer every 2 minutes.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${PROJECT_ROOT}/logs/auto-deploy.log"
LOCK_FILE="/tmp/nanoclaw-deploy.lock"
BRANCH="main"
REMOTE="origin"

# Source environment for GH_TOKEN (git auth)
if [ -f "${PROJECT_ROOT}/.env" ]; then
  set -a
  source "${PROJECT_ROOT}/.env"
  set +a
fi

# Ensure gh CLI can authenticate git operations
if command -v gh &>/dev/null && [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git 2>/dev/null || true
fi

log() {
  echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE"
}

cleanup() {
  rm -f "$LOCK_FILE"
}

# Prevent concurrent deploys
if [ -f "$LOCK_FILE" ]; then
  pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "Deploy already running (pid $pid), skipping"
    exit 0
  fi
  # Stale lock
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap cleanup EXIT

cd "$PROJECT_ROOT"

# Check for new commits without fetching objects
LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" | cut -f1)

if [ -z "$REMOTE_HEAD" ]; then
  log "ERROR: Could not reach remote"
  exit 1
fi

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  # No changes, exit silently
  exit 0
fi

log "New commits detected: ${LOCAL_HEAD:0:7} -> ${REMOTE_HEAD:0:7}"

# Get commit summary for notification
git fetch "$REMOTE" "$BRANCH" --quiet
COMMIT_LOG=$(git log --oneline "${LOCAL_HEAD}..${REMOTE}/${BRANCH}" | head -10)
COMMIT_COUNT=$(git rev-list --count "${LOCAL_HEAD}..${REMOTE}/${BRANCH}")

log "Pulling $COMMIT_COUNT new commit(s)"
git pull "$REMOTE" "$BRANCH" --ff-only || {
  log "ERROR: Pull failed (not fast-forward). Manual intervention needed."
  exit 1
}

# Full rebuild
log "Installing dependencies"
npm install --prefer-offline 2>&1 | tail -3 | tee -a "$LOG_FILE"

log "Building TypeScript"
npm run build 2>&1 | tail -5 | tee -a "$LOG_FILE"

log "Rebuilding container image"
./container/build.sh 2>&1 | tail -5 | tee -a "$LOG_FILE"

# Notify agent via IPC before restart
# Find all group IPC directories and write a notification to each
NOTIFICATION=$(cat <<EOF
{
  "type": "message",
  "text": "🔄 **Auto-deploy complete** — $COMMIT_COUNT new commit(s) pulled and deployed.\n\nChanges:\n\`\`\`\n${COMMIT_LOG}\n\`\`\`\n\nContainer rebuilt. Restarting now.",
  "timestamp": "$(date -Iseconds)"
}
EOF
)

for ipc_dir in "${PROJECT_ROOT}/data/ipc"/*/messages; do
  if [ -d "$ipc_dir" ]; then
    group_dir=$(basename "$(dirname "$ipc_dir")")
    # Read chatJid from the group's IPC - we need to figure out the jid
    # The IPC message needs a chatJid. We'll read it from the DB via node.
    echo "$NOTIFICATION" | node -e "
      const fs = require('fs');
      const path = require('path');
      const Database = require('better-sqlite3');
      const data = JSON.parse(fs.readFileSync('/dev/stdin', 'utf-8'));
      const db = new Database(path.join('${PROJECT_ROOT}', 'data', 'nanoclaw.db'));
      const groups = db.prepare('SELECT chatJid, folder FROM registered_groups WHERE isMain = 1').all();
      for (const g of groups) {
        const dir = path.join('${PROJECT_ROOT}', 'data', 'ipc', g.folder, 'messages');
        fs.mkdirSync(dir, { recursive: true });
        data.chatJid = g.chatJid;
        fs.writeFileSync(path.join(dir, 'deploy-' + Date.now() + '.json'), JSON.stringify(data));
      }
      db.close();
    " 2>/dev/null && log "Deploy notification queued" || log "WARN: Could not queue notification (DB unavailable)"
    break  # Only need to run the node script once
  fi
done

# Wait for active containers to finish before restarting.
# Max wait 5 minutes — after that, restart anyway.
STATUS_FILE="${PROJECT_ROOT}/data/status.json"
MAX_WAIT=300
waited=0

while [ $waited -lt $MAX_WAIT ]; do
  if [ -f "$STATUS_FILE" ]; then
    active=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$STATUS_FILE','utf-8')).activeContainers)}catch{console.log(0)}" 2>/dev/null || echo "0")
  else
    active=0
  fi

  if [ "$active" = "0" ]; then
    break
  fi

  if [ $waited -eq 0 ]; then
    log "Waiting for $active active container(s) to finish before restart..."
  fi
  sleep 5
  waited=$((waited + 5))
done

if [ $waited -ge $MAX_WAIT ]; then
  log "WARN: Timed out waiting for containers after ${MAX_WAIT}s, restarting anyway"
fi

log "Restarting nanoclaw service"

# Try pidfile-based restart first (works without systemd user session)
PID_FILE="${PROJECT_ROOT}/data/nanoclaw.pid"
if [ -f "$PID_FILE" ]; then
  old_pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" 2>/dev/null || true
    sleep 2
  fi
fi

# Start new process
cd "$PROJECT_ROOT"
nohup node dist/index.js >> logs/nanoclaw.log 2>> logs/nanoclaw.error.log &
log "Deploy complete: now at $(git rev-parse --short HEAD) (pid $!)"
