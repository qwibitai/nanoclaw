#!/usr/bin/env bash
set -euo pipefail

# qmd-session-sync.sh
# Sync Claude/Codex session exports, refresh QMD index, then git add + git commit exports.
#
# Usage:
#   scripts/qmd-session-sync.sh
#   scripts/qmd-session-sync.sh --days 30
#   scripts/qmd-session-sync.sh --message "chore(sync): update session exports"
#
# Env overrides:
#   QMD_BIN, SYNC_TOOL, SESSION_EXPORT_DIR, CODEX_DAYS, QCTX_OBSIDIAN_ROOT

QMD_BIN="${QMD_BIN:-qmd}"
SYNC_TOOL="${SYNC_TOOL:-$HOME/.claude/skills/sync-claude-sessions/scripts/claude-sessions}"
SESSION_EXPORT_DIR="${SESSION_EXPORT_DIR:-$HOME/Documents/remote-claude/Obsidian/Claude-Sessions}"
CODEX_DAYS="${CODEX_DAYS:-21}"
QCTX_OBSIDIAN_ROOT="${QCTX_OBSIDIAN_ROOT:-$HOME/Documents/remote-claude/Obsidian}"
COMMIT_MESSAGE=""

usage() {
  cat <<'EOF'
Usage:
  qmd-session-sync.sh [options]

Options:
  --days N          Codex export lookback window in days (default: 21)
  --message TEXT    Commit message override
  -h, --help        Show this help
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

canonical_path() {
  python3 - "$1" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
}

enforce_export_path_guard() {
  local allowed_root=""
  local export_dir=""

  allowed_root="$(canonical_path "$QCTX_OBSIDIAN_ROOT")"
  export_dir="$(canonical_path "$SESSION_EXPORT_DIR")"

  case "$export_dir" in
    "$allowed_root"|"$allowed_root"/*)
      return 0
      ;;
    *)
      echo "Invalid SESSION_EXPORT_DIR: $SESSION_EXPORT_DIR" >&2
      echo "Policy requires exports under: $allowed_root" >&2
      echo "Set SESSION_EXPORT_DIR inside that root (recommended: $allowed_root/Claude-Sessions)." >&2
      exit 2
      ;;
  esac
}

sync_sessions() {
  local vault_dir=""
  vault_dir="$(cd -- "$(dirname -- "$SESSION_EXPORT_DIR")" && pwd -P)"

  if [[ ! -f "$SYNC_TOOL" ]]; then
    echo "Sync tool not found at: $SYNC_TOOL" >&2
    exit 2
  fi

  echo "Syncing Claude sessions (today)..."
  VAULT_DIR="$vault_dir" python3 "$SYNC_TOOL" export --today

  echo "Syncing Codex sessions (last ${CODEX_DAYS} days)..."
  VAULT_DIR="$vault_dir" python3 "$SYNC_TOOL" codex-export --days "$CODEX_DAYS" --output "$SESSION_EXPORT_DIR"

  echo "Refreshing QMD index..."
  "$QMD_BIN" update

  embed_if_pending
}

get_pending_embeddings() {
  local status_output=""
  local pending=""

  status_output="$("$QMD_BIN" status 2>/dev/null || true)"
  pending="$(printf '%s\n' "$status_output" | awk '/^[[:space:]]*Pending:[[:space:]]*[0-9]+/{print $2; exit}')"

  if [[ -z "$pending" || ! "$pending" =~ ^[0-9]+$ ]]; then
    echo "0"
    return 0
  fi

  echo "$pending"
}

embed_if_pending() {
  local pending="0"
  pending="$(get_pending_embeddings)"

  if (( pending > 0 )); then
    echo "Embedding pending QMD vectors: $pending"
    "$QMD_BIN" embed
  else
    echo "No pending QMD embeddings."
  fi
}

commit_exports() {
  local repo_root=""
  local rel_export_dir=""
  local commit_msg=""

  repo_root="$(git -C "$SESSION_EXPORT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -z "$repo_root" ]]; then
    echo "Session export path is not inside a git repo: $SESSION_EXPORT_DIR" >&2
    exit 2
  fi

  rel_export_dir="$(
    python3 - "$repo_root" "$SESSION_EXPORT_DIR" <<'PY'
from pathlib import Path
import sys
repo = Path(sys.argv[1]).resolve(strict=False)
export = Path(sys.argv[2]).resolve(strict=False)
try:
    print(export.relative_to(repo))
except Exception:
    print("")
PY
  )"

  if [[ -z "$rel_export_dir" ]]; then
    echo "Unable to map export directory into git repo root." >&2
    echo "  repo:   $repo_root" >&2
    echo "  export: $SESSION_EXPORT_DIR" >&2
    exit 2
  fi

  echo "Staging export changes: $rel_export_dir"
  git -C "$repo_root" add -- "$rel_export_dir"

  if git -C "$repo_root" diff --cached --quiet -- "$rel_export_dir"; then
    echo "No export changes to commit."
    return 0
  fi

  if [[ -n "$COMMIT_MESSAGE" ]]; then
    commit_msg="$COMMIT_MESSAGE"
  else
    commit_msg="chore(sync): update Claude/Codex session exports ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  fi

  git -C "$repo_root" commit -m "$commit_msg" -- "$rel_export_dir"
  echo "Committed export changes in: $repo_root"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)
      CODEX_DAYS="${2:-}"
      shift 2
      ;;
    --message)
      COMMIT_MESSAGE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_cmd python3
require_cmd git
require_cmd "$QMD_BIN"
enforce_export_path_guard
sync_sessions
commit_exports
