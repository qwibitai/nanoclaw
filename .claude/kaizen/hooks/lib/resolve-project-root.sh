#!/bin/bash
# resolve-project-root.sh — Shared project root resolution for TS hook wrappers.
# Source from wrappers: source "$(dirname "$0")/lib/resolve-project-root.sh"
#
# Provides: PROJECT_ROOT variable pointing to the git worktree root.
# Uses dirname-based resolution (works in worktrees, CI, and subprocesses).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
