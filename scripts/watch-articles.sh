#!/usr/bin/env bash
# Watches groups/global/articles/ and groups/global/transcripts/ for new
# markdown files and fires an IPC task to the main NanoClaw agent to ingest
# each one.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTICLES_DIR="$ROOT/groups/global/articles"
TRANSCRIPTS_DIR="$ROOT/groups/global/transcripts"
IPC_TASKS_DIR="$ROOT/data/ipc/whatsapp_main/tasks"
MAIN_JID="6590888002@s.whatsapp.net"

mkdir -p "$IPC_TASKS_DIR"

echo "[watch-articles] Watching $ARTICLES_DIR and $TRANSCRIPTS_DIR"

inotifywait -m -e close_write,moved_to --format '%w%f' "$ARTICLES_DIR" "$TRANSCRIPTS_DIR" | while read -r filepath; do
  [[ "$filepath" == *.md ]] || continue

  filename="$(basename "$filepath")"
  now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [[ "$filepath" == "$TRANSCRIPTS_DIR"* ]]; then
    task_id="transcript-$(date +%s)-$$"
    prompt="A new speech transcript has arrived: ${filename}. Read the file at /workspace/project/groups/global/transcripts/${filename} (local file — no copy needed), extract key facts, quotes, and insights to global mnemon (importance 4-5, --data-dir /workspace/global/.mnemon), identify and update relevant wiki pages, then confirm what was added."
  else
    task_id="article-$(date +%s)-$$"
    prompt="A new web clipping has arrived: ${filename}. Read the file at /workspace/project/groups/global/articles/${filename}, extract key facts and insights to global mnemon (importance 3-4, --data-dir /workspace/global/.mnemon), identify and update relevant wiki pages, then confirm what was added."
  fi

  cat > "$IPC_TASKS_DIR/${task_id}.json" <<EOF
{
  "type": "schedule_task",
  "prompt": "${prompt}",
  "schedule_type": "once",
  "schedule_value": "${now_iso}",
  "targetJid": "${MAIN_JID}",
  "context_mode": "group"
}
EOF

  echo "[watch-articles] IPC task created for: $filepath"
done
