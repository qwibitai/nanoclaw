#!/bin/bash
# Pushes any uncommitted changes in group submodules to their private remotes.
# Designed to run daily via systemd timer.

set -euo pipefail

GROUPS_DIR="$(cd "$(dirname "$0")/../groups" && pwd)"
LOG_TAG="nanoclaw-sync"

for dir in "$GROUPS_DIR"/*/; do
  [ -f "$dir/.git" ] || continue  # only submodules have a .git file

  group="$(basename "$dir")"

  cd "$dir"

  # Stage all changes (respects submodule's .gitignore)
  git add -A

  if git diff --cached --quiet; then
    echo "[$group] No changes to sync"
  else
    git commit -m "Auto-sync $(date +%Y-%m-%d)"
    git push
    echo "[$group] Synced"
  fi

  cd "$GROUPS_DIR"
done
