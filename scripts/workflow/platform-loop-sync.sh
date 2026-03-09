#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKTREE_PATH="${NANOCLAW_PLATFORM_LOOP_WORKTREE:-$ROOT_DIR/.worktrees/platform-loop}"
WORKTREE_BRANCH="${NANOCLAW_PLATFORM_LOOP_BRANCH:-claude-platform-loop}"
BASE_BRANCH="${NANOCLAW_PLATFORM_LOOP_BASE_BRANCH:-main}"
REMOTE_NAME="${NANOCLAW_PLATFORM_LOOP_REMOTE:-origin}"
SOURCE_ROOT="${NANOCLAW_PLATFORM_LOOP_SOURCE_ROOT:-$ROOT_DIR}"
DRY_RUN=0

OVERLAY_FILES=(
  ".claude/commands/platform-pickup.md"
  "scripts/workflow/platform-loop.js"
  "scripts/workflow/platform-loop-sync.sh"
)

EXCLUDE_PATTERNS=(
  ".claude/commands/platform-pickup.md"
  ".claude/scheduled_tasks.lock"
  "scripts/workflow/platform-loop.js"
  "scripts/workflow/platform-loop-sync.sh"
)

usage() {
  cat <<'EOF'
Usage: platform-loop-sync.sh [--dry-run]

Refresh the dedicated Claude platform loop worktree from the configured remote/base
branch, then overlay the command/helper files from the source repo root.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but not found in PATH" >&2
  exit 1
fi

REMOTE_REF="${REMOTE_NAME}/${BASE_BRANCH}"

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "+ $*"
    return 0
  fi
  "$@"
}

ensure_clean_worktree() {
  local status_output
  status_output="$(git -C "$WORKTREE_PATH" status --porcelain --untracked-files=normal)"
  if [[ -n "$status_output" ]]; then
    echo "platform-loop-sync: refusing to reseed dirty worktree at $WORKTREE_PATH" >&2
    printf '%s\n' "$status_output" >&2
    exit 1
  fi
}

ensure_overlay_files() {
  local source_file target_file

  if [[ "$SOURCE_ROOT" == "$WORKTREE_PATH" ]]; then
    return 0
  fi

  for source_file in "${OVERLAY_FILES[@]}"; do
    target_file="$WORKTREE_PATH/$source_file"
    if [[ ! -f "$SOURCE_ROOT/$source_file" ]]; then
      echo "platform-loop-sync: missing overlay source $SOURCE_ROOT/$source_file" >&2
      exit 1
    fi
    run_cmd mkdir -p "$(dirname "$target_file")"
    run_cmd cp "$SOURCE_ROOT/$source_file" "$target_file"
  done
}

ensure_exclude_patterns() {
  local exclude_file pattern

  if [[ "$DRY_RUN" == "1" ]]; then
    for pattern in "${EXCLUDE_PATTERNS[@]}"; do
      echo "+ exclude $pattern"
    done
    return 0
  fi

  exclude_file="$(git -C "$WORKTREE_PATH" rev-parse --git-path info/exclude)"
  mkdir -p "$(dirname "$exclude_file")"
  for pattern in "${EXCLUDE_PATTERNS[@]}"; do
    if ! grep -Fqx "$pattern" "$exclude_file" 2>/dev/null; then
      echo "$pattern" >>"$exclude_file"
    fi
  done
}

if [[ "$DRY_RUN" == "1" ]]; then
  echo "platform-loop-sync: dry-run"
  echo "platform-loop-sync: source_root=$SOURCE_ROOT"
  echo "platform-loop-sync: worktree_path=$WORKTREE_PATH"
  echo "platform-loop-sync: remote_ref=$REMOTE_REF"
  if [[ -d "$WORKTREE_PATH" ]]; then
    echo "platform-loop-sync: would verify clean worktree"
    echo "+ git -C $WORKTREE_PATH checkout -B $WORKTREE_BRANCH $REMOTE_REF"
  else
    echo "+ mkdir -p $(dirname "$WORKTREE_PATH")"
    echo "+ git -C $ROOT_DIR worktree add -B $WORKTREE_BRANCH $WORKTREE_PATH $REMOTE_REF"
  fi
  ensure_overlay_files
  ensure_exclude_patterns
  exit 0
fi

git -C "$ROOT_DIR" fetch --prune "$REMOTE_NAME" "$BASE_BRANCH"
if ! git -C "$ROOT_DIR" rev-parse --verify "${REMOTE_REF}^{commit}" >/dev/null 2>&1; then
  echo "platform-loop-sync: unable to resolve $REMOTE_REF after fetch" >&2
  exit 1
fi

if [[ ! -d "$WORKTREE_PATH" ]]; then
  mkdir -p "$(dirname "$WORKTREE_PATH")"
  git -C "$ROOT_DIR" worktree add -B "$WORKTREE_BRANCH" "$WORKTREE_PATH" "$REMOTE_REF"
else
  ensure_clean_worktree
fi

# The dedicated loop branch is disposable control state and should always point
# at the latest fetched base before Claude creates an issue branch.
git -C "$WORKTREE_PATH" checkout -B "$WORKTREE_BRANCH" "$REMOTE_REF"

ensure_overlay_files
ensure_exclude_patterns

synced_commit="$(git -C "$WORKTREE_PATH" rev-parse --short "$REMOTE_REF")"
echo "platform-loop-sync: synced $WORKTREE_PATH to $REMOTE_REF ($synced_commit)"
