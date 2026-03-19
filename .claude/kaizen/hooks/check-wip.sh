#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# check-wip.sh — SessionStart hook
# Detects in-progress work when starting a new session in the main checkout.
# Only fires in main checkout (not in worktrees).
# Outputs a reminder so the agent is aware of existing WIP.
# Also warns strongly when running on main — agents should use worktrees.

# Only run in main checkout, not worktrees
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
if [ "$GIT_COMMON" != ".git" ]; then
  exit 0
fi

# Strong warning: you're on the main checkout, not a worktree
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
cat <<'WORKTREE_WARNING'
!! WARNING: Running in the MAIN checkout, NOT in an isolated worktree.
!! Multiple Claude instances on the main checkout WILL conflict.
!!
!! USE INSTEAD:
!!   claude-wt [args...]              — auto-creates isolated worktree
!!   claude-wt -p "fix the bug"       — headless with prompt
!!   claude-wt --safe                  — with permission prompts
!!
!! You MUST use EnterWorktree or claude-wt for any dev work.
WORKTREE_WARNING
echo ""

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

# Check for active cases linked to kaizen issues (via domain model CLI, not raw SQL)
KAIZEN_CASES=""
KAIZEN_COUNT=0
CLI_KAIZEN="node dist/cli-kaizen.js"
CASES_JSON=$($CLI_KAIZEN case-list --status suggested,backlog,active,blocked 2>/dev/null)
if [ -n "$CASES_JSON" ] && [ "$CASES_JSON" != "[]" ]; then
  KAIZEN_CASES=$(echo "$CASES_JSON" | node -e "
    const cases = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    cases.filter(c => c.github_issue).forEach(c =>
      console.log('kaizen #' + c.github_issue + ' → ' + c.name + ' (' + c.status + ')')
    );
  " 2>/dev/null)
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
