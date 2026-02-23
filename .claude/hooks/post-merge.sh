#!/usr/bin/env bash
# Post-merge hook: queues knowledge updates when feature branches are merged.
# Symlinked from .git/hooks/post-merge → ../../.claude/hooks/post-merge.sh

set -euo pipefail

QUEUE_DIR="groups/main/ops/queue"

# Get the merge commit message
MERGE_MSG=$(git log -1 --pretty=%s HEAD)

# Detect feature branch merges (merge commits from PRs or manual merges)
# Skip fast-forward pulls (no merge commit) and regular pushes
BRANCH=""

# Pattern: "Merge pull request #N from user/branch-name"
if [[ "$MERGE_MSG" =~ Merge\ pull\ request\ #[0-9]+\ from\ [^/]+/(.+) ]]; then
    BRANCH="${BASH_REMATCH[1]}"
# Pattern: "Merge branch 'branch-name'"
elif [[ "$MERGE_MSG" =~ Merge\ branch\ \'([^\']+)\' ]]; then
    BRANCH="${BASH_REMATCH[1]}"
fi

# Skip if no feature branch detected or if it's just main/master
if [[ -z "$BRANCH" ]] || [[ "$BRANCH" == "main" ]] || [[ "$BRANCH" == "master" ]]; then
    exit 0
fi

# Create queue directory if needed
mkdir -p "$QUEUE_DIR"

# Generate queue entry filename
DATE=$(date -u +%Y-%m-%d)
SAFE_BRANCH=$(echo "$BRANCH" | tr '/' '-')
QUEUE_FILE="$QUEUE_DIR/${DATE}-${SAFE_BRANCH}.md"

# Get diff stats for the merge
DIFF_STAT=$(git diff --stat HEAD~1..HEAD 2>/dev/null || echo "Unable to generate diff stat")
FILES_CHANGED=$(git diff --name-only HEAD~1..HEAD 2>/dev/null || echo "Unable to list files")
MERGED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Write queue entry
cat > "$QUEUE_FILE" << EOF
---
type: knowledge-update
branch: ${BRANCH}
merged_at: ${MERGED_AT}
status: pending
---
## Diff Summary
${DIFF_STAT}

## Files Changed
${FILES_CHANGED}
EOF

echo "[Knowledge Queue] Queued update for branch: $BRANCH → $QUEUE_FILE"
