#!/usr/bin/env bash
set -euo pipefail
THIS_DIR="$(cd "$(dirname "$0")" && pwd)"
WT="$THIS_DIR/../bin/codex-worktree"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# set up a throwaway repo
cd "$TMP"
git init -q repo && cd repo
git config user.email "t@t.t"; git config user.name "t"
echo a > a.txt
git add a.txt && git commit -qm init
git checkout -qb testbase

# setup a worktree for task 1
"$WT" setup "$TMP/work/myplan" task-alpha testbase
test -d "$TMP/work/myplan/task-alpha" || { echo "FAIL: no worktree dir"; exit 1; }
cd "$TMP/work/myplan/task-alpha"
branch="$(git branch --show-current)"
[ "$branch" = "codex/myplan/task-alpha" ] || { echo "FAIL: wrong branch=$branch"; exit 1; }

# commit something in the worktree
echo b > b.txt
git add b.txt && git commit -qm "add b"

# teardown
cd "$TMP/repo"
"$WT" teardown "$TMP/work/myplan" task-alpha
test ! -d "$TMP/work/myplan/task-alpha" || { echo "FAIL: worktree remains"; exit 1; }
# branch also deleted
git rev-parse --verify codex/myplan/task-alpha 2>/dev/null && { echo "FAIL: branch remains"; exit 1; } || true

echo "PASS: test-worktree"
