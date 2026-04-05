#!/bin/bash
#
# Monitor the deployed Idea Maze VPS over SSH.
#
# Usage:
#   ./scripts/monitor-vps.sh
#   ./scripts/monitor-vps.sh idea-maze-vps
#   ./scripts/monitor-vps.sh --follow
#   ./scripts/monitor-vps.sh idea-maze-vps --follow

set -euo pipefail

HOST_ALIAS="idea-maze-vps"
APP_DIR="/root/idea-maze-claw"
SERVICE_NAME="nanoclaw"
FOLLOW="false"

usage() {
  cat <<'EOF'
Usage: ./scripts/monitor-vps.sh [ssh-host-alias] [--follow]

Defaults:
  ssh-host-alias: idea-maze-vps
  mode:           one-shot summary

Options:
  -f, --follow    Follow NanoClaw service logs after printing the summary
  -h, --help      Show this help text
EOF
}

for arg in "$@"; do
  case "$arg" in
    -f|--follow)
      FOLLOW="true"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ "$HOST_ALIAS" = "idea-maze-vps" ]; then
        HOST_ALIAS="$arg"
      else
        echo "Unexpected argument: $arg" >&2
        usage >&2
        exit 1
      fi
      ;;
  esac
done

ssh "$HOST_ALIAS" bash -s -- "$APP_DIR" "$SERVICE_NAME" "$FOLLOW" <<'REMOTE'
set -u

APP_DIR="$1"
SERVICE_NAME="$2"
FOLLOW="$3"

section() {
  printf '\n== %s ==\n' "$1"
}

section "Host"
date -Is 2>/dev/null || date
hostname 2>/dev/null || true
uptime 2>/dev/null || true

section "Resources"
free -h 2>/dev/null || true
df -h / "$APP_DIR" 2>/dev/null || true

section "Service"
systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo "inactive"
systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || echo "disabled"
systemctl show \
  --property=MainPID,ExecMainStatus,ExecMainStartTimestamp \
  "$SERVICE_NAME" 2>/dev/null || true

section "Docker"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true

section "OneCLI"
curl -fsS http://172.17.0.1:10254/api/health 2>/dev/null || echo "OneCLI health endpoint unreachable"

section "NanoClaw Verify"
cd "$APP_DIR"
npx tsx setup/index.ts --step verify 2>/dev/null || true

section "Message DB"
node - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('store/messages.db', { readonly: true });
const counts = {};
for (const table of [
  'registered_groups',
  'sessions',
  'messages',
  'chats',
  'scheduled_tasks',
  'task_run_logs',
]) {
  counts[table] = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}
console.log(JSON.stringify(counts, null, 2));

const tasks = db.prepare(`
  SELECT id, group_folder, status, next_run
  FROM scheduled_tasks
  ORDER BY next_run IS NULL, next_run
  LIMIT 5
`).all();
if (tasks.length === 0) {
  console.log('No scheduled tasks');
} else {
  console.log(JSON.stringify(tasks, null, 2));
}
db.close();
NODE

section "Idea Maze DB"
node - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('groups/idea-maze/data/lab.db', { readonly: true });
const counts = {};
for (const table of [
  'source_items',
  'insights',
  'opportunities',
  'runs',
  'artifacts',
]) {
  counts[table] = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}
console.log(JSON.stringify(counts, null, 2));

const runs = db.prepare(`
  SELECT id, run_type, target_type, target_id, status, started_at_utc, completed_at_utc
  FROM runs
  ORDER BY id DESC
  LIMIT 5
`).all();
console.log(JSON.stringify(runs, null, 2));
db.close();
NODE

section "Recent App Logs"
tail -n 20 "$APP_DIR/logs/nanoclaw.log" 2>/dev/null || true

section "Recent Error Logs"
tail -n 20 "$APP_DIR/logs/nanoclaw.error.log" 2>/dev/null || true

if [ "$FOLLOW" = "true" ]; then
  section "Following Service Logs"
  exec journalctl -u "$SERVICE_NAME" -f -n 50 --no-pager
fi
REMOTE
