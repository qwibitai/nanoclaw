#!/bin/bash
# Atlas VPS Git Sync — pulls all project and config repos every 5 minutes
# Runs as atlas user via cron

LOG=/home/atlas/nanoclaw/logs/git-sync.log
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S%z)

sync_repo() {
    local dir="$1"
    local name="$2"
    if [ -d "$dir/.git" ]; then
        cd "$dir"
        result=$(git pull --ff-only 2>&1)
        status=$?
        if [ $status -ne 0 ]; then
            echo "$TIMESTAMP | FAIL | $name | $result" >> "$LOG"
        elif [ "$result" != "Already up to date." ]; then
            echo "$TIMESTAMP | PULL | $name | $result" >> "$LOG"
        fi
    fi
}

# NanoClaw — detect source changes, auto-rebuild and restart
NANOCLAW_DIR=/home/atlas/nanoclaw
if [ -d "$NANOCLAW_DIR/.git" ]; then
    cd "$NANOCLAW_DIR"
    HEAD_BEFORE=$(git rev-parse HEAD 2>/dev/null)
    sync_repo "$NANOCLAW_DIR" nanoclaw
    HEAD_AFTER=$(git rev-parse HEAD 2>/dev/null)

    if [ "$HEAD_BEFORE" != "$HEAD_AFTER" ] && [ -n "$HEAD_BEFORE" ] && [ -n "$HEAD_AFTER" ]; then
        # Check if any source files changed (src/, container/, package.json, tsconfig)
        CHANGED_SRC=$(git diff --name-only "$HEAD_BEFORE" "$HEAD_AFTER" -- src/ container/ package.json tsconfig.json 2>/dev/null)
        if [ -n "$CHANGED_SRC" ]; then
            echo "$TIMESTAMP | BUILD | nanoclaw | Source changed, rebuilding..." >> "$LOG"
            BUILD_OUT=$(cd "$NANOCLAW_DIR" && npm run build 2>&1)
            BUILD_STATUS=$?
            if [ $BUILD_STATUS -eq 0 ]; then
                echo "$TIMESTAMP | BUILD | nanoclaw | Build succeeded, restarting service" >> "$LOG"
                sudo /usr/bin/systemctl restart nanoclaw
                sleep 3
                if systemctl is-active --quiet nanoclaw; then
                    echo "$TIMESTAMP | RESTART | nanoclaw | Service restarted successfully" >> "$LOG"
                else
                    echo "$TIMESTAMP | FAIL | nanoclaw | Service failed to start after rebuild" >> "$LOG"
                fi
            else
                echo "$TIMESTAMP | FAIL | nanoclaw | Build failed: ${BUILD_OUT:0:200}" >> "$LOG"
            fi
        fi

  # --- atlas-host-executor restart (if host/ or infra/ changed) ---
  HOST_CHANGED=$(git diff --name-only "$HEAD_BEFORE" "$HEAD_AFTER" -- host/ infra/ 2>/dev/null)
  if [ -n "$HOST_CHANGED" ]; then
    echo "$TIMESTAMP | RESTART | atlas-host-executor | host/ or infra/ changed, restarting" >> "$LOG"
    sudo /usr/bin/systemctl restart atlas-host-executor.service
    sleep 3
    if systemctl is-active --quiet atlas-host-executor.service; then
      echo "$TIMESTAMP | RESTART | atlas-host-executor | service restarted successfully" >> "$LOG"
    else
      echo "$TIMESTAMP | FAIL | atlas-host-executor | service failed to start after restart" >> "$LOG"
    fi
  fi
  # --- atlas-mission-control restart (if infra/atlas-mission-control.service changed) ---
  MC_CHANGED=$(git diff --name-only "$HEAD_BEFORE" "$HEAD_AFTER" -- infra/atlas-mission-control.service 2>/dev/null)
  if [ -n "$MC_CHANGED" ]; then
    echo "$TIMESTAMP | RESTART | atlas-mission-control | infra changed, restarting" >> "$LOG"
    sudo /usr/bin/systemctl restart atlas-mission-control.service
    sleep 3
    if systemctl is-active --quiet atlas-mission-control.service; then
      echo "$TIMESTAMP | RESTART | atlas-mission-control | service restarted successfully" >> "$LOG"
    else
      echo "$TIMESTAMP | FAIL | atlas-mission-control | service failed to start after restart" >> "$LOG"
    fi
  fi
    fi
