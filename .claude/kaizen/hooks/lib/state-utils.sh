#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# state-utils.sh — Shared state file utilities for workflow gate hooks.
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

# Convert a PR URL to a safe state file key.
# e.g. https://github.com/Garsson-io/nanoclaw/pull/33 → Garsson-io_nanoclaw_33
#
# DRY EXTRACTION (Kaizen #172): This sed pattern was duplicated in
# pr-review-loop.sh, kaizen-reflect.sh, post-merge-clear.sh, and test-helpers.sh.
# All callers now use this single function.
#
# Usage:
#   KEY=$(pr_url_to_state_key "$PR_URL")
#   STATE_FILE="$STATE_DIR/$KEY"
pr_url_to_state_key() {
  local url="$1"
  echo "$url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g'
}

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

# Find the first state file with STATUS=needs_review for the current branch.
# Outputs "PR_URL|ROUND" on success, returns 1 if none found.
#
# Used by enforcement hooks (Stop, PreToolUse) to check if a review gate
# is active. Centralized here to avoid duplication across hooks.
#
# Usage:
#   REVIEW_INFO=$(find_needs_review_state)
#   if [ $? -eq 0 ]; then
#     PR_URL=$(echo "$REVIEW_INFO" | cut -d'|' -f1)
#     ROUND=$(echo "$REVIEW_INFO" | cut -d'|' -f2)
#   fi
find_needs_review_state() {
  while IFS= read -r f; do
    local status
    status=$(grep -E '^STATUS=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ "$status" = "needs_review" ]; then
      local pr_url round
      pr_url=$(grep -E '^PR_URL=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
      round=$(grep -E '^ROUND=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
      # Auto-clear state for merged/closed PRs (kaizen #85, Fix A)
      # One API call per stale state encounter — after cleanup, no further calls.
      if [ -n "$pr_url" ]; then
        local pr_state
        pr_state=$(gh pr view "$pr_url" --json state --jq .state 2>/dev/null)
        if [ "$pr_state" = "MERGED" ] || [ "$pr_state" = "CLOSED" ]; then
          rm -f "$f" 2>/dev/null
          continue
        fi
      fi
      echo "$pr_url|$round"
      return 0
    fi
  done < <(list_state_files_for_current_worktree)
  return 1
}

# Find the first state file with a given STATUS for the current branch.
# General-purpose version of find_needs_review_state — reusable for any workflow gate.
# Outputs "PR_URL|STATUS" on success, returns 1 if none found.
#
# Usage:
#   STATE_INFO=$(find_state_with_status "needs_post_merge")
#   if [ $? -eq 0 ]; then
#     PR_URL=$(echo "$STATE_INFO" | cut -d'|' -f1)
#   fi
find_state_with_status() {
  local wanted_status="$1"
  while IFS= read -r f; do
    local status
    status=$(grep -E '^STATUS=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ "$status" = "$wanted_status" ]; then
      local pr_url
      pr_url=$(grep -E '^PR_URL=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
      echo "$pr_url|$status"
      return 0
    fi
  done < <(list_state_files_for_current_worktree)
  return 1
}

# Clear the first state file matching a given STATUS for the current branch.
# Returns 0 if a file was cleared, 1 if none found.
#
# Usage:
#   clear_state_with_status "needs_post_merge"
clear_state_with_status() {
  local wanted_status="$1"
  while IFS= read -r f; do
    local status
    status=$(grep -E '^STATUS=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ "$status" = "$wanted_status" ]; then
      rm -f "$f" 2>/dev/null
      return 0
    fi
  done < <(list_state_files_for_current_worktree)
  return 1
}

# Find ALL state files matching a given STATUS for the current branch (kaizen #279).
# Outputs "PR_URL|STATUS" per line. Returns 1 if none found.
#
# Usage:
#   ALL_INFO=$(find_all_states_with_status "needs_post_merge")
#   echo "$ALL_INFO" | while IFS='|' read -r url status; do ... done
find_all_states_with_status() {
  local wanted_status="$1"
  local found=false
  while IFS= read -r f; do
    local status
    status=$(grep -E '^STATUS=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ "$status" = "$wanted_status" ]; then
      local pr_url
      pr_url=$(grep -E '^PR_URL=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
      echo "$pr_url|$status"
      found=true
    fi
  done < <(list_state_files_for_current_worktree)
  if [ "$found" = true ]; then return 0; else return 1; fi
}

# Clear ALL state files matching a given STATUS for the current branch (kaizen #279).
# Returns 0 if any files were cleared, 1 if none found.
#
# Usage:
#   clear_all_states_with_status "needs_post_merge"
clear_all_states_with_status() {
  local wanted_status="$1"
  local cleared=false
  while IFS= read -r f; do
    local status
    status=$(grep -E '^STATUS=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ "$status" = "$wanted_status" ]; then
      rm -f "$f" 2>/dev/null
      cleared=true
    fi
  done < <(list_state_files_for_current_worktree)
  if [ "$cleared" = true ]; then return 0; else return 1; fi
}

# Cross-branch state lookup (kaizen #239, #125):
# When an agent ACTIVELY submits a declaration (KAIZEN_IMPEDIMENTS,
# KAIZEN_NO_ACTION, /kaizen), the current branch may differ from the
# branch where the state was created (e.g., PR created in worktree A,
# reflection submitted from worktree B). These functions skip branch
# filtering but still enforce staleness checks.
#
# Use these ONLY for active agent declarations — passive enforcement
# hooks must still use the branch-scoped variants to prevent
# cross-worktree contamination.

# List state files checking staleness but NOT branch.
list_state_files_any_branch() {
  local now
  now=$(date +%s)
  for f in "$STATE_DIR"/*; do
    [ -f "$f" ] || continue
    # Skip stale state files
    local mtime
    mtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo "0")
    local age=$(( now - mtime ))
    if [ "$age" -gt "$MAX_STATE_AGE" ]; then
      continue
    fi
    # Skip files without BRANCH (legacy)
    local file_branch
    file_branch=$(grep -E '^BRANCH=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ -z "$file_branch" ]; then
      continue
    fi
    echo "$f"
  done
}

# Find state with given STATUS across all branches (not branch-scoped).
# Outputs "PR_URL|STATUS" on success, returns 1 if none found.
find_state_with_status_any_branch() {
  local wanted_status="$1"
  while IFS= read -r f; do
    local status
    status=$(grep -E '^STATUS=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ "$status" = "$wanted_status" ]; then
      local pr_url
      pr_url=$(grep -E '^PR_URL=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
      echo "$pr_url|$status"
      return 0
    fi
  done < <(list_state_files_any_branch)
  return 1
}

# Clear state with given STATUS across all branches (not branch-scoped).
# Returns 0 if a file was cleared, 1 if none found.
clear_state_with_status_any_branch() {
  local wanted_status="$1"
  while IFS= read -r f; do
    local status
    status=$(grep -E '^STATUS=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ "$status" = "$wanted_status" ]; then
      rm -f "$f" 2>/dev/null
      return 0
    fi
  done < <(list_state_files_any_branch)
  return 1
}

# Auto-close kaizen issues referenced in a merged PR (kaizen #283).
# Parses PR body for Garsson-io/kaizen#NNN references, closes any that are open.
# Only runs for MERGED PRs — safe to call for any PR state.
#
# Usage:
#   auto_close_kaizen_issues "$PR_URL"
auto_close_kaizen_issues() {
  local pr_url="$1"
  [ -z "$pr_url" ] && return 0

  # Extract repo and PR number
  local pr_num repo
  pr_num=$(echo "$pr_url" | grep -oE '[0-9]+$')
  repo=$(echo "$pr_url" | sed -n 's|https://github.com/\([^/]*/[^/]*\)/pull/.*|\1|p')
  [ -z "$pr_num" ] || [ -z "$repo" ] && return 0

  # Check PR state — only auto-close for merged PRs
  local pr_state
  pr_state=$(gh pr view "$pr_num" --repo "$repo" --json state --jq .state 2>/dev/null)
  if [ "$pr_state" != "MERGED" ]; then
    return 0
  fi

  # Get PR body and extract kaizen issue references
  local pr_body
  pr_body=$(gh pr view "$pr_num" --repo "$repo" --json body --jq .body 2>/dev/null)
  [ -z "$pr_body" ] && return 0

  # Match patterns: Garsson-io/kaizen#NNN, kaizen/issues/NNN, Closes #NNN (in kaizen context)
  local issue_nums
  issue_nums=$(echo "$pr_body" | grep -oP 'Garsson-io/kaizen[#/issues/]*\K[0-9]+' | sort -un)
  # Also match: Closes https://github.com/Garsson-io/kaizen/issues/NNN
  local url_issue_nums
  url_issue_nums=$(echo "$pr_body" | grep -oP 'https://github\.com/Garsson-io/kaizen/issues/\K[0-9]+' | sort -un)

  # Combine and deduplicate
  local all_issues
  all_issues=$(printf '%s\n%s' "$issue_nums" "$url_issue_nums" | sort -un | grep -v '^$')
  [ -z "$all_issues" ] && return 0

  local closed_count=0
  while IFS= read -r issue_num; do
    [ -z "$issue_num" ] && continue
    # Check if issue is still open
    local issue_state
    issue_state=$(gh issue view "$issue_num" --repo Garsson-io/kaizen --json state --jq .state 2>/dev/null)
    if [ "$issue_state" = "OPEN" ]; then
      gh issue close "$issue_num" --repo Garsson-io/kaizen \
        --comment "Auto-closed: implementing PR merged ($pr_url)" 2>/dev/null && \
        closed_count=$((closed_count + 1))
    fi
  done <<< "$all_issues"

  if [ "$closed_count" -gt 0 ]; then
    echo "Auto-closed $closed_count kaizen issue(s) referenced in $pr_url"
  fi
}
