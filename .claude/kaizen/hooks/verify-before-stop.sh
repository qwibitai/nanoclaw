#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# verify-before-stop.sh — Level 2 kaizen enforcement
# Runs when Claude Code agent finishes. Checks if source files were
# modified and verifies they compile and tests pass.
#
# Exit 0 = allow stop
# Exit 2 = block stop (agent must fix issues first)

set -euo pipefail

# Check if any TypeScript source files were modified (staged or unstaged)
CHANGED_TS=$(git diff --name-only HEAD 2>/dev/null | grep '\.ts$' || true)
STAGED_TS=$(git diff --cached --name-only 2>/dev/null | grep '\.ts$' || true)

if [ -z "$CHANGED_TS" ] && [ -z "$STAGED_TS" ]; then
  # No TypeScript changes — nothing to verify
  exit 0
fi

echo "🔍 Verifying modified TypeScript files..." >&2

# Type-check
if ! npx tsc --noEmit 2>&1; then
  echo "❌ TypeScript type-check failed. Fix errors before finishing." >&2
  exit 2
fi

# Run tests if they exist
if [ -f "vitest.config.ts" ] || [ -f "vitest.config.js" ]; then
  if ! npx vitest run --reporter=verbose 2>&1; then
    echo "❌ Tests failed. Fix failing tests before finishing." >&2
    exit 2
  fi
fi

echo "✅ Type-check and tests passed." >&2
exit 0
