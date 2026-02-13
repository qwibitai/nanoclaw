#!/bin/bash
DIR="$(cd "$(dirname "$0")/.." && pwd)"
JID=$(sqlite3 "$DIR/store/messages.db" "SELECT jid FROM registered_groups WHERE folder='main' LIMIT 1")

NANOCLAW_CHAT_JID="$JID" \
NANOCLAW_GROUP_FOLDER=main \
NANOCLAW_IS_MAIN=1 \
NANOCLAW_IPC_DIR="$DIR/data/ipc/main" \
exec node "$DIR/container/agent-runner/dist/ipc-mcp-stdio.js"
