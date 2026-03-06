---
name: add-reactions
description: Add channel-agnostic emoji reactions to NanoClaw. Agents can react to messages via MCP tool; quote context is rendered in message history.
---

# Add Reactions

This skill adds emoji reaction support to NanoClaw:

1. **Types** — `Reaction` interface, `sendReaction`/`reactToLatestMessage` optional methods on `Channel`, and quote fields on `NewMessage`.
2. **Database** — `reactions` table, `storeReaction()`, `getLatestMessage()`, `getMessageById()` helpers, quote column storage/retrieval.
3. **Router** — Renders quoted message context (`> sender: excerpt`) in `formatMessages()`.
4. **IPC** — Handles `type: 'reaction'` messages from container agents.
5. **MCP tool** — `react_to_message` tool available inside agent containers.

## Apply

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-reactions
npm run build
```

## Channel Integration

After applying, channels that support reactions should implement:
- `sendReaction(chatJid, messageId, emoji)` — send a reaction to a specific message
- `reactToLatestMessage(chatJid, emoji)` — react to the most recent message

The IPC layer routes reaction requests to the appropriate channel automatically.
