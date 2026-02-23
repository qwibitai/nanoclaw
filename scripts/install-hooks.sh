#!/usr/bin/env bash
# Install git hooks by creating symlinks from .git/hooks/ to .claude/hooks/
# Run this after cloning or if hooks aren't firing.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$REPO_ROOT" ]]; then
    echo "Error: Not in a git repository"
    exit 1
fi

GIT_HOOKS_DIR="$REPO_ROOT/.git/hooks"
CLAUDE_HOOKS_DIR="$REPO_ROOT/.claude/hooks"

# post-merge hook
HOOK_SOURCE="$CLAUDE_HOOKS_DIR/post-merge.sh"
HOOK_TARGET="$GIT_HOOKS_DIR/post-merge"

if [[ -f "$HOOK_SOURCE" ]]; then
    ln -sf "../../.claude/hooks/post-merge.sh" "$HOOK_TARGET"
    chmod +x "$HOOK_SOURCE"
    echo "Installed: post-merge → .claude/hooks/post-merge.sh"
else
    echo "Warning: $HOOK_SOURCE not found, skipping"
fi

echo "Done. Git hooks installed."
