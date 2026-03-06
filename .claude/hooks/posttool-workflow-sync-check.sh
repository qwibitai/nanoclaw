#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# Consume hook payload (unused for now, but keeps hook protocol compatibility).
cat >/dev/null || true

changed="$(git diff --name-only 2>/dev/null || true)"

if printf '%s\n' "$changed" | rg -q '^(CLAUDE\.md|AGENTS\.md|docs/workflow/|docs/operations/|\.codex/config\.toml|\.codex/agents/|\.claude/settings\.local\.json|\.claude/hooks/|scripts/check-tooling-governance\.sh)'; then
  workflow_out=""
  mirror_out=""
  tooling_out=""
  workflow_rc=0
  mirror_rc=0
  tooling_rc=0

  workflow_out="$(bash scripts/check-workflow-contracts.sh 2>&1)" || workflow_rc=$?
  mirror_out="$(bash scripts/check-claude-codex-mirror.sh 2>&1)" || mirror_rc=$?
  tooling_out="$(bash scripts/check-tooling-governance.sh 2>&1)" || tooling_rc=$?

  if [ "$workflow_rc" -ne 0 ] || [ "$mirror_rc" -ne 0 ] || [ "$tooling_rc" -ne 0 ]; then
    echo "posttool warning: workflow/mirror/tooling checks are failing after edits" >&2
    [ -n "$workflow_out" ] && echo "$workflow_out" >&2
    [ -n "$mirror_out" ] && echo "$mirror_out" >&2
    [ -n "$tooling_out" ] && echo "$tooling_out" >&2

    # Warn by default. Set WORKFLOW_HOOK_STRICT=1 to hard-block.
    if [ "${WORKFLOW_HOOK_STRICT:-0}" = "1" ]; then
      exit 2
    fi
  fi
fi

exit 0
