#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

AGENT=""
ISSUE_ID=""
QUERY=""
BACKGROUND_SYNC=1

usage() {
  cat <<'EOF'
Usage: scripts/workflow/session-start.sh --agent claude|codex [options] [query]

Runs the canonical session-start flow:
  1. qmd recall bootstrap
  2. work-control-plane sweep with startup enforcement
  3. workflow preflight checks

Options:
  --agent AGENT    Runtime agent: claude or codex
  --issue ID       Optional issue/ticket identifier passed to recall bootstrap
  --no-background-sync  Disable background qmd session sync when embeddings are pending
  -h, --help       Show help
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

get_pending_embeddings() {
  local status_output=""
  local pending=""

  status_output="$(qmd status 2>/dev/null || true)"
  pending="$(printf '%s\n' "$status_output" | awk '/^[[:space:]]*Pending:[[:space:]]*[0-9]+/{print $2; exit}')"

  if [[ -z "$pending" || ! "$pending" =~ ^[0-9]+$ ]]; then
    echo "0"
    return 0
  fi

  echo "$pending"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      AGENT="${2:-}"
      shift 2
      ;;
    --issue)
      ISSUE_ID="${2:-}"
      shift 2
      ;;
    --no-background-sync)
      BACKGROUND_SYNC=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$QUERY" ]]; then
        echo "Only one optional query argument is supported." >&2
        usage >&2
        exit 2
      fi
      QUERY="$1"
      shift
      ;;
  esac
done

if [[ "$AGENT" != "claude" && "$AGENT" != "codex" ]]; then
  echo "Error: --agent must be 'claude' or 'codex'" >&2
  usage >&2
  exit 2
fi

require_cmd bash
require_cmd qmd
require_cmd git

echo "== Session Start (${AGENT}) =="
echo "repo: $ROOT_DIR"
echo ""

RECALL_CMD=(bash scripts/qmd-context-recall.sh --bootstrap)
if [[ -n "$ISSUE_ID" ]]; then
  RECALL_CMD+=(--issue "$ISSUE_ID")
fi
if [[ -n "$QUERY" ]]; then
  RECALL_CMD+=("$QUERY")
fi

"${RECALL_CMD[@]}"
echo ""

bash scripts/workflow/platform-loop-worktree-hygiene.sh
echo ""

PENDING_EMBEDDINGS="$(get_pending_embeddings)"
if [[ "$PENDING_EMBEDDINGS" -gt 0 ]]; then
  echo "RECALL QUALITY WARNING: ${PENDING_EMBEDDINGS} QMD document(s) still need embeddings."
  BACKGROUND_SYNC_FLAG="${SESSION_SYNC_BACKGROUND:-$BACKGROUND_SYNC}"
  if [[ "$BACKGROUND_SYNC_FLAG" == "1" ]]; then
    TS="$(date -u +%Y%m%dT%H%M%SZ)"
    SYNC_LOG="logs/qmd-session-sync-${TS}.log"
    SYNC_STATUS="logs/qmd-session-sync-${TS}.status"
    mkdir -p logs
    echo "Starting background session sync (monitor lane) for embeddings refresh."
    echo "running" >"$SYNC_STATUS"
    (
      if bash scripts/qmd-session-sync.sh >"$SYNC_LOG" 2>&1; then
        echo "ok" >"$SYNC_STATUS"
      else
        echo "fail" >"$SYNC_STATUS"
      fi
    ) &
    echo "Background session sync running (pid $!)."
    echo "Log: $SYNC_LOG"
    echo "Status: $SYNC_STATUS"
  else
    echo "Recommended refresh before deep resume/debug work:"
    echo "  bash scripts/qmd-session-sync.sh"
  fi
  echo ""
fi

CONTROL_PLANE="$(node scripts/workflow/work-control-plane.js)"
echo "Work control plane: $CONTROL_PLANE"
echo ""

if bash scripts/workflow/work-sweep.sh --agent "$AGENT" --fail-on-action-items; then
  :
else
  status=$?
  if [[ "$status" -eq 3 ]]; then
    echo "session-start: BLOCKED by required work-control-plane actions."
  else
    echo "session-start: FAILED during work-control-plane sweep." >&2
  fi
  exit "$status"
fi
echo ""

bash scripts/workflow/preflight.sh --skip-recall
echo ""
echo "session-start: PASS"
echo "Next: apply docs/workflow/docs-discipline/skill-routing-preflight.md for the current task intent."
