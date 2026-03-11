#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${NANOCLAW_PLATFORM_CLAUDE_ENV_FILE:-$ROOT_DIR/.env}"
WORKTREE_PATH=""
CLAUDE_PROMPT=""
SOURCE_ROOT="$ROOT_DIR"
CLAUDE_ALLOWED_TOOLS=""
CLAUDE_PERMISSION_MODE="${NANOCLAW_PLATFORM_CLAUDE_PERMISSION_MODE:-bypassPermissions}"
GH_ACCOUNT="${NANOCLAW_PLATFORM_GH_ACCOUNT:-ingpoc}"

usage() {
  cat <<'EOF'
Usage: run-platform-claude-session.sh --worktree <path> --prompt <prompt> [options]

Options:
  --permission-mode <mode>   Claude permission mode (default: bypassPermissions)
  --allowed-tools <tools>    Claude allowedTools override for headless runs
  --source-root <path>       Source root for shared runtime-local state (default: repo root)
  --gh-account <login>       GitHub account to activate before launch (default: ingpoc)
EOF
}

while (($#)); do
  case "$1" in
    --worktree)
      [ "$#" -ge 2 ] || { echo "Missing value for --worktree" >&2; exit 1; }
      WORKTREE_PATH="$2"
      shift 2
      ;;
    --prompt)
      [ "$#" -ge 2 ] || { echo "Missing value for --prompt" >&2; exit 1; }
      CLAUDE_PROMPT="$2"
      shift 2
      ;;
    --permission-mode)
      [ "$#" -ge 2 ] || { echo "Missing value for --permission-mode" >&2; exit 1; }
      CLAUDE_PERMISSION_MODE="$2"
      shift 2
      ;;
    --allowed-tools)
      [ "$#" -ge 2 ] || { echo "Missing value for --allowed-tools" >&2; exit 1; }
      CLAUDE_ALLOWED_TOOLS="$2"
      shift 2
      ;;
    --source-root)
      [ "$#" -ge 2 ] || { echo "Missing value for --source-root" >&2; exit 1; }
      SOURCE_ROOT="$2"
      shift 2
      ;;
    --gh-account)
      [ "$#" -ge 2 ] || { echo "Missing value for --gh-account" >&2; exit 1; }
      GH_ACCOUNT="$2"
      shift 2
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

if [[ -z "$WORKTREE_PATH" || -z "$CLAUDE_PROMPT" ]]; then
  usage >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI is required but not found in PATH" >&2
  exit 1
fi

if [[ ! -d "$WORKTREE_PATH" ]]; then
  echo "Worktree path does not exist: $WORKTREE_PATH" >&2
  exit 1
fi

if [[ ! -d "$SOURCE_ROOT" ]]; then
  echo "Source root does not exist: $SOURCE_ROOT" >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  ROOT_DIR_FOR_NODE="$ROOT_DIR" ENV_FILE_FOR_NODE="$ENV_FILE" ENV_KEY_FOR_NODE="$key" node --input-type=module <<'EOF'
import fs from 'fs';

const envFile = process.env.ENV_FILE_FOR_NODE;
const key = process.env.ENV_KEY_FOR_NODE;
if (!envFile || !key || !fs.existsSync(envFile)) {
  process.exit(0);
}

const content = fs.readFileSync(envFile, 'utf8');
for (const line of content.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const separator = trimmed.indexOf('=');
  if (separator === -1) continue;
  const candidate = trimmed.slice(0, separator).trim();
  if (candidate !== key) continue;
  let value = trimmed.slice(separator + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  process.stdout.write(value);
  break;
}
EOF
}

if command -v gh >/dev/null 2>&1; then
  gh auth switch --user "$GH_ACCOUNT" >/dev/null
fi

CLAUDE_CODE_OAUTH_TOKEN_VALUE="$(read_env_value "CLAUDE_CODE_OAUTH_TOKEN")"
if [[ -n "$CLAUDE_CODE_OAUTH_TOKEN_VALUE" ]]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN_VALUE"
fi
unset CLAUDE_CODE_OAUTH_TOKEN_VALUE

cleanup_worktree() {
  local status_output=""

  if [[ ! -d "$WORKTREE_PATH" ]]; then
    return 0
  fi

  status_output="$(git -C "$WORKTREE_PATH" status --porcelain --untracked-files=normal 2>/dev/null || true)"
  if [[ -n "$status_output" ]]; then
    echo "claude-worktree-runner: preserving dirty worktree at $WORKTREE_PATH" >&2
    printf '%s\n' "$status_output" >&2
    return 0
  fi

  if git -C "$ROOT_DIR" worktree remove "$WORKTREE_PATH" >/dev/null 2>&1; then
    echo "claude-worktree-runner: removed clean worktree $WORKTREE_PATH"
    return 0
  fi

  echo "claude-worktree-runner: failed to remove clean worktree $WORKTREE_PATH" >&2
  return 0
}

cd "$WORKTREE_PATH"
set +e
if [[ -n "$CLAUDE_ALLOWED_TOOLS" ]]; then
  NANOCLAW_AUTONOMY_SOURCE_ROOT="$SOURCE_ROOT" \
    claude -p --permission-mode "$CLAUDE_PERMISSION_MODE" \
    --allowedTools "$CLAUDE_ALLOWED_TOOLS" \
    --add-dir "$SOURCE_ROOT" \
    "$CLAUDE_PROMPT"
else
  NANOCLAW_AUTONOMY_SOURCE_ROOT="$SOURCE_ROOT" \
    claude -p --permission-mode "$CLAUDE_PERMISSION_MODE" \
    --add-dir "$SOURCE_ROOT" \
    "$CLAUDE_PROMPT"
fi
CLAUDE_EXIT=$?
set -e

cd "$ROOT_DIR"
cleanup_worktree
exit "$CLAUDE_EXIT"
