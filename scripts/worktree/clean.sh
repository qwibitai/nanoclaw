#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ticket=""
worktree_root="../worktrees"
force=0
delete_branches=0

usage() {
  cat <<'USAGE'
Usage: scripts/worktree/clean.sh --ticket <id> [options]

Removes impl/verify/review worktrees for a ticket.

Options:
  --root <path>         Worktree root directory (default: ../worktrees)
  --force               Force worktree removal
  --delete-branches     Delete corresponding local wt/* branches
  -h, --help            Show help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ticket)
      ticket="$2"
      shift 2
      ;;
    --root)
      worktree_root="$2"
      shift 2
      ;;
    --force)
      force=1
      shift
      ;;
    --delete-branches)
      delete_branches=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [ -z "$ticket" ]; then
  echo "--ticket is required"
  usage
  exit 1
fi

lanes=(impl verify review)
for lane in "${lanes[@]}"; do
  branch="wt/${ticket}-${lane}"
  path="$worktree_root/${ticket}-${lane}"

  if [ -d "$path" ]; then
    if [ "$force" -eq 1 ]; then
      git worktree remove --force "$path" || true
    else
      git worktree remove "$path" || true
    fi
    echo "removed: $path"
  fi

  if [ "$delete_branches" -eq 1 ]; then
    git branch -D "$branch" >/dev/null 2>&1 || true
    echo "branch removed: $branch"
  fi
done

git worktree prune >/dev/null 2>&1 || true

echo "worktree-clean: PASS"
