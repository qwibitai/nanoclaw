#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

skip_recall=0
with_incident_status=0

usage() {
  cat <<'USAGE'
Usage: scripts/workflow/preflight.sh [options]

Runs workflow preflight checks shared by Claude and Codex execution.

Options:
  --skip-recall           Skip qmd context recall bootstrap
  --with-incident-status  Also print open incident status
  -h, --help              Show help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-recall)
      skip_recall=1
      shift
      ;;
    --with-incident-status)
      with_incident_status=1
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

echo "== Unified Workflow Preflight =="
echo "repo: $ROOT_DIR"

if [ "$skip_recall" -eq 0 ] && [ -x scripts/qmd-context-recall.sh ]; then
  bash scripts/qmd-context-recall.sh --bootstrap >/tmp/workflow-preflight-recall.log 2>&1 || {
    echo "[FAIL] recall bootstrap"
    cat /tmp/workflow-preflight-recall.log
    exit 1
  }
  echo "[PASS] recall bootstrap"
fi

bash scripts/check-workflow-contracts.sh
echo "[PASS] workflow contract check"

bash scripts/check-claude-codex-mirror.sh
echo "[PASS] claude/codex mirror check"

bash scripts/check-tooling-governance.sh
echo "[PASS] tooling governance check"

if [ "$with_incident_status" -eq 1 ]; then
  bash scripts/jarvis-ops.sh incident list --status open || true
fi

echo "preflight: PASS"
