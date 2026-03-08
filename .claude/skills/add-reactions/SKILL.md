---
name: add-reactions
description: Add WhatsApp emoji reaction support — receive, send, store, and search reactions.
---

# Add Reactions

This skill adds emoji reaction support to NanoClaw's WhatsApp channel: receive and store reactions, send reactions from the container agent via MCP tool, and query reaction history from SQLite.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `reactions` is in `applied_skills`, skip to Phase 3 (Verify). The code changes are already in place.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-reactions
```

This deterministically:
- Adds `scripts/migrate-reactions.ts` (database migration for `reactions` table with composite PK and indexes)
- Adds `src/status-tracker.ts` (forward-only emoji state machine for message lifecycle signaling, with persistence and retry)
- Adds `src/status-tracker.test.ts` (unit tests for StatusTracker)
- Adds `container/skills/reactions/SKILL.md` (agent-facing documentation for the `react_to_message` MCP tool)
- Modifies `src/db.ts` — adds `Reaction` interface, `reactions` table schema, `storeReaction`, `getReactionsForMessage`, `getMessagesByReaction`, `getReactionsByUser`, `getReactionStats`, `getLatestMessage`, `getMessageFromMe`
- Modifies `src/channels/whatsapp.ts` — adds `messages.reaction` event handler, `sendReaction()`, `reactToLatestMessage()` methods
- Modifies `src/types.ts` — adds optional `sendReaction` and `reactToLatestMessage` to `Channel` interface
- Modifies `src/ipc.ts` — adds `type: 'reaction'` IPC handler with group-scoped authorization
- Modifies `src/index.ts` — wires `sendReaction` dependency into IPC watcher
- Modifies `src/group-queue.ts` — `GroupQueue` class for per-group container concurrency with retry
- Modifies `container/agent-runner/src/ipc-mcp-stdio.ts` — adds `react_to_message` MCP tool exposed to container agents
- Records the application in `.nanoclaw/state.yaml`

### Run database migration

```bash
npx tsx scripts/migrate-reactions.ts
```

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Verify

### Build and restart

```bash
npm run build
```

Linux:
```bash
systemctl --user restart nanoclaw
```

macOS:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Test receiving reactions

1. Send a message from your phone
2. React to it with an emoji on WhatsApp
3. Check the database:

```bash
sqlite3 store/messages.db "SELECT * FROM reactions ORDER BY timestamp DESC LIMIT 5;"
```

### Test sending reactions

Ask the agent to react to a message via the `react_to_message` MCP tool. Check your phone — the reaction should appear on the message.

## Troubleshooting

### Reactions not appearing in database

- Check NanoClaw logs for `Failed to process reaction` errors
- Verify the chat is registered
- Confirm the service is running

### Migration fails

- Ensure `store/messages.db` exists and is accessible
- If "table reactions already exists", the migration already ran — skip it

### Agent can't send reactions

- Check IPC logs for `Unauthorized IPC reaction attempt blocked` — the agent can only react in its own group's chat
- Verify WhatsApp is connected: check logs for connection status
