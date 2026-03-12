#!/usr/bin/env bash
# Self-deploy: pull latest main, build, restart.
# Spawned detached so it survives the systemctl restart.
# Writes JSON status to logs/deploy-status.json for Discord notifications.

cd /home/ubuntu/nanoclaw

STATUS_FILE="logs/deploy-status.json"
LOG="logs/deploy.log"

write_status() {
  local status="$1" step="$2" error="$3"
  printf '{"status":"%s","step":"%s","error":"%s","timestamp":"%s"}\n' \
    "$status" "$step" "$error" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$STATUS_FILE"
}

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Deploy started" >> "$LOG"
write_status "running" "git pull" ""

if ! git checkout main >> "$LOG" 2>&1; then
  write_status "failed" "git checkout" "checkout failed — check deploy.log"
  exit 1
fi

if ! git pull origin main >> "$LOG" 2>&1; then
  write_status "failed" "git pull" "pull failed — local changes or merge conflict"
  exit 1
fi

write_status "running" "build" ""
if ! npm run build >> "$LOG" 2>&1; then
  write_status "failed" "build" "TypeScript build failed"
  exit 1
fi

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Build complete, restarting..." >> "$LOG"

# Write success status BEFORE restart — systemctl restart kills this script's
# process group, so lines after it never execute. The new process reads this
# file on startup to announce the result to Discord.
write_status "ok" "done" ""
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Deploy complete" >> "$LOG"

sudo systemctl restart nanoclaw >> "$LOG" 2>&1
