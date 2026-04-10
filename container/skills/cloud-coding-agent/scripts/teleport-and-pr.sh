#!/bin/bash
# teleport-and-pr.sh - Teleport Claude Code session and create PR
#
# Usage:
#   teleport-and-pr.sh [session-id] [--title "PR Title"] [--body "PR Body"]
#
# If session-id is omitted, opens interactive picker.
# If title/body omitted, uses defaults based on branch name.

set -euo pipefail

SESSION_ID=""
PR_TITLE=""
PR_BODY=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --title)
            PR_TITLE="$2"
            shift 2
            ;;
        --body)
            PR_BODY="$2"
            shift 2
            ;;
        *)
            if [ -z "$SESSION_ID" ]; then
                SESSION_ID="$1"
            fi
            shift
            ;;
    esac
done

echo "Step 1: Teleporting Claude Code session..."
if [ -n "$SESSION_ID" ]; then
    claude --teleport "$SESSION_ID"
else
    claude --teleport
fi

echo ""
echo "Step 2: Checking git status..."
git status

BRANCH=$(git branch --show-current)
echo ""
echo "Current branch: $BRANCH"

# Generate default title from branch name if not provided
if [ -z "$PR_TITLE" ]; then
    # Convert branch name to title (e.g., fix/auth-bug -> Fix auth bug)
    PR_TITLE=$(echo "$BRANCH" | sed 's/[-_]/ /g' | sed 's|.*/||' | sed 's/\b\w/\u&/')
fi

echo ""
echo "Step 3: Creating pull request..."
if [ -n "$PR_BODY" ]; then
    gh pr create --title "$PR_TITLE" --body "$PR_BODY"
else
    gh pr create --title "$PR_TITLE" --fill
fi

echo ""
echo "Done! PR created from teleported session."
