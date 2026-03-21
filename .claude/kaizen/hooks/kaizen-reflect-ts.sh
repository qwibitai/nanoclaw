#!/bin/bash
# Thin bash wrapper for kaizen-reflect.ts (TypeScript migration of kaizen-reflect.sh)
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# Migration: kaizen #320 (Phase 3 of #223)
#
# Claude Code hooks must be bash scripts. This wrapper delegates to the
# TypeScript implementation via npx tsx, passing stdin through.
#
# Always exits 0 — advisory hook (PostToolUse).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

exec npx tsx "$PROJECT_ROOT/src/hooks/kaizen-reflect.ts" 2>/dev/null

# If tsx fails, exit 0 (advisory hook — never block)
exit 0
