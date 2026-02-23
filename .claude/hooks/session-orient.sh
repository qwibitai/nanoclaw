#!/usr/bin/env bash
# SessionStart hook: checks for pending knowledge updates and alerts Claude.
# Referenced in .claude/settings.json hooks.SessionStart

QUEUE_DIR="groups/main/ops/queue"

# Skip if queue directory doesn't exist
if [[ ! -d "$QUEUE_DIR" ]]; then
    exit 0
fi

# Find pending entries
PENDING=()
for f in "$QUEUE_DIR"/*.md; do
    [[ -f "$f" ]] || continue
    if grep -q "status: pending" "$f" 2>/dev/null; then
        # Extract branch name from frontmatter
        BRANCH=$(grep "^branch:" "$f" | sed 's/branch: *//')
        if [[ -n "$BRANCH" ]]; then
            PENDING+=("$BRANCH")
        fi
    fi
done

# Output message if there are pending entries
if [[ ${#PENDING[@]} -gt 0 ]]; then
    echo "[Knowledge Update Pending] The following branches were merged since last session:"
    for b in "${PENDING[@]}"; do
        echo "  - $b"
    done
    echo "Run /review to update goals, create memory notes, and sync the knowledge index."
fi
