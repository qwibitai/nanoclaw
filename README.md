# DotClaw

A personal Claude assistant accessible via Telegram. Runs Claude Agent SDK in isolated Docker containers with persistent memory, scheduled tasks, and web access.

Forked from [NanoClaw](https://github.com/gavrielc/nanoclaw).

## Features

- **Telegram Integration** - Chat with Claude from your phone via Telegram bot
- **Container Isolation** - Each conversation runs in a Docker container with only explicitly mounted directories accessible
- **Persistent Memory** - Per-group `CLAUDE.md` files store context that persists across sessions
- **Scheduled Tasks** - Set up recurring or one-time tasks with cron expressions, intervals, or timestamps
- **Web Access** - Search the web and fetch content from URLs
- **Multi-Group Support** - Register multiple Telegram chats with isolated contexts

## Requirements

- macOS or Linux
- Node.js 20+
- [Docker](https://docker.com/products/docker-desktop)
- [Claude Code CLI](https://claude.ai/download)
- Telegram bot token (create via [@BotFather](https://t.me/botfather))

## Installation

```bash
git clone https://github.com/yourusername/dotclaw.git
cd dotclaw
npm install
```

### Configuration

1. Create a `.env` file with your credentials:

```bash
# Telegram bot token from @BotFather
TELEGRAM_BOT_TOKEN=your_bot_token_here

# Claude authentication (choose one)
CLAUDE_CODE_OAUTH_TOKEN=your_oauth_token   # From ~/.claude/.credentials.json
# OR
ANTHROPIC_API_KEY=your_api_key             # From console.anthropic.com
```

2. Build the Docker container:

```bash
./container/build.sh
```

3. Register your Telegram chat in `data/registered_groups.json`:

```json
{
  "YOUR_CHAT_ID": {
    "name": "main",
    "folder": "main",
    "trigger": "@Rain",
    "added_at": "2024-01-01T00:00:00.000Z"
  }
}
```

### First Group Setup (Telegram)

To find your chat ID:

1. Message your bot (or create a group and add the bot).
2. Use @userinfobot or @get_id_bot in Telegram to get the chat ID.
3. Add the entry to `data/registered_groups.json` and restart the app.

Example entry:

```json
{
  "-123456789": {
    "name": "family-chat",
    "folder": "family-chat",
    "trigger": "@Rain",
    "added_at": "2024-01-01T00:00:00.000Z"
  }
}
```

4. Build and run:

```bash
npm run build
npm start
```

### Running as a Service (macOS)

```bash
# Copy and configure the launchd plist
cp launchd/com.dotclaw.plist ~/Library/LaunchAgents/

# Edit the plist to set correct paths (NODE_PATH, PROJECT_ROOT, HOME)

# Load the service
launchctl load ~/Library/LaunchAgents/com.dotclaw.plist
```

## Usage

Message your bot with the trigger word (default: `@Rain`):

```
@Rain what's the weather in New York?
@Rain remind me every Monday at 9am to check my emails
@Rain search for recent news about AI
```

In your main channel, you can manage groups and tasks:

```
@Rain list all scheduled tasks
@Rain pause task [id]
@Rain add a new group for "Family Chat" with chat ID -123456789
```

## Project Structure

```
dotclaw/
├── src/
│   ├── index.ts           # Main app: Telegram, routing, IPC
│   ├── config.ts          # Configuration constants
│   ├── container-runner.ts # Spawns Docker containers
│   ├── task-scheduler.ts  # Runs scheduled tasks
│   └── db.ts              # SQLite operations
├── container/
│   ├── Dockerfile         # Agent container image
│   ├── build.sh           # Build script
│   └── agent-runner/      # Code that runs inside containers
├── groups/
│   ├── global/CLAUDE.md   # Shared memory (read by all groups)
│   └── main/CLAUDE.md     # Main channel memory
├── data/
│   ├── registered_groups.json
│   └── sessions.json
└── store/
    └── messages.db        # SQLite database
```

## Architecture

```
Telegram (Telegraf) → SQLite → Event Handler → Docker Container (Claude Agent SDK) → Response
```

- Single Node.js process handles Telegram connection, message routing, and scheduling
- Each agent invocation spawns an isolated Docker container
- Containers communicate back via filesystem-based IPC
- Memory persists in `CLAUDE.md` files per group

## Development

```bash
npm run dev      # Run with hot reload
npm run build    # Compile TypeScript
npm run typecheck # Type check without emitting
```

## License

MIT
