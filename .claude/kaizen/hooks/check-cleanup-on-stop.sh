#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# check-cleanup-on-stop.sh — Level 2 kaizen enforcement
# On session stop, warn about orphaned worktrees for the current branch.
# Also removes the lock file if present (prevents orphaned locks from Pattern 3).
# Does NOT block — just reminds. The auto-prune handles actual cleanup.
#
# Exit 0 = allow stop (always)

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

# Check if we're in a worktree (not the main checkout)
WORKTREE_DIR=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null || echo "")

# If in a worktree with uncommitted changes, warn
if [ "$GIT_COMMON_DIR" != ".git" ] && [ "$GIT_COMMON_DIR" != "" ]; then
  DIRTY=$(git status --porcelain 2>/dev/null | head -5)
  if [ -n "$DIRTY" ]; then
    echo "⚠️  Worktree '$BRANCH' has uncommitted changes:" >&2
    echo "$DIRTY" >&2
    echo "Consider committing or discarding before ending session." >&2
  fi

  # Check if branch has unpushed commits
  UNPUSHED=$(git log --oneline origin/"$BRANCH"..HEAD 2>/dev/null | wc -l || echo "0")
  if [ "$UNPUSHED" -gt 0 ] 2>/dev/null; then
    echo "⚠️  Branch '$BRANCH' has $UNPUSHED unpushed commit(s)." >&2
  fi

  # Remove lock file on session stop to prevent orphaned locks (kaizen #194).
  # This is defense-in-depth — even if the session crashes without reaching here,
  # the PID liveness check in worktree-du.sh will detect dead-PID locks.
  if [ -n "$WORKTREE_DIR" ] && [ -f "$WORKTREE_DIR/.worktree-lock.json" ]; then
    rm -f "$WORKTREE_DIR/.worktree-lock.json"
  fi
fi

# Always allow stop — this is advisory only
exit 0
