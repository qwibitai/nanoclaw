#!/usr/bin/env bash
# Add a new Telegram group to nanoclaw.
#
# Usage:
#   ./scripts/add-group.sh <jid> <name> <folder> [--no-trigger]
#
# Arguments:
#   jid      - Telegram chat ID in tg: format  (e.g. tg:-1001234567890)
#              Get it by sending /chatid in the group after adding the bot.
#   name     - Human-readable group name       (e.g. "Engineering Team")
#   folder   - Short folder name under groups/ (e.g. engineering)
#
# Options:
#   --no-trigger   Respond to ALL messages, not just @Mani mentions.
#                  Use this for personal / 1-on-1 chats.
#
# Examples:
#   ./scripts/add-group.sh tg:-1001234567890 "Engineering" engineering
#   ./scripts/add-group.sh tg:-1009876543210 "Personal"    personal   --no-trigger
#   ./scripts/add-group.sh tg:-1001111111111 "Stock Team"  stock-team
#   ./scripts/add-group.sh tg:-1002222222222 "Marketing"   marketing

set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────────────────
JID="${1:-}"
NAME="${2:-}"
FOLDER="${3:-}"
REQUIRE_TRIGGER=true

for arg in "${@:4}"; do
  [[ "$arg" == "--no-trigger" ]] && REQUIRE_TRIGGER=false
done

if [[ -z "$JID" || -z "$NAME" || -z "$FOLDER" ]]; then
  echo "Usage: $0 <jid> <name> <folder> [--no-trigger]"
  echo ""
  echo "Example: $0 tg:-1001234567890 \"Engineering\" engineering"
  exit 1
fi

if [[ "$JID" != tg:* ]]; then
  echo "Error: JID must start with 'tg:' (e.g. tg:-1001234567890)"
  echo "Send /chatid in the Telegram group to get it."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load ASSISTANT_NAME from .env if available
ASSISTANT_NAME="Mani"
if [[ -f "$ROOT/.env" ]]; then
  val=$(grep -E '^ASSISTANT_NAME=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '"')
  [[ -n "$val" ]] && ASSISTANT_NAME="$val"
fi

TRIGGER="@${ASSISTANT_NAME}"
REQUIRE_TRIGGER_FLAG=""
[[ "$REQUIRE_TRIGGER" == "false" ]] && REQUIRE_TRIGGER_FLAG="--no-trigger-required"

echo "────────────────────────────────────"
echo "  Adding Telegram group to nanoclaw"
echo "────────────────────────────────────"
echo "  JID     : $JID"
echo "  Name    : $NAME"
echo "  Folder  : $FOLDER"
echo "  Trigger : $TRIGGER  (required: $REQUIRE_TRIGGER)"
echo ""

# ── Register in DB ────────────────────────────────────────────────────────────
cd "$ROOT"
npx tsx src/setup/index.ts --step register \
  --jid "$JID" \
  --name "$NAME" \
  --folder "$FOLDER" \
  --trigger "$TRIGGER" \
  --assistant-name "$ASSISTANT_NAME" \
  $REQUIRE_TRIGGER_FLAG

# ── Create CLAUDE.md from template ───────────────────────────────────────────
GROUP_DIR="$ROOT/groups/$FOLDER"
CLAUDE_FILE="$GROUP_DIR/CLAUDE.md"

if [[ ! -f "$CLAUDE_FILE" ]]; then
  mkdir -p "$GROUP_DIR/logs"
  cat > "$CLAUDE_FILE" <<EOF
# ${ASSISTANT_NAME} — ${NAME}

You are ${ASSISTANT_NAME}, an assistant for the *${NAME}* group.

## Communication

Your output is sent to the group. Use \`mcp__nanoclaw__send_message\` to send
an immediate reply while you're still working on something longer.

Wrap internal reasoning in \`<internal>\` tags — logged but not shown to users.

## Message Formatting

NEVER use markdown. Only Telegram formatting:
- *single asterisks* for bold (NEVER **double**)
- _underscores_ for italic
- • bullet points
- \`\`\`triple backticks\`\`\` for code

No ## headings. No [links](url).

## Memory

Your workspace is at \`/workspace/group/\`. Files you create here persist across conversations.

The \`conversations/\` folder contains past conversation history — search it to recall context.
EOF
  echo "✓ Created $CLAUDE_FILE"
else
  echo "  CLAUDE.md already exists — skipping template (keeping existing)"
fi

echo ""
echo "✓ Group '${NAME}' registered."
echo ""
echo "Next steps:"
echo "  1. Make sure the bot is an admin in the Telegram group"
echo "  2. Send a message in the group to verify it responds"
if [[ "$REQUIRE_TRIGGER" == "true" ]]; then
  echo "  3. Messages must include ${TRIGGER} to trigger the bot"
else
  echo "  3. Bot responds to ALL messages in this group (no trigger needed)"
fi
