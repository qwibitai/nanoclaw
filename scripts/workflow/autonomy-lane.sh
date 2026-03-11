#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_ROOT="${NANOCLAW_AUTONOMY_SOURCE_ROOT:-$ROOT_DIR}"
AUTONOMY_DIR="$SOURCE_ROOT/.nanoclaw/autonomy"
LOCKS_DIR="$AUTONOMY_DIR/locks"
RUNS_DIR="$AUTONOMY_DIR/runs"
PAUSE_FILE="$AUTONOMY_DIR/pause.json"

json_escape() {
  python3 - <<'PY' "$1"
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

write_pause_file() {
  local reason="$1"
  local source="$2"
  local incident_id="$3"
  mkdir -p "$AUTONOMY_DIR"
  cat >"$PAUSE_FILE" <<EOF
{
  "paused": true,
  "reason": $(json_escape "$reason"),
  "source": $(json_escape "$source"),
  "incident_id": $(json_escape "$incident_id"),
  "updated_at": $(json_escape "$(date -u +"%Y-%m-%dT%H:%M:%SZ")")
}
EOF
}

usage() {
  cat <<'EOF'
Usage: autonomy-lane.sh <command> [options]

Commands:
  pause-status
  pause-set --reason <text> [--source <lane>] [--incident-id <id>]
  pause-clear [--source <lane>]
  run-start --lane <name>
  run-end --lane <name>
  run-status --lane <name>
EOF
}

read_flag() {
  local flag="$1"
  shift
  local args=("$@")
  local index
  for ((index=0; index<${#args[@]}; index+=1)); do
    if [[ "${args[$index]}" == "$flag" && $((index + 1)) -lt ${#args[@]} ]]; then
      printf '%s\n' "${args[$((index + 1))]}"
      return 0
    fi
  done
  return 1
}

print_pause_status() {
  if [[ ! -f "$PAUSE_FILE" ]]; then
    cat <<EOF
{
  "paused": false,
  "pause_file": $(json_escape "$PAUSE_FILE")
}
EOF
    return 0
  fi

  python3 - <<'PY' "$PAUSE_FILE"
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
data["pause_file"] = str(path)
print(json.dumps(data, indent=2))
PY
}

run_start() {
  local lane="$1"
  local lock_dir="$LOCKS_DIR/$lane.lock"
  mkdir -p "$LOCKS_DIR"
  if mkdir "$lock_dir" 2>/dev/null; then
    cat >"$lock_dir/state.json" <<EOF
{
  "lane": $(json_escape "$lane"),
  "started_at": $(json_escape "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"),
  "pid": $(json_escape "$$")
}
EOF
    cat <<EOF
{
  "success": true,
  "lane": $(json_escape "$lane"),
  "lock_dir": $(json_escape "$lock_dir")
}
EOF
    return 0
  fi

  cat <<EOF
{
  "success": false,
  "lane": $(json_escape "$lane"),
  "lock_dir": $(json_escape "$lock_dir"),
  "reason": "already_running"
}
EOF
  return 2
}

run_end() {
  local lane="$1"
  local lock_dir="$LOCKS_DIR/$lane.lock"
  rm -rf "$lock_dir"
  cat <<EOF
{
  "success": true,
  "lane": $(json_escape "$lane"),
  "lock_dir": $(json_escape "$lock_dir")
}
EOF
}

run_status() {
  local lane="$1"
  local lock_dir="$LOCKS_DIR/$lane.lock"
  if [[ -d "$lock_dir" ]]; then
    local state_file="$lock_dir/state.json"
    if [[ -f "$state_file" ]]; then
      python3 - <<'PY' "$state_file" "$lock_dir"
import json, pathlib, sys
state_file = pathlib.Path(sys.argv[1])
lock_dir = sys.argv[2]
data = json.loads(state_file.read_text(encoding="utf-8"))
data["running"] = True
data["lock_dir"] = lock_dir
print(json.dumps(data, indent=2))
PY
      return 0
    fi
  fi

  cat <<EOF
{
  "running": false,
  "lane": $(json_escape "$lane"),
  "lock_dir": $(json_escape "$lock_dir")
}
EOF
}

COMMAND="${1:-}"
shift || true

case "$COMMAND" in
  pause-status)
    print_pause_status
    ;;
  pause-set)
    REASON="$(read_flag --reason "$@" || true)"
    SOURCE="$(read_flag --source "$@" || true)"
    INCIDENT_ID="$(read_flag --incident-id "$@" || true)"
    if [[ -z "$REASON" ]]; then
      echo "pause-set requires --reason" >&2
      exit 1
    fi
    write_pause_file "$REASON" "${SOURCE:-autonomy}" "${INCIDENT_ID:-}"
    print_pause_status
    ;;
  pause-clear)
    mkdir -p "$AUTONOMY_DIR"
    rm -f "$PAUSE_FILE"
    cat <<EOF
{
  "paused": false,
  "pause_file": $(json_escape "$PAUSE_FILE")
}
EOF
    ;;
  run-start)
    LANE="$(read_flag --lane "$@" || true)"
    if [[ -z "$LANE" ]]; then
      echo "run-start requires --lane" >&2
      exit 1
    fi
    run_start "$LANE"
    ;;
  run-end)
    LANE="$(read_flag --lane "$@" || true)"
    if [[ -z "$LANE" ]]; then
      echo "run-end requires --lane" >&2
      exit 1
    fi
    run_end "$LANE"
    ;;
  run-status)
    LANE="$(read_flag --lane "$@" || true)"
    if [[ -z "$LANE" ]]; then
      echo "run-status requires --lane" >&2
      exit 1
    fi
    run_status "$LANE"
    ;;
  -h|--help|"")
    usage
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    usage >&2
    exit 1
    ;;
esac
