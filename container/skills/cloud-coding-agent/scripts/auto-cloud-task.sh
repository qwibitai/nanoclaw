#!/bin/bash
# auto-cloud-task.sh - Route tasks to appropriate cloud coding provider
#
# Usage:
#   auto-cloud-task.sh "Your task description" [provider]
#
# Providers:
#   codex  - Use Codex cloud (default, better for PR creation)
#   claude - Use Claude Code cloud (better for review-before-commit)
#
# Environment variables:
#   CODEX_ENV - Codex environment name (default: "default")

set -euo pipefail

TASK="${1:-}"
PROVIDER="${2:-codex}"

if [ -z "$TASK" ]; then
    echo "Usage: $0 \"task description\" [provider]"
    echo ""
    echo "Providers: codex (default), claude"
    exit 1
fi

case "$PROVIDER" in
    codex)
        if [ -n "${CODEX_ENV:-}" ]; then
            echo "Submitting to Codex cloud (env: $CODEX_ENV)..."
            codex cloud exec --env "$CODEX_ENV" "$TASK"
            echo ""
            echo "Monitor with: codex cloud status"
            echo "Apply results with: codex cloud apply"
        else
            echo "Running Codex locally with --full-auto..."
            codex exec --full-auto "$TASK"
        fi
        ;;
    claude)
        echo "Submitting to Claude Code cloud..."
        claude --remote "$TASK"
        echo ""
        echo "Monitor at: https://claude.ai/code"
        echo "Teleport back with: claude --teleport"
        ;;
    *)
        echo "Unknown provider: $PROVIDER"
        echo "Valid providers: codex, claude"
        exit 1
        ;;
esac
