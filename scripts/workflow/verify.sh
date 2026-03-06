#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

skip_contract_checks=0
with_weekend_prevention=0

usage() {
  cat <<'USAGE'
Usage: scripts/workflow/verify.sh [options] [-- acceptance-gate-args]

Runs deterministic workflow verification shared by Claude and Codex.

Options:
  --skip-contract-checks  Skip workflow + mirror + tooling governance checks
  --with-weekend-prevention
                          Run weekend prevention sweep (without duplicate preflight/acceptance) before acceptance-gate
  -h, --help              Show help

Any remaining args are forwarded to:
  bash scripts/jarvis-ops.sh acceptance-gate
USAGE
}

forward_args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-contract-checks)
      skip_contract_checks=1
      shift
      ;;
    --with-weekend-prevention)
      with_weekend_prevention=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do
        forward_args+=("$1")
        shift
      done
      ;;
    *)
      forward_args+=("$1")
      shift
      ;;
  esac
done

if [ "$skip_contract_checks" -eq 0 ]; then
  bash scripts/check-workflow-contracts.sh
  bash scripts/check-claude-codex-mirror.sh
  bash scripts/check-tooling-governance.sh
fi

if [ "$with_weekend_prevention" -eq 1 ]; then
  bash scripts/jarvis-ops.sh weekend-prevention \
    --skip-preflight \
    --skip-acceptance \
    --json-out data/diagnostics/weekend-prevention/latest-manifest.json \
    --summary-out data/diagnostics/weekend-prevention/latest-summary.md
fi

bash scripts/jarvis-ops.sh acceptance-gate "${forward_args[@]}"
