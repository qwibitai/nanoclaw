#!/bin/bash
# claude-wt — Launch Claude Code in an isolated git worktree
#
# Uses claude's built-in -w flag to create a worktree, run a session,
# and clean up on exit if no changes were made.
#
# Usage:
#   claude-wt [claude args...]          # interactive, auto-skips permissions
#   claude-wt -p "fix the bug"          # headless with prompt (-p is claude's --prompt flag)
#   claude-wt --safe                    # DON'T skip permissions (ask for each tool)
#
# By default, --dangerously-skip-permissions is passed to claude because
# the worktree is isolated — no risk to the main checkout.
#
# Install as alias:
#   alias claude-wt='/path/to/nanoclaw/scripts/claude-wt.sh'

set -euo pipefail

CLAUDE_WT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Arg parsing — separated for testability (see test-claude-wt.sh)
parse_claude_wt_args() {
  SKIP_PERMISSIONS=true
  CLAUDE_ARGS=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help)
        cat <<'USAGE'
claude-wt — Launch Claude Code in an isolated git worktree

Usage: claude-wt [options] [claude args...]

Options:
  --safe            Don't skip permissions (ask for each tool)
  --help            Show this help

All other arguments are passed through to claude.
By default, --dangerously-skip-permissions is added (safe: worktree is isolated).
Uses claude's built-in -w flag for worktree management.

Examples:
  claude-wt                          # interactive session
  claude-wt -p "fix the bug"        # headless with prompt
  claude-wt --safe                   # with permission prompts
USAGE
        exit 0
        ;;
      --safe)
        SKIP_PERMISSIONS=false
        shift
        ;;
      *)
        CLAUDE_ARGS+=("$1")
        shift
        ;;
    esac
  done

  # Add --dangerously-skip-permissions by default (worktree is isolated)
  if [ "$SKIP_PERMISSIONS" = true ]; then
    CLAUDE_ARGS=("--dangerously-skip-permissions" "${CLAUDE_ARGS[@]}")
  fi
}

# Allow sourcing for tests without executing main.
# When sourced for testing, don't impose set -e on the caller.
if [[ "${CLAUDE_WT_TEST:-}" = "1" ]]; then
  set +e
  return 0 2>/dev/null || true
fi

parse_claude_wt_args "$@"

# Advisory disk usage report before creating a new worktree.
# Analysis only — never auto-cleans. Other Claude instances may be active in worktrees.
if [ -x "$CLAUDE_WT_DIR/worktree-du.sh" ]; then
  "$CLAUDE_WT_DIR/worktree-du.sh" analyze --fast
fi

# Generate nonce for worktree name (YYMMDD-HHMM-random)
NONCE=$(date +%y%m%d-%H%M)-$(printf '%04x' $RANDOM)

# Run claude with -w (Claude handles worktree creation and cleanup)
echo "Starting Claude with worktree: ${NONCE}"
echo ""
claude -w "${NONCE}" "${CLAUDE_ARGS[@]}"
