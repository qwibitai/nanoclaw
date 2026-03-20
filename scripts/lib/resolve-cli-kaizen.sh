#!/bin/bash
# resolve-cli-kaizen.sh — Resolve the best way to run cli-kaizen
#
# Solves the chicken-and-egg problem (kaizen #197): fresh worktrees don't have
# dist/ so `node dist/cli-kaizen.js` fails. This resolver tries tsx from source
# first (always fresh, no build needed), then falls back to compiled dist/.
#
# Usage (executable — preferred, one-liner):
#   CLI_KAIZEN=$("path/to/resolve-cli-kaizen.sh")                  # auto-detect worktree
#   CLI_KAIZEN=$("path/to/resolve-cli-kaizen.sh" "/path/to/root")  # explicit root
#   $CLI_KAIZEN case-list
#
# Usage (source then call — still supported):
#   source "path/to/resolve-cli-kaizen.sh"
#   CLI_KAIZEN=$(resolve_cli_kaizen "/path/to/project")
#   $CLI_KAIZEN case-list

# Resolve cli-kaizen executable for a given project root.
# Prints the command (space-separated) to stdout. Returns 1 if not found.
#
# Strategy order:
#   1. tsx from node_modules/.bin (direct, no npx overhead) + source .ts
#   2. node + compiled dist/cli-kaizen.js
resolve_cli_kaizen() {
  local project_root="${1:-.}"

  # Strategy 1: tsx from source (always fresh, works without build)
  local tsx_bin="$project_root/node_modules/.bin/tsx"
  local ts_source="$project_root/src/cli-kaizen.ts"
  if [ -x "$tsx_bin" ] && [ -f "$ts_source" ]; then
    echo "$tsx_bin $ts_source"
    return 0
  fi

  # Strategy 2: compiled dist/ (may be stale but works without tsx)
  local dist_js="$project_root/dist/cli-kaizen.js"
  if [ -f "$dist_js" ]; then
    echo "node $dist_js"
    return 0
  fi

  return 1
}

# Resolve cli-kaizen for use in a worktree context.
# Tries the current worktree first, then falls back to the main checkout.
# Prints the command to stdout. Returns 1 if neither works.
resolve_cli_kaizen_for_worktree() {
  local worktree_root
  worktree_root="$(git rev-parse --show-toplevel 2>/dev/null)"

  local main_root
  local git_common
  git_common="$(git rev-parse --git-common-dir 2>/dev/null)"
  if [ -n "$git_common" ] && [ "$git_common" != ".git" ]; then
    main_root="$(cd "$git_common/.." 2>/dev/null && pwd)"
  else
    main_root="$worktree_root"
  fi

  # Try worktree first (has latest source)
  if [ -n "$worktree_root" ] && resolve_cli_kaizen "$worktree_root"; then
    return 0
  fi

  # Fall back to main checkout
  if [ -n "$main_root" ] && [ "$main_root" != "$worktree_root" ] && resolve_cli_kaizen "$main_root"; then
    return 0
  fi

  return 1
}

# Main guard: when executed (not sourced), resolve and print the command.
# With arg: resolve_cli_kaizen "$1"
# Without arg: resolve_cli_kaizen_for_worktree (auto-detect)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [ -n "${1:-}" ]; then
    resolve_cli_kaizen "$1" || { echo "error: cannot resolve cli-kaizen in $1" >&2; exit 1; }
  else
    resolve_cli_kaizen_for_worktree || { echo "error: cannot resolve cli-kaizen (no worktree or main checkout found)" >&2; exit 1; }
  fi
fi
