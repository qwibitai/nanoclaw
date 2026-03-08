# Flo Family - NanoClaw + Telegram Setup

## Status: In Progress

### ✅ Completed Steps

1. **NanoClaw Installation**
   - ✅ Cloned repository from https://github.com/qwibitai/nanoclaw
   - ✅ Bootstrap completed: Node.js 24.13.0 + dependencies installed
   - ✅ Container runtime: Docker is running
   - ✅ Container image built and tested: `nanoclaw-agent:latest`

2. **Telegram Channel Integration**
   - ✅ Applied `/add-telegram` skill
   - ✅ Installed grammy package (Telegram bot framework)
   - ✅ All 376 tests passing (including 46 Telegram tests)
   - ✅ Build successful

3. **Configuration Files**
   - ✅ Created `.env` file with placeholder for credentials
   - ✅ Initialized skills system (`.nanoclaw/state.yaml`)

### 🔴 Pending Steps (Requires Manual Action)

#### Step 1: Create Telegram Bot via BotFather

**IMPORTANT**: The bot must be named **@FlofamilyBot** as specified in the architecture.

1. Open Telegram and search for `@BotFather`
2. Send `/newbot`
3. When prompted for bot name, enter: `Flo Family Bot`
4. When prompted for username, enter: `FlofamilyBot`
   - Note: Username must be unique. If taken, try variations like `FlofamilyAssistantBot`
5. BotFather will respond with a bot token that looks like:
   ```
   123456789:ABCdefGHIjklMNOpqrsTUVwxyz1234567890
   ```
6. **Copy this token** - you'll need it in the next step

#### Step 2: Configure Bot Token

1. Open `/root/.openclaw/workspace/nanoclaw/.env`
2. Replace `ANTHROPIC_API_KEY=your-api-key-here` with actual Anthropic API key
3. Replace `# TELEGRAM_BOT_TOKEN=` with:
   ```
   TELEGRAM_BOT_TOKEN=<paste-your-token-here>
   ```
4. Sync to container environment:
   ```bash
   cd /root/.openclaw/workspace/nanoclaw
   mkdir -p data/env
   cp .env data/env/env
   ```

#### Step 3: Disable Group Privacy (Important!)

By default, Telegram bots only see @mentions in groups. For Flo Family to process all messages:

1. Open Telegram and search for `@BotFather`
2. Send `/mybots`
3. Select your bot (`FlofamilyBot`)
4. Go to **Bot Settings** > **Group Privacy** > **Turn off**

This allows the bot to see all messages in group chats (required for natural language parsing).

#### Step 4: Build and Start Service

```bash
cd /root/.openclaw/workspace/nanoclaw
npm run build

# For WSL (systemd):
npx tsx setup/index.ts --step service
systemctl --user start nanoclaw

# Or manually:
npm run dev  # For testing
```

#### Step 5: Register Chat (Test Group)

1. Create a test Telegram group
2. Add the @FlofamilyBot to the group
3. Send `/chatid` in the group to get the chat ID
4. Register the chat:
   ```bash
   # TODO: Use NanoClaw's registration flow
   # The chat ID will be in format: tg:-1001234567890
   ```

#### Step 6: Test Basic Messaging

1. Send a test message in the registered group: `@Andy hello`
   - Note: Default trigger is `@Andy` - can be customized
2. Check logs:
   ```bash
   tail -f /root/.openclaw/workspace/nanoclaw/logs/nanoclaw.log
   ```
3. Bot should respond within a few seconds

### 🎯 Next Steps for Flo Family Integration

After basic Telegram is working:

1. **Implement Routing Layer**
   - Map `telegram_chat_id` → `family_id` → isolated container
   - Query Django API for family lookup
   - Route messages to correct family container

2. **Host-Side MCP Servers**
   - Create MCP server for Django API calls
   - Create MCP server for Google Calendar
   - Implement family_id validation in MCP calls

3. **Family-Specific Containers**
   - Folder structure: `groups/telegram_<fam_id>/`
   - Each family has isolated CLAUDE.md memory
   - Per-family API tokens stored in Django

4. **Event Processing Flow**
   - Message arrives → route to family container
   - Claude parses event details
   - Call MCP tool: `db_write_event()` → Django API
   - Present confirmation UI
   - On confirmation: `calendar_create_event()` → Google Calendar

### 📚 Architecture References

- **Architecture Doc**: `/root/.openclaw/workspace/memory/flofamily/ARCHITECTURE.md`
- **Trello Ticket**: https://trello.com/c/EgbdDR3Q
- **NanoClaw Docs**: `/root/.openclaw/workspace/nanoclaw/README.md`
- **Telegram Skill**: `/root/.openclaw/workspace/nanoclaw/.claude/skills/add-telegram/SKILL.md`

### 🔍 Troubleshooting

**Bot not responding:**
- Check `TELEGRAM_BOT_TOKEN` is set in `.env` AND synced to `data/env/env`
- Verify service is running: `systemctl --user status nanoclaw`
- Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'tg:%'"`

**Only responds to @mentions:**
- Group Privacy is enabled - follow Step 3 to disable

**Container errors:**
- Verify Docker is running: `docker info`
- Check container image exists: `docker images | grep nanoclaw`
- View container logs: `tail -f groups/main/logs/container-*.log`

### 📝 Notes

- This is running on Jade's WSL machine
- NanoClaw installed in: `/root/.openclaw/workspace/nanoclaw`
- Bot username: Must be unique (if @FlofamilyBot is taken, document the actual name used)
- API key: Required for Claude to process messages
