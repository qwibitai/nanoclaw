#!/usr/bin/env bash
set -euo pipefail

ROOT="${NANOCLAW_ROOT:-/Users/ilansolot/nanoclaw-v2}"
LOG_DIR="${NANOCLAW_RESEARCH_LOG_DIR:-$ROOT/logs/research}"
LOCK_DIR="${TMPDIR:-/tmp}/nanoclaw-agentmail-sync-morning.lock"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    --help|-h)
      cat <<'EOF'
Usage:
  bash scripts/research/run-agentmail-sync-morning.sh
  bash scripts/research/run-agentmail-sync-morning.sh --dry-run

Environment:
  AGENTMAIL_SYNC_LIMIT  Defaults to 100
EOF
      exit 0
      ;;
  esac
done

mkdir -p "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(date -u +%FT%TZ) AgentMail morning sync already running; exiting"
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

cd "$ROOT"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "$(date -u +%FT%TZ) syncing AgentMail for morning inbox digest"
AGENTMAIL_ARGS=(--limit "${AGENTMAIL_SYNC_LIMIT:-100}")
if [[ "$DRY_RUN" -eq 1 ]]; then
  AGENTMAIL_ARGS+=(--dry-run)
fi

node scripts/research/ingest-agentmail.mjs "${AGENTMAIL_ARGS[@]}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "$(date -u +%FT%TZ) AgentMail morning sync dry-run complete"
else
  echo "$(date -u +%FT%TZ) AgentMail morning sync complete"
fi
