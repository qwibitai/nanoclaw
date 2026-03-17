#!/bin/bash
# state-utils.sh — Shared state file utilities for PR review hooks.
# Source from hooks: source "$(dirname "$0")/lib/state-utils.sh"
#
# CROSS-WORKTREE ISOLATION (Kaizen escalation from incident #73):
# All state filtering MUST go through these functions. Hooks must NEVER
# iterate state files directly. This ensures a single enforcement point
# for branch scoping, staleness, and legacy file handling.
#
# The golden rule: a hook in worktree A must NEVER read, modify, or
# block based on state from worktree B.

# Default state directory and max age. Hooks can override via env vars.
STATE_DIR="${STATE_DIR:-/tmp/.pr-review-state}"
MAX_STATE_AGE="${MAX_STATE_AGE:-7200}"  # 2 hours

# Check if a state file belongs to the current worktree and is not stale.
# Returns 0 (true) if the file should be processed, 1 (false) if it should be skipped.
#
# A state file is SKIPPED if:
#   1. It is older than MAX_STATE_AGE (stale/orphaned session)
#   2. It has a BRANCH field that doesn't match the current branch (cross-worktree)
#   3. It has NO BRANCH field (legacy — can't be attributed to any worktree)
#
# Usage:
#   if is_state_for_current_worktree "$file"; then
#     # safe to read/modify
#   fi
is_state_for_current_worktree() {
  local f="$1"
  local now="${2:-$(date +%s)}"
  local current_branch="${3:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")}"

  [ -f "$f" ] || return 1

  # Skip stale state files
  local mtime
  mtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo "0")
  local age=$(( now - mtime ))
  if [ "$age" -gt "$MAX_STATE_AGE" ]; then
    return 1
  fi

  # Skip state files from other branches (prevents cross-worktree contamination)
  local file_branch
  file_branch=$(grep -E '^BRANCH=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
  if [ -n "$file_branch" ] && [ -n "$current_branch" ] && [ "$file_branch" != "$current_branch" ]; then
    return 1
  fi

  # Skip legacy state files without BRANCH — can't be safely attributed
  if [ -z "$file_branch" ]; then
    return 1
  fi

  return 0
}

# Iterate state files, calling is_state_for_current_worktree on each.
# Outputs matching file paths, one per line.
# Pre-computes now and current_branch for efficiency.
#
# Usage:
#   while IFS= read -r f; do
#     # process $f
#   done < <(list_state_files_for_current_worktree)
list_state_files_for_current_worktree() {
  local now current_branch
  now=$(date +%s)
  current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  for f in "$STATE_DIR"/*; do
    if is_state_for_current_worktree "$f" "$now" "$current_branch"; then
      echo "$f"
    fi
  done
}