fi

# Atlas core — graduation-status.json is written by the autonomous loop on VPS.
# Reset it before pull so upstream changes land cleanly. The autonomous loop
# will re-write the correct VPS state on its next run (daily at 10AM).
if [ -d /home/atlas/.atlas/.git ]; then
    cd /home/atlas/.atlas
    git checkout -- autonomy/graduation-status.json 2>/dev/null
    sync_repo /home/atlas/.atlas atlas-core
fi

# Claude config (CLAUDE.md, hooks registration, planning docs, skills)
# settings.json has platform-specific paths — reset before pull, rewrite after.
if [ -d /home/atlas/.claude/.git ]; then
    cd /home/atlas/.claude
    git checkout -- settings.json 2>/dev/null
    sync_repo /home/atlas/.claude claude-config
    # Rewrite paths from laptop (Windows) to VPS (Linux)
    SETTINGS=/home/atlas/.claude/settings.json
    if [ -f "$SETTINGS" ] && grep -q 'C:/Users/ttle0' "$SETTINGS" 2>/dev/null; then
        sed -i 's|python C:/Users/ttle0/|python3 /home/atlas/|g' "$SETTINGS"
        echo "$TIMESTAMP | REWRITE | claude-config | settings.json paths translated to VPS" >> "$LOG"
    fi
fi

# Regenerate self-knowledge if atlas-core or claude-config pulled new changes
# (the regen script reads both repos' source files to build the summary)
if [ -f /home/atlas/.atlas/scripts/regen-self-knowledge.py ]; then
    python3 /home/atlas/.atlas/scripts/regen-self-knowledge.py >/dev/null 2>&1
fi

# Auto-detect cross-project relationships (shared Supabase, shared deps)
if [ -f /home/atlas/.atlas/scripts/regen-project-graph.py ]; then
    python3 /home/atlas/.atlas/scripts/regen-project-graph.py >/dev/null 2>&1
fi

# System health staleness detection (agent checksums, hook accuracy, registry currency)
if [ -f /home/atlas/.atlas/scripts/regen-system-health.py ]; then
    python3 /home/atlas/.atlas/scripts/regen-system-health.py >/dev/null 2>&1
fi

# Environment parity check (laptop vs VPS drift detection)
if [ -f /home/atlas/.atlas/scripts/check-env-parity.py ]; then
    python3 /home/atlas/.atlas/scripts/check-env-parity.py >/dev/null 2>&1
fi

# Prune stale worktrees from all project repos
for repo_dir in /home/atlas/projects/gpg/*/; do
    [ -d "$repo_dir/.git" ] && git -C "$repo_dir" worktree prune 2>/dev/null
done
for repo_dir in /home/atlas/projects/crownscape/*/; do
    [ -d "$repo_dir/.git" ] && git -C "$repo_dir" worktree prune 2>/dev/null
done

# GPG project repos
sync_repo /home/atlas/projects/gpg/monthly-reporting gpg/monthly-reporting
sync_repo /home/atlas/projects/gpg/ops-hub gpg/ops-hub
sync_repo /home/atlas/projects/gpg/social-post-studio gpg/social-post-studio

# Crownscape project repos (nullglob so empty dirs don't produce a false iteration)
if [ -d /home/atlas/projects/crownscape ]; then
    shopt -s nullglob
    for dir in /home/atlas/projects/crownscape/*/; do
        [ -d "$dir/.git" ] && sync_repo "$dir" "crownscape/$(basename $dir)"
    done
    shopt -u nullglob
fi

