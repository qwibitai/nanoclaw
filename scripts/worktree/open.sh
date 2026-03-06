#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ticket=""
base_branch="main"
worktree_root="../worktrees"
force=0

usage() {
  cat <<'USAGE'
Usage: scripts/worktree/open.sh --ticket <id> [options]

Creates balanced parallel worktrees for impl/verify/review lanes.

Options:
  --base <branch>   Base branch (default: main)
  --root <path>     Worktree root directory (default: ../worktrees)
  --force           Remove existing lane worktrees before creating
  -h, --help        Show help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ticket)
      ticket="$2"
      shift 2
      ;;
    --base)
      base_branch="$2"
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

mkdir -p "$worktree_root"

lanes=(impl verify review)
for lane in "${lanes[@]}"; do
  branch="wt/${ticket}-${lane}"
  path="$worktree_root/${ticket}-${lane}"

  if [ -d "$path" ] && [ "$force" -eq 1 ]; then
    git worktree remove --force "$path" >/dev/null 2>&1 || true
  fi

  if [ -d "$path" ]; then
    echo "exists: $path"
    continue
  fi

  if git rev-parse --verify --quiet "refs/heads/${branch}" >/dev/null; then
    git worktree add "$path" "$branch"
  else
    git worktree add "$path" -b "$branch" "$base_branch"
  fi

echo "created: $path ($branch)"
done

echo "worktree-open: PASS"
