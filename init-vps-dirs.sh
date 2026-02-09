#!/bin/bash
# Initialize VPS directories for NanoClaw
# Run this once before starting the bot for the first time

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_ROOT"

echo "=== Initializing NanoClaw VPS Directories ==="
echo ""

# Read bot number from argument (default: bot1)
BOT_NUM="${1:-bot1}"

echo "Setting up directories for: $BOT_NUM"
echo ""

# Create directory structure
DIRS=(
  "groups-$BOT_NUM/main"
  "groups-$BOT_NUM/main/.claude/skills"
  "data-$BOT_NUM/sessions/main/.claude"
  "data-$BOT_NUM/ipc/main/messages"
  "data-$BOT_NUM/ipc/main/tasks"
  "store-$BOT_NUM"
)

for dir in "${DIRS[@]}"; do
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    echo "✅ Created: $dir"
  else
    echo "   Exists:  $dir"
  fi
done

echo ""
echo "✅ Directory initialization complete!"
echo ""
echo "Next steps:"
echo "1. Ensure .env file exists with required tokens"
echo "2. Build agent container: cd container && ./build.sh"
echo "3. Start service: docker compose -f docker-compose.vps.yml up -d --build"
echo "4. Pair main group: ./pair-main-group.sh"
echo ""
