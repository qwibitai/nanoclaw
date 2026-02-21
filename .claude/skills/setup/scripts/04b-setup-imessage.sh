#!/bin/bash
set -euo pipefail

# 04b-setup-imessage.sh — iMessage setup: check access and list chats
# Modes:
#   --check-only       Verify macOS, chat.db exists, chat.db readable
#   --list-chats       Sync iMessage chats to SQLite and list them

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [setup-imessage] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

# Parse args
MODE=""
LIMIT=50
while [[ $# -gt 0 ]]; do
  case $1 in
    --check-only)  MODE="check"; shift ;;
    --list-chats)  MODE="list"; shift ;;
    --limit)       LIMIT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$MODE" ]; then
  log "ERROR: --check-only or --list-chats required"
  cat <<EOF
=== NANOCLAW SETUP: SETUP_IMESSAGE ===
STATUS: failed
ERROR: missing_mode_flag
LOG: logs/setup.log
=== END ===
EOF
  exit 4
fi

case "$MODE" in

  check)
    log "Running iMessage check-only"

    PLATFORM_OK="false"
    CHAT_DB_EXISTS="false"
    CHAT_DB_ACCESSIBLE="false"
    ERROR=""

    # Check platform
    if [ "$(uname -s)" != "Darwin" ]; then
      ERROR="not_macos"
      log "Not macOS — iMessage unavailable"
    else
      PLATFORM_OK="true"

      # Check chat.db exists
      if [ -f "$HOME/Library/Messages/chat.db" ]; then
        CHAT_DB_EXISTS="true"

        # Check readable
        if [ -r "$HOME/Library/Messages/chat.db" ]; then
          CHAT_DB_ACCESSIBLE="true"
          log "chat.db accessible"
        else
          ERROR="permission_denied"
          log "chat.db exists but not readable (Full Disk Access needed)"
        fi
      else
        ERROR="no_messages_app"
        log "chat.db not found — Messages app may not be set up"
      fi
    fi

    cat <<EOF
=== NANOCLAW SETUP: SETUP_IMESSAGE ===
MODE: check
PLATFORM_OK: $PLATFORM_OK
CHAT_DB_EXISTS: $CHAT_DB_EXISTS
CHAT_DB_ACCESSIBLE: $CHAT_DB_ACCESSIBLE
STATUS: $( [ "$CHAT_DB_ACCESSIBLE" = "true" ] && echo "success" || echo "failed" )
$( [ -n "$ERROR" ] && echo "ERROR: $ERROR" || true )
LOG: logs/setup.log
=== END ===
EOF

    if [ "$CHAT_DB_ACCESSIBLE" != "true" ]; then
      exit 1
    fi
    ;;

  list)
    log "Listing iMessage chats (limit=$LIMIT)"

    # Ensure DB exists
    DB_PATH="$PROJECT_ROOT/store/messages.db"
    mkdir -p "$PROJECT_ROOT/store"

    # Use the iMessage SDK to list chats and write to SQLite
    LIST_OUTPUT=$(node -e "
import { IMessageSDK } from '@photon-ai/imessage-kit';
import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join('store', 'messages.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT)');

const upsert = db.prepare(
  'INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET name = excluded.name'
);

const sdk = new IMessageSDK();
try {
  const chats = await sdk.listChats({ limit: ${LIMIT} });
  const now = new Date().toISOString();
  let count = 0;

  for (const chat of chats) {
    const jid = chat.isGroup
      ? 'imsg-group:' + chat.chatId
      : 'imsg:' + chat.chatId;
    const name = chat.displayName || chat.chatId;

    upsert.run(jid, name, now);

    // Output pipe-separated line for the caller
    console.log(jid + '|' + name);
    count++;
  }

  console.error('SYNCED:' + count);
} catch (err) {
  console.error('ERROR:' + err.message);
  process.exit(1);
} finally {
  await sdk.close();
  db.close();
}
" --input-type=module 2>"$PROJECT_ROOT/logs/imessage-list.tmp") || true

    # Read stderr for status
    STDERR_OUTPUT=$(cat "$PROJECT_ROOT/logs/imessage-list.tmp" 2>/dev/null || echo "")
    rm -f "$PROJECT_ROOT/logs/imessage-list.tmp"

    log "List output stderr: $STDERR_OUTPUT"

    CHATS_FOUND=0
    if echo "$STDERR_OUTPUT" | grep -q "SYNCED:"; then
      CHATS_FOUND=$(echo "$STDERR_OUTPUT" | sed -n 's/.*SYNCED:\([0-9]*\).*/\1/p')
    fi

    # Output the chat lines (stdout from node)
    echo "$LIST_OUTPUT"

    STATUS="success"
    ERROR_MSG=""
    if echo "$STDERR_OUTPUT" | grep -q "ERROR:"; then
      STATUS="failed"
      ERROR_MSG=$(echo "$STDERR_OUTPUT" | sed -n 's/.*ERROR:\(.*\)/\1/p')
    fi

    cat <<EOF
=== NANOCLAW SETUP: SETUP_IMESSAGE ===
MODE: list
CHATS_FOUND: $CHATS_FOUND
STATUS: $STATUS
$( [ -n "$ERROR_MSG" ] && echo "ERROR: $ERROR_MSG" || true )
LOG: logs/setup.log
=== END ===
EOF

    if [ "$STATUS" = "failed" ]; then
      exit 1
    fi
    ;;

esac
