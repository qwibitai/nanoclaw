#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ticket=""
goal=""
scope=""
constraints=""
acceptance=""

usage() {
  cat <<'USAGE'
Usage: scripts/workflow/plan-lock.sh --ticket <id> --goal <text> [options]

Creates a decision-complete plan lock artifact shared by Claude and Codex workflows.

Options:
  --scope <text>         Optional scoped boundaries
  --constraints <text>   Optional key constraints
  --acceptance <text>    Optional acceptance summary
  -h, --help             Show help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ticket)
      ticket="$2"
      shift 2
      ;;
    --goal)
      goal="$2"
      shift 2
      ;;
    --scope)
      scope="$2"
      shift 2
      ;;
    --constraints)
      constraints="$2"
      shift 2
      ;;
    --acceptance)
      acceptance="$2"
      shift 2
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

if [ -z "$ticket" ] || [ -z "$goal" ]; then
  echo "--ticket and --goal are required"
  usage
  exit 1
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
out_dir="data/diagnostics/workflow"
out_file="$out_dir/plan-lock-${ticket}-${ts}.md"
mkdir -p "$out_dir"

cat >"$out_file" <<PLAN
# Plan Lock: ${ticket}

## Goal
${goal}

## Scope
${scope:-<define in implementation thread before coding>}

## Constraints and Invariants
${constraints:-<list runtime/security/contract boundaries>}

## Acceptance Criteria
${acceptance:-<list deterministic pass/fail checks>}

## Evidence Plan
1. Workflow contract check: bash scripts/check-workflow-contracts.sh
2. Mirror check: bash scripts/check-claude-codex-mirror.sh
3. Tooling governance check: bash scripts/check-tooling-governance.sh
4. Acceptance gate: bash scripts/jarvis-ops.sh acceptance-gate

## Rollback Plan
<explicit rollback path>
PLAN

echo "plan-lock artifact: $out_file"
