#!/bin/bash
# check-wip.sh — SessionStart hook
# Detects in-progress work when starting a new session in the main checkout.
# Only fires in main checkout (not in worktrees).
# Outputs a reminder so the agent is aware of existing WIP.

# Only run in main checkout, not worktrees
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
if [ "$GIT_COMMON" != ".git" ]; then
  exit 0
fi

# Collect worktrees (excluding main)
WORKTREES=$(git worktree list --porcelain | grep '^worktree ' | grep -v "$(git rev-parse --show-toplevel)$" | sed 's/^worktree //')
WORKTREE_COUNT=$(echo "$WORKTREES" | grep -c . 2>/dev/null || echo 0)
if [ -z "$WORKTREES" ]; then
  WORKTREE_COUNT=0
fi

# Collect open PRs (fast, cached by gh)
PR_COUNT=0
PR_LIST=""
if command -v gh &>/dev/null; then
  PR_LIST=$(gh pr list --repo Garsson-io/nanoclaw --state open --json number,title,headBranch --template '{{range .}}#{{.number}} {{.title}} ({{.headBranch}}){{"\n"}}{{end}}' 2>/dev/null)
  if [ -n "$PR_LIST" ]; then
    PR_COUNT=$(echo "$PR_LIST" | grep -c . 2>/dev/null || echo 0)
  fi
fi

# Collect unmerged branches
UNMERGED=$(git branch --no-merged main 2>/dev/null | grep -v '^\*' | sed 's/^  //')
UNMERGED_COUNT=0
if [ -n "$UNMERGED" ]; then
  UNMERGED_COUNT=$(echo "$UNMERGED" | grep -c . 2>/dev/null || echo 0)
fi

# Check for active cases linked to kaizen issues
KAIZEN_CASES=""
KAIZEN_COUNT=0
DB_PATH="data/nanoclaw.db"
if [ -f "$DB_PATH" ]; then
  KAIZEN_CASES=$(sqlite3 "$DB_PATH" "SELECT 'kaizen #' || github_issue || ' → ' || name || ' (' || status || ')' FROM cases WHERE github_issue IS NOT NULL AND status IN ('suggested','backlog','active','blocked') ORDER BY github_issue" 2>/dev/null)
  if [ -n "$KAIZEN_CASES" ]; then
    KAIZEN_COUNT=$(echo "$KAIZEN_CASES" | grep -c . 2>/dev/null || echo 0)
  fi
fi

# If nothing in progress, stay quiet
TOTAL=$((WORKTREE_COUNT + PR_COUNT + UNMERGED_COUNT + KAIZEN_COUNT))
if [ "$TOTAL" -eq 0 ]; then
  exit 0
fi

# Build summary
echo "⚠️ Found in-progress work:"
echo ""

if [ "$WORKTREE_COUNT" -gt 0 ]; then
  echo "Worktrees ($WORKTREE_COUNT):"
  echo "$WORKTREES" | while read -r wt; do
    BRANCH=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    DIRTY=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    if [ "$DIRTY" -gt 0 ]; then
      echo "  - $BRANCH ($DIRTY dirty files) → $wt"
    else
      echo "  - $BRANCH (clean) → $wt"
    fi
  done
  echo ""
fi

if [ "$PR_COUNT" -gt 0 ]; then
  echo "Open PRs ($PR_COUNT):"
  echo "$PR_LIST" | while read -r pr; do
    echo "  - $pr"
  done
  echo ""
fi

if [ "$UNMERGED_COUNT" -gt 0 ]; then
  echo "Unmerged branches ($UNMERGED_COUNT):"
  echo "$UNMERGED" | while read -r br; do
    echo "  - $br"
  done
  echo ""
fi

if [ "$KAIZEN_COUNT" -gt 0 ]; then
  echo "Kaizen issues with active cases ($KAIZEN_COUNT):"
  echo "$KAIZEN_CASES" | while read -r kc; do
    echo "  - $kc"
  done
  echo ""
fi

echo "Run /wip for full details, or pick up existing work before starting new."
