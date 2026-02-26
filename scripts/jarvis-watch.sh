#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_FILE="$ROOT_DIR/logs/nanoclaw.log"
LINES=200
FOLLOW=1

usage() {
  cat <<'EOF'
Usage: scripts/jarvis-watch.sh [options]

Options:
  --file <path>  Log file to watch (default: logs/nanoclaw.log).
  --lines <n>    Number of lines for initial summary and tail (default: 200).
  --once         Print summary only, do not follow.
  -h, --help     Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --file)
      LOG_FILE="$2"
      shift 2
      ;;
    --lines)
      LINES="$2"
      shift 2
      ;;
    --once)
      FOLLOW=0
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

if ! [[ "$LINES" =~ ^[0-9]+$ ]]; then
  echo "Invalid --lines value: $LINES"
  exit 1
fi

if [ ! -f "$LOG_FILE" ]; then
  echo "Log file not found: $LOG_FILE"
  exit 1
fi

snapshot_file="$(mktemp /tmp/jarvis-watch.XXXXXX.log)"
trap 'rm -f "$snapshot_file"' EXIT
tail -n "$LINES" "$LOG_FILE" >"$snapshot_file" || true

count_pattern() {
  local label="$1"
  local regex="$2"
  local count
  count="$(grep -Eci "$regex" "$snapshot_file" || true)"
  printf '  %-28s %s\n' "$label" "$count"
}

echo "== Jarvis Watch =="
echo "file: $LOG_FILE"
echo "window: last $LINES lines"
echo "Summary counts:"
count_pattern "errors" "ERROR|\\\"level\\\":50|level=error"
count_pattern "warnings" "WARN|\\\"level\\\":40|level=warn"
count_pattern "contract failures" "failed_contract|completion validation failed|completion block"
count_pattern "queue cleanup events" "queued_cursor_past_dispatch|orphaned queued worker run"
count_pattern "auth failures" "Invalid API key|failed to authenticate api|authentication failed"
count_pattern "builder/runtime issues" "Dialing builder|Builder failed to start|Operation not permitted"
count_pattern "dispatch/runtime events" "Spawning container agent|Container completed|worker_run_insert|dispatch_validation"

if [ "$FOLLOW" -eq 0 ]; then
  exit 0
fi

echo
echo "Following log (Ctrl+C to stop)..."

classify_line() {
  local line="$1"
  local severity="INFO"
  local category=""

  if [[ "$line" == *"ERROR"* ]] || [[ "$line" == *"level\":50"* ]] || [[ "$line" == *"level=error"* ]]; then
    severity="ERROR"
  elif [[ "$line" == *"WARN"* ]] || [[ "$line" == *"level\":40"* ]] || [[ "$line" == *"level=warn"* ]]; then
    severity="WARN"
  fi

  if [[ "$line" =~ failed_contract|completion[[:space:]]validation[[:space:]]failed|completion[[:space:]]block ]]; then
    category="CONTRACT"
  elif [[ "$line" =~ queued_cursor_past_dispatch|orphaned[[:space:]]queued[[:space:]]worker[[:space:]]run ]]; then
    category="QUEUE"
  elif [[ "$line" =~ [Ii]nvalid[[:space:]]API[[:space:]]key|failed[[:space:]]to[[:space:]]authenticate[[:space:]]api|[Aa]uthentication[[:space:]]failed ]]; then
    category="AUTH"
  elif [[ "$line" =~ Dialing[[:space:]]builder|Builder[[:space:]]failed[[:space:]]to[[:space:]]start|Operation[[:space:]]not[[:space:]]permitted ]]; then
    category="BUILDER"
  elif [[ "$line" =~ Spawning[[:space:]]container[[:space:]]agent|Container[[:space:]]completed|worker_run_insert|dispatch_validation ]]; then
    category="RUNTIME"
  elif [[ "$line" =~ Message[[:space:]]sent|IPC[[:space:]]message[[:space:]]sent ]]; then
    category="ROUTER"
  fi

  if [ -n "$category" ]; then
    echo "[$severity][$category] $line"
  elif [ "$severity" != "INFO" ]; then
    echo "[$severity] $line"
  fi
}

tail -n "$LINES" -F "$LOG_FILE" | while IFS= read -r line; do
  classify_line "$line"
done

