#!/bin/bash
# Interactive CLI for NanoClaw.
# Usage:
#   ./scripts/cli.sh              → interactive REPL, talks to cli:main (prod)
#   ./scripts/cli.sh cli:dev      → interactive REPL, talks to cli:dev (dev)
#   ./scripts/cli.sh "message"    → one-shot send to cli:main (backward compat)

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="$PROJECT_ROOT/store/messages.db"

if [ ! -f "$DB" ]; then
  echo "Error: Database not found at $DB"
  echo "Run the service first to initialize the database."
  exit 1
fi

# Determine mode: interactive REPL vs one-shot
# If arg looks like a JID (contains ':'), use it as the group JID for interactive mode.
# Otherwise, treat it as a one-shot message to cli:main.
if [ -n "$1" ] && ! echo "$1" | grep -q ':'; then
  # One-shot mode (backward compat): ./scripts/cli.sh "hello"
  MESSAGE="$1"
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  MSG_ID="cli-$(date +%s)-$$"
  sqlite3 "$DB" "
    INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
    VALUES ('$MSG_ID', 'cli:main', 'cli:user', 'User', '$(echo "$MESSAGE" | sed "s/'/''/g")', '$TIMESTAMP', 0, 0);
  "
  echo "Message sent. Watch logs: tail -f $PROJECT_ROOT/logs/nanoclaw.log"
  exit 0
fi

# Interactive REPL mode
JID="${1:-cli:main}"
echo "NanoClaw CLI — talking to $JID"
echo "Type a message and press Enter. Ctrl+D to exit."
echo ""

# Track cursor for polling responses
CURSOR=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

while IFS= read -r -p "You: " line; do
  [ -z "$line" ] && continue

  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  MSG_ID="cli-$(date +%s)-$$-$RANDOM"

  # Escape single quotes for SQL
  ESCAPED=$(echo "$line" | sed "s/'/''/g")

  sqlite3 "$DB" "
    INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
    VALUES ('$MSG_ID', '$JID', 'cli:user', 'User', '$ESCAPED', '$TIMESTAMP', 0, 0);
  "

  # Poll for bot response — look for any bot message sent AFTER our user message
  TIMEOUT=120
  WAITED=0
  while true; do
    ROW=$(sqlite3 -separator '|' "$DB" \
      "SELECT timestamp, content FROM messages
       WHERE chat_jid='$JID' AND is_bot_message=1
       AND timestamp > '$TIMESTAMP'
       ORDER BY timestamp ASC LIMIT 1")
    if [ -n "$ROW" ]; then
      BOT_TS="${ROW%%|*}"
      BOT_CONTENT="${ROW#*|}"
      echo ""
      echo "Andy: $BOT_CONTENT"
      echo ""
      # Advance cursor past this response so we don't re-read it
      CURSOR="$BOT_TS"
      break
    fi
    sleep 1
    WAITED=$((WAITED + 1))
    if [ $WAITED -ge $TIMEOUT ]; then
      echo ""
      echo "(timed out waiting for response after ${TIMEOUT}s)"
      echo ""
      break
    fi
  done
done
