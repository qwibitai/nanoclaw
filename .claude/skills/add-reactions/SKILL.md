---
name: add-reactions
description: Add WhatsApp emoji reaction support — receive, send, store, and search reactions.
---

# Add Reactions

This skill adds emoji reaction support to NanoClaw's WhatsApp channel: receive and store reactions, send reactions from the container agent via MCP tool, and query reaction history from SQLite.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/status-tracker.ts` exists:

```bash
test -f src/status-tracker.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

## Phase 2: Apply Code Changes

### Ensure WhatsApp fork remote

```bash
git remote -v
```

If `whatsapp` is missing, add it:

```bash
git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git
```

### Merge the skill branch

```bash
git fetch whatsapp skill/reactions
git merge whatsapp/skill/reactions || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This adds:
- `scripts/migrate-reactions.ts` (database migration for `reactions` table with composite PK and indexes)
- `src/status-tracker.ts` (forward-only emoji state machine for message lifecycle signaling, with persistence and retry)
- `src/status-tracker.test.ts` (unit tests for StatusTracker)
- `container/skills/reactions/SKILL.md` (agent-facing documentation for the `react_to_message` MCP tool)
- Reaction support in `src/db.ts`, `src/channels/whatsapp.ts`, `src/types.ts`, `src/ipc.ts`, `src/index.ts`, `src/group-queue.ts`, and `container/agent-runner/src/ipc-mcp-stdio.ts`

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
