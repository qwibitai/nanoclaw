---
name: add-cli
description: Add a local CLI channel to NanoClaw so you can message the agent from your terminal. Use when user wants to interact with the agent without setting up Discord/WhatsApp/etc.
---

# Add CLI Channel

This skill adds a CLI channel to NanoClaw. Once added, the user can send messages to the agent from a terminal and see responses printed to stdout. This is the simplest possible channel — no external services, no tokens, no auth.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/cli.ts` exists. If it does, skip to Phase 3 (Verify).

## Phase 2: Apply Code Changes

### Create the CLI channel

Create `src/channels/cli.ts`. This implements the `Channel` interface:

- **JID prefix**: `cli:` — CLI channels own any JID starting with `cli:`
- **connect()**: Starts a readline interface on stdin. Each line the user types becomes an inbound message delivered via `onMessage()`. The JID comes from the registered group whose JID starts with `cli:`. If no registered group has a `cli:` JID, use `cli:main`.
- **sendMessage()**: Prints the agent's response to stdout, prefixed with the assistant name. Strip any XML tags like `<internal>...</internal>` before printing.
- **isConnected()**: Returns true once connect() has been called.
- **ownsJid()**: Returns true if the JID starts with `cli:`.
- **disconnect()**: Closes the readline interface.
- **Self-registration**: At module level, call `registerChannel('cli', factory)` where the factory returns a new CLI channel instance. The factory should always return an instance (never null) — CLI has no credentials to check.

Important implementation details:
- Use Node's built-in `readline` module (no new dependencies).
- Show a prompt like `You: ` when waiting for input.
- When printing agent responses, prefix with `Andy: ` (or the assistant name).
- Handle multi-line responses by printing each line.
- After printing a response, show the `You: ` prompt again.
- On stdin close (Ctrl+D), call disconnect gracefully.

### Register in the channel barrel file

Append to `src/channels/index.ts`:

```typescript
import './cli.js';
```

### Create tests

Create `src/channels/cli.test.ts` with tests covering:
- Channel self-registers as 'cli' in the registry
- `ownsJid()` returns true for `cli:*` JIDs, false for others
- `sendMessage()` writes to stdout
- Factory always returns an instance (never null)

Use the same test patterns as `src/channels/registry.test.ts`.

### Validate

```bash
npm run build
npx vitest run src/channels/cli.test.ts
npx vitest run
```

All tests must pass and build must be clean.

## Phase 3: Verify

### Create the CLI tool script

Create `scripts/cli.sh` — a convenience wrapper:

```bash
#!/bin/bash
# Send a message to the NanoClaw agent via CLI channel.
# Usage: ./scripts/cli.sh "your message here"
#
# For interactive mode, just run the NanoClaw service with CLI channel
# enabled and type messages directly.

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "$1" ]; then
  echo "Usage: $0 \"your message\""
  echo "  Or start NanoClaw with CLI channel for interactive mode."
  exit 1
fi

# Insert message directly into SQLite and let the polling loop pick it up
MESSAGE="$1"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
MSG_ID="cli-$(date +%s)-$$"

sqlite3 "$PROJECT_ROOT/store/messages.db" "
  INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
  VALUES ('$MSG_ID', 'cli:main', 'cli:user', 'User', '$MESSAGE', '$TIMESTAMP', 0, 0);
"

echo "Message sent. Watch logs for response: tail -f $PROJECT_ROOT/logs/nanoclaw.log"
```

Make it executable: `chmod +x scripts/cli.sh`

### Ensure main group is registered with CLI channel

Check the database:
```bash
sqlite3 store/messages.db "SELECT jid, name, folder FROM registered_groups WHERE jid LIKE 'cli:%';"
```

If no CLI group is registered, register one:
```bash
npx tsx setup/index.ts --step register -- --jid "cli:main" --name "Main CLI" --folder "main" --trigger "@Andy" --channel cli --no-trigger-required --is-main
```

### Test interactively

Start the service and verify the CLI channel connects:
```bash
npm run dev
```

You should see in the logs:
```
INFO: CLI channel connected
INFO: NanoClaw running (trigger: @Andy)
```

Type a message and verify the agent responds.

## Phase 4: Commit via SDLC workflow

Follow the SDLC conventions in CLAUDE.md:

```bash
git checkout -b feature/add-cli
git add src/channels/cli.ts src/channels/cli.test.ts src/channels/index.ts scripts/cli.sh
git commit -m "Add CLI channel for terminal-based interaction

Implements a readline-based channel that accepts messages from stdin
and prints agent responses to stdout. No external services or tokens
needed. Includes convenience script for one-shot messages.

Co-Authored-By: Claude <noreply@anthropic.com>"
git push -u origin feature/add-cli
gh pr create --repo startakovsky/nanoclaw --title "Add CLI channel" --body "Adds terminal-based channel for interacting with the agent without external messaging services."
```

## After Setup

With the CLI channel installed, you can:
- **Interactive mode**: Run `npm run dev` and type messages directly
- **One-shot mode**: `./scripts/cli.sh "What's on my schedule today?"`
- **Still headless**: The CLI channel is just another channel. If stdin isn't a TTY (e.g., running as a service), it stays quiet and other channels handle input.
