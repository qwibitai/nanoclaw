#!/usr/bin/env bash
set -euo pipefail

AGENT=""
FAIL_ON_ACTION_ITEMS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      AGENT="${2:-}"
      shift 2
      ;;
    --fail-on-action-items)
      FAIL_ON_ACTION_ITEMS=1
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$AGENT" != "claude" && "$AGENT" != "codex" ]]; then
  echo "Usage: $0 --agent claude|codex [--fail-on-action-items]" >&2
  exit 1
fi

CONTROL_PLANE="$(node scripts/workflow/work-control-plane.js)"

if [[ "$CONTROL_PLANE" != "linear" ]]; then
  echo "work-sweep: unsupported work control plane: $CONTROL_PLANE" >&2
  exit 1
fi

CMD=(node scripts/workflow/linear-work-sweep.js --agent "$AGENT")

if [[ "$FAIL_ON_ACTION_ITEMS" == "1" ]]; then
  CMD+=(--fail-on-action-items)
fi

"${CMD[@]}"
