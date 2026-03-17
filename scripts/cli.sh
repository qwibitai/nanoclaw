#!/bin/bash
# Send a message to the NanoClaw agent via CLI channel.
# Usage: ./scripts/cli.sh "your message here"
#
# For interactive mode, run: npm run dev

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="$PROJECT_ROOT/store/messages.db"

if [ ! -f "$DB" ]; then
  echo "Error: Database not found at $DB"
  echo "Run the service first to initialize the database."
  exit 1
fi

if [ -z "$1" ]; then
  echo "Usage: $0 \"your message\""
  echo "  Or start NanoClaw with: npm run dev (interactive CLI mode)"
  exit 1
fi

MESSAGE="$1"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
MSG_ID="cli-$(date +%s)-$$"

sqlite3 "$DB" "
  INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
  VALUES ('$MSG_ID', 'cli:main', 'cli:user', 'User', '$(echo "$MESSAGE" | sed "s/'/''/g")', '$TIMESTAMP', 0, 0);
"

echo "Message sent. Watch logs: tail -f $PROJECT_ROOT/logs/nanoclaw.log"
