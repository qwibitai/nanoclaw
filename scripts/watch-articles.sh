#!/usr/bin/env bash
# Watches groups/global/articles/ for new markdown files and fires an IPC
# task to the main NanoClaw agent to ingest each one.

set -euo pipefail

ARTICLES_DIR="$(cd "$(dirname "$0")/.." && pwd)/groups/global/articles"
IPC_TASKS_DIR="$(cd "$(dirname "$0")/.." && pwd)/data/ipc/whatsapp_main/tasks"
MAIN_JID="6590888002@s.whatsapp.net"

mkdir -p "$IPC_TASKS_DIR"

echo "[watch-articles] Watching $ARTICLES_DIR"

inotifywait -m -e close_write,moved_to --format '%f' "$ARTICLES_DIR" | while read -r filename; do
  [[ "$filename" == *.md ]] || continue

  task_id="article-$(date +%s)-$$"
  now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  cat > "$IPC_TASKS_DIR/${task_id}.json" <<EOF
{
  "type": "schedule_task",
  "prompt": "A new web clipping has arrived: ${filename}. Read the file at /workspace/project/groups/global/articles/${filename}, extract key facts and insights to mnemon (importance 3-4), identify and update relevant wiki pages, then confirm what was added.",
  "schedule_type": "once",
  "schedule_value": "${now_iso}",
  "targetJid": "${MAIN_JID}",
  "context_mode": "group"
}
EOF

  echo "[watch-articles] IPC task created for: $filename"
done
