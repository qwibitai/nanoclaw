#!/bin/bash
# NanoClaw Main Group Pairing Script
# Helps user register their Telegram chat as the main group

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_ROOT"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║         NanoClaw Main Group Pairing                       ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Check if service is running
if ! docker compose -f docker-compose.vps.yml ps | grep -q "Up"; then
    echo "⚠️  NanoClaw service is not running."
    echo "   Starting service first..."
    docker compose -f docker-compose.vps.yml up -d
    sleep 5
fi

echo "📱 Please open Telegram and send ANY message to your bot."
echo "   Bot username: $(docker compose -f docker-compose.vps.yml logs nanoclaw-bot1 2>/dev/null | grep 'username:' | tail -1 | sed 's/.*username: "\(.*\)".*/\1/' || echo 'Check logs')"
echo ""
echo "   Examples:"
echo "   - hello"
echo "   - /start"
echo "   - 你好"
echo ""
echo "⏳ Waiting for your message..."
echo "   (Press Ctrl+C to cancel)"
echo ""

# Wait for user to send message
# Auto-detect database location (data/ for local, data-bot1/ for VPS)
if [ -f "$PROJECT_ROOT/data-bot1/nanoclaw.db" ]; then
    DB_FILE="$PROJECT_ROOT/data-bot1/nanoclaw.db"
elif [ -f "$PROJECT_ROOT/data/nanoclaw.db" ]; then
    DB_FILE="$PROJECT_ROOT/data/nanoclaw.db"
else
    echo "❌ Database not found in:"
    echo "   - $PROJECT_ROOT/data/nanoclaw.db"
    echo "   - $PROJECT_ROOT/data-bot1/nanoclaw.db"
    echo ""
    echo "Please ensure the service has been started at least once:"
    echo "   docker compose -f docker-compose.vps.yml up -d"
    exit 1
fi

echo "📂 Using database: $DB_FILE"
echo ""

# Function to get latest chat
get_latest_chat() {
    sqlite3 "$DB_FILE" "SELECT chat_id, chat_name FROM chats WHERE chat_id > 0 ORDER BY last_activity DESC LIMIT 1" 2>/dev/null || echo ""
}

INITIAL_CHAT=$(get_latest_chat)
ATTEMPTS=0
MAX_ATTEMPTS=60  # 60 seconds timeout

while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
    sleep 1
    CURRENT_CHAT=$(get_latest_chat)

    if [ -n "$CURRENT_CHAT" ] && [ "$CURRENT_CHAT" != "$INITIAL_CHAT" ]; then
        CHAT_ID=$(echo "$CURRENT_CHAT" | cut -d'|' -f1)
        CHAT_NAME=$(echo "$CURRENT_CHAT" | cut -d'|' -f2)

        echo "✅ Received message from:"
        echo "   Chat ID: $CHAT_ID"
        echo "   Name: ${CHAT_NAME:-Unknown}"
        echo ""

        read -p "Register this chat as main group? (y/n): " -n 1 -r
        echo ""

        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo ""
            echo "📝 Registering main group..."

            # Create main group folder
            mkdir -p groups/main

            # Create CLAUDE.md
            cat > groups/main/CLAUDE.md << EOF
# Main Group

Personal chat with NanoClaw Bot.
You are the AI assistant configured in ASSISTANT_NAME.

This is the main administrative group with full privileges.
EOF

            # Create registered_groups.json (in same directory as database)
            REGISTERED_GROUPS_FILE="$(dirname "$DB_FILE")/registered_groups.json"
            cat > "$REGISTERED_GROUPS_FILE" << EOF
{
  "$CHAT_ID": {
    "name": "Main",
    "folder": "main",
    "jid": "$CHAT_ID",
    "isMain": true
  }
}
EOF

            echo "✅ Main group registered!"
            echo ""
            echo "🔄 Restarting service to apply changes..."
            docker compose -f docker-compose.vps.yml restart nanoclaw-bot1

            echo ""
            echo "╔════════════════════════════════════════════════════════════╗"
            echo "║  ✅ Pairing Complete!                                      ║"
            echo "╚════════════════════════════════════════════════════════════╝"
            echo ""
            echo "📱 You can now chat with your bot without using trigger words!"
            echo ""
            echo "Test it by sending:"
            echo "   hello"
            echo "   what is 2+2?"
            echo "   你好"
            echo ""

            exit 0
        else
            echo "❌ Pairing cancelled."
            exit 1
        fi
    fi

    ATTEMPTS=$((ATTEMPTS + 1))

    # Show progress every 10 seconds
    if [ $((ATTEMPTS % 10)) -eq 0 ]; then
        echo "   Still waiting... (${ATTEMPTS}s)"
    fi
done

echo ""
echo "⏱️  Timeout: No new message received within 60 seconds."
echo "   Please run this script again and send a message."
exit 1
