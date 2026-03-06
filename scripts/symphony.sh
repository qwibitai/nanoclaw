#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYMPHONY_ROOT="${SYMPHONY_ROOT:-$ROOT_DIR/.symphony/symphony}"
SYMPHONY_ELIXIR_DIR="${SYMPHONY_ELIXIR_DIR:-$SYMPHONY_ROOT/elixir}"
WORKFLOW_FILE="${SYMPHONY_WORKFLOW_FILE:-$ROOT_DIR/WORKFLOW.md}"
SOURCE_REPO_URL="${SOURCE_REPO_URL:-$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || true)}"
SYMPHONY_WORKSPACE_ROOT="${SYMPHONY_WORKSPACE_ROOT:-$ROOT_DIR/.symphony/workspaces}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/symphony.sh setup
  bash scripts/symphony.sh run [--logs-root <dir>] [--port <port>]

Environment variables:
  LINEAR_API_KEY           Required for run
  SOURCE_REPO_URL          Defaults to git remote origin URL
  SYMPHONY_WORKSPACE_ROOT  Defaults to <repo>/.symphony/workspaces
  CODEX_BIN                Defaults to "codex" (used by WORKFLOW.md)
  SYMPHONY_ROOT            Defaults to <repo>/.symphony/symphony
  SYMPHONY_ELIXIR_DIR      Defaults to <repo>/.symphony/symphony/elixir
  SYMPHONY_WORKFLOW_FILE   Defaults to <repo>/WORKFLOW.md
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

setup_symphony() {
  require_cmd git
  require_cmd mise

  mkdir -p "$(dirname "$SYMPHONY_ROOT")"
  if [ ! -d "$SYMPHONY_ROOT/.git" ]; then
    git clone https://github.com/openai/symphony "$SYMPHONY_ROOT"
  fi

  cd "$SYMPHONY_ELIXIR_DIR"
  mise trust
  mise install
  mise exec -- mix setup
  mise exec -- mix build
}

run_symphony() {
  if [ -z "${LINEAR_API_KEY:-}" ]; then
    echo "LINEAR_API_KEY is required." >&2
    exit 1
  fi
  if [ -z "$SOURCE_REPO_URL" ]; then
    echo "SOURCE_REPO_URL is not set and origin remote was not found." >&2
    exit 1
  fi
  if [ ! -f "$WORKFLOW_FILE" ]; then
    echo "WORKFLOW.md not found at $WORKFLOW_FILE" >&2
    exit 1
  fi
  if [ ! -x "$SYMPHONY_ELIXIR_DIR/bin/symphony" ]; then
    setup_symphony
  fi

  export SOURCE_REPO_URL
  export SYMPHONY_WORKSPACE_ROOT
  mkdir -p "$SYMPHONY_WORKSPACE_ROOT"

  cd "$SYMPHONY_ELIXIR_DIR"
  mise exec -- ./bin/symphony "$WORKFLOW_FILE" "$@"
}

case "${1:-}" in
  setup)
    shift
    setup_symphony "$@"
    ;;
  run)
    shift
    run_symphony "$@"
    ;;
  *)
    usage
    exit 1
    ;;
esac
