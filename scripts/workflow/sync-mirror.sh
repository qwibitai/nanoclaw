#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage: scripts/workflow/sync-mirror.sh [--strict]

Runs governance checks that ensure CLAUDE canonical policy, hooks/subagents/built-ins, and Codex/AGENTS mirrors stay in sync.

Options:
  --strict   Also run acceptance-gate baseline checks
  -h, --help Show help
USAGE
}

strict=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --strict)
      strict=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

bash scripts/check-workflow-contracts.sh
bash scripts/check-claude-codex-mirror.sh
bash scripts/check-tooling-governance.sh

if [ "$strict" -eq 1 ]; then
  bash scripts/jarvis-ops.sh acceptance-gate --skip-tests --skip-connectivity
fi

echo "sync-mirror: PASS"
