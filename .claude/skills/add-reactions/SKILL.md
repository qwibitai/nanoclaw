---
name: add-reactions
description: Add WhatsApp emoji reaction support — receive, send, store, and search reactions.
---

# Add Reactions

This skill adds complete emoji reaction support to NanoClaw's WhatsApp channel:
- Receive and track reactions from WhatsApp
- Send reactions from the container agent via MCP tool
- Store reactions in SQLite with full history
- Optional RAG integration for searching by reactions

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `reactions` is in `applied_skills`, skip to Phase 4 (Verify). The code changes are already in place.

## Phase 2: Apply Code Changes

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-reactions
```

This deterministically:
- Adds `scripts/migrate-reactions.ts` (database migration for reactions table)
- Records the application in `.nanoclaw/state.yaml`

### Run database migration

```bash
npx tsx scripts/migrate-reactions.ts
```

This creates the `reactions` table with composite primary key and indexes.

### Modify src/db.ts

Add the Reaction interface after existing interfaces:

```typescript
export interface Reaction {
  message_id: string;
  message_chat_jid: string;
  reactor_jid: string;
  reactor_name?: string;
  emoji: string;
  timestamp: string;
}
```

Add the reactions table to `createSchema()`:

```sql
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL,
  message_chat_jid TEXT NOT NULL,
  reactor_jid TEXT NOT NULL,
  reactor_name TEXT,
  emoji TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  PRIMARY KEY (message_id, message_chat_jid, reactor_jid)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id, message_chat_jid);
CREATE INDEX IF NOT EXISTS idx_reactions_reactor ON reactions(reactor_jid);
CREATE INDEX IF NOT EXISTS idx_reactions_emoji ON reactions(emoji);
CREATE INDEX IF NOT EXISTS idx_reactions_timestamp ON reactions(timestamp);
```

Add query functions for reactions (avoids opening a second connection):

```typescript
/**
 * Look up whether a specific message was sent by us
 */
export function getMessageFromMe(messageId: string, chatJid: string): boolean {
  const row = db
    .prepare(`SELECT is_from_me FROM messages WHERE id = ? AND chat_jid = ? LIMIT 1`)
    .get(messageId, chatJid) as { is_from_me: number | null } | undefined;
  return row?.is_from_me === 1;
}

/**
 * Get the most recent message for a chat (with fromMe flag)
 */
export function getLatestMessage(chatJid: string): { id: string; fromMe: boolean } | undefined {
  const row = db
    .prepare(`SELECT id, is_from_me FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT 1`)
    .get(chatJid) as { id: string; is_from_me: number | null } | undefined;
  if (!row) return undefined;
  return { id: row.id, fromMe: row.is_from_me === 1 };
}
```

Add these functions before any JSON migration sections:

```typescript
/**
 * Store or update a reaction. Empty emoji removes the reaction.
 */
export function storeReaction(reaction: Reaction): void {
  if (!reaction.emoji) {
    db.prepare(
      `DELETE FROM reactions WHERE message_id = ? AND message_chat_jid = ? AND reactor_jid = ?`
    ).run(reaction.message_id, reaction.message_chat_jid, reaction.reactor_jid);
    return;
  }

  db.prepare(
    `INSERT OR REPLACE INTO reactions (message_id, message_chat_jid, reactor_jid, reactor_name, emoji, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    reaction.message_id,
    reaction.message_chat_jid,
    reaction.reactor_jid,
    reaction.reactor_name || null,
    reaction.emoji,
    reaction.timestamp
  );
}

/**
 * Get all reactions for a specific message
 */
export function getReactionsForMessage(
  messageId: string,
  chatJid: string
): Reaction[] {
  return db
    .prepare(
      `SELECT * FROM reactions WHERE message_id = ? AND message_chat_jid = ? ORDER BY timestamp`
    )
    .all(messageId, chatJid) as Reaction[];
}

/**
 * Get all messages a person reacted to with a specific emoji.
 * Useful for "show me messages I bookmarked".
 */
export function getMessagesByReaction(
  reactorJid: string,
  emoji: string,
  chatJid?: string
): Array<Reaction & { content: string; sender_name: string; message_timestamp: string }> {
  const sql = chatJid
    ? `
      SELECT r.*, m.content, m.sender_name, m.timestamp as message_timestamp
      FROM reactions r
      JOIN messages m ON r.message_id = m.id AND r.message_chat_jid = m.chat_jid
      WHERE r.reactor_jid = ? AND r.emoji = ? AND r.message_chat_jid = ?
      ORDER BY r.timestamp DESC
    `
    : `
      SELECT r.*, m.content, m.sender_name, m.timestamp as message_timestamp
      FROM reactions r
      JOIN messages m ON r.message_id = m.id AND r.message_chat_jid = m.chat_jid
      WHERE r.reactor_jid = ? AND r.emoji = ?
      ORDER BY r.timestamp DESC
    `;

  type Result = Reaction & { content: string; sender_name: string; message_timestamp: string };
  return chatJid
    ? (db.prepare(sql).all(reactorJid, emoji, chatJid) as Result[])
    : (db.prepare(sql).all(reactorJid, emoji) as Result[]);
}

/**
 * Get all reactions made by a specific person
 */
export function getReactionsByUser(
  reactorJid: string,
  limit: number = 50
): Reaction[] {
  return db
    .prepare(
      `SELECT * FROM reactions WHERE reactor_jid = ? ORDER BY timestamp DESC LIMIT ?`
    )
    .all(reactorJid, limit) as Reaction[];
}

/**
 * Get reaction statistics for a chat or globally
 */
export function getReactionStats(chatJid?: string): Array<{
  emoji: string;
  count: number;
}> {
  const sql = chatJid
    ? `
      SELECT emoji, COUNT(*) as count
      FROM reactions
      WHERE message_chat_jid = ?
      GROUP BY emoji
      ORDER BY count DESC
    `
    : `
      SELECT emoji, COUNT(*) as count
      FROM reactions
      GROUP BY emoji
      ORDER BY count DESC
    `;

  type Result = { emoji: string; count: number };
  return chatJid
    ? (db.prepare(sql).all(chatJid) as Result[])
    : (db.prepare(sql).all() as Result[]);
}
```

### Modify src/channels/whatsapp.ts

Add static imports for `storeReaction` and `getLatestMessage` at the top of the file:

```typescript
import { storeReaction, getLatestMessage } from '../db.js';
```

Add the reaction event handler after the `messages.upsert` handler:

```typescript
// Listen for message reactions
this.sock.ev.on('messages.reaction', async (reactions) => {
  for (const { key, reaction } of reactions) {
    try {
      const messageId = key.id;
      if (!messageId) continue;

      const rawChatJid = key.remoteJid;
      if (!rawChatJid || rawChatJid === 'status@broadcast') continue;

      const chatJid = await this.translateJid(rawChatJid);

      const groups = this.opts.registeredGroups();
      if (!groups[chatJid]) continue;

      // reaction.key identifies the reactor; key identifies the reacted-to message
      const reactorJid = reaction.key?.participant || reaction.key?.remoteJid || '';
      const emoji = reaction.text || '';
      const timestamp = reaction.senderTimestampMs
        ? new Date(Number(reaction.senderTimestampMs)).toISOString()
        : new Date().toISOString();

      storeReaction({
        message_id: messageId,
        message_chat_jid: chatJid,
        reactor_jid: reactorJid,
        reactor_name: reactorJid.split('@')[0],
        emoji,
        timestamp,
      });

      logger.info(
        {
          chatJid,
          messageId: messageId.slice(0, 10) + '...',
          reactor: reactorJid.split('@')[0],
          emoji: emoji || '(removed)',
        },
        emoji ? 'Reaction added' : 'Reaction removed'
      );
    } catch (err) {
      logger.error({ err }, 'Failed to process reaction');
    }
  }
});
```

Add these methods to the WhatsAppChannel class near `sendMessage()`:

```typescript
/**
 * Send a reaction to a specific message
 */
async sendReaction(
  chatJid: string,
  messageKey: { id: string; remoteJid: string; fromMe?: boolean; participant?: string },
  emoji: string
): Promise<void> {
  if (!this.connected) {
    logger.warn({ chatJid, emoji }, 'Cannot send reaction - not connected');
    throw new Error('Not connected to WhatsApp');
  }

  try {
    await this.sock.sendMessage(chatJid, {
      react: {
        text: emoji,
        key: messageKey,
      },
    });

    logger.info(
      {
        chatJid,
        messageId: messageKey.id?.slice(0, 10) + '...',
        emoji: emoji || '(removed)',
      },
      emoji ? 'Reaction sent' : 'Reaction removed'
    );
  } catch (err) {
    logger.error({ chatJid, emoji, err }, 'Failed to send reaction');
    throw err;
  }
}

/**
 * React to the most recent message in a chat
 */
async reactToLatestMessage(chatJid: string, emoji: string): Promise<void> {
  const latest = getLatestMessage(chatJid);
  if (!latest) {
    throw new Error(`No messages found for chat ${chatJid}`);
  }

  const messageKey = {
    id: latest.id,
    remoteJid: chatJid,
    fromMe: latest.fromMe,
  };

  await this.sendReaction(chatJid, messageKey, emoji);
}
```

### Modify src/types.ts

Add optional reaction methods to the `Channel` interface after `setTyping`:

```typescript
sendReaction?(
  chatJid: string,
  messageKey: { id: string; remoteJid: string; fromMe?: boolean; participant?: string },
  emoji: string
): Promise<void>;

reactToLatestMessage?(chatJid: string, emoji: string): Promise<void>;
```

### Modify src/ipc.ts

Add `sendReaction` to the `IpcDeps` interface:

```typescript
sendReaction: (jid: string, emoji: string, messageId?: string) => Promise<void>;
```

In the IPC message processing loop, add a handler for `type: 'reaction'` after the existing `type: 'message'` handler:

```typescript
} else if (data.type === 'reaction' && data.chatJid && data.emoji) {
  const targetGroup = registeredGroups[data.chatJid];
  if (
    isMain ||
    (targetGroup && targetGroup.folder === sourceGroup)
  ) {
    try {
      await deps.sendReaction(data.chatJid, data.emoji, data.messageId);
      logger.info(
        { chatJid: data.chatJid, emoji: data.emoji, sourceGroup },
        'IPC reaction sent',
      );
    } catch (err) {
      logger.error(
        { chatJid: data.chatJid, emoji: data.emoji, sourceGroup, err },
        'IPC reaction failed',
      );
    }
  } else {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC reaction attempt blocked',
    );
  }
}
```

### Modify src/index.ts

Wire the `sendReaction` dependency in the `startIpcWatcher()` call. Import `getMessageFromMe` from `./db.js` and add:

```typescript
sendReaction: async (jid, emoji, messageId) => {
  const channel = findChannel(channels, jid);
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (messageId) {
    if (!channel.sendReaction) throw new Error('Channel does not support sendReaction');
    const messageKey = { id: messageId, remoteJid: jid, fromMe: getMessageFromMe(messageId, jid) };
    await channel.sendReaction(jid, messageKey, emoji);
  } else {
    if (!channel.reactToLatestMessage) throw new Error('Channel does not support reactions');
    await channel.reactToLatestMessage(jid, emoji);
  }
},
```

### Modify container/agent-runner/src/ipc-mcp-stdio.ts

Add the `react_to_message` MCP tool after the existing `send_message` tool:

```typescript
server.tool(
  'react_to_message',
  'React to a message with an emoji. Omit message_id to react to the most recent message in the chat.',
  {
    emoji: z.string().describe('The emoji to react with (e.g. "👍", "❤️", "🔥")'),
    message_id: z.string().optional().describe('The message ID to react to. If omitted, reacts to the latest message in the chat.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'reaction',
      chatJid,
      emoji: args.emoji,
      messageId: args.message_id || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `Reaction ${args.emoji} sent.` }] };
  },
);
```

### Add container skill documentation

Create `container/skills/reactions/SKILL.md` to teach the container agent how to use the tool:

```markdown
---
name: reactions
description: React to WhatsApp messages with emoji. Use when the user asks you to react, when acknowledging a message with a reaction makes sense, or when you want to express a quick response without sending a full message.
---

# Reactions

React to messages with emoji using the `mcp__nanoclaw__react_to_message` tool.

## When to use

- User explicitly asks you to react ("react with a thumbs up", "heart that message")
- Quick acknowledgment is more appropriate than a full text reply
- Expressing agreement, approval, or emotion about a specific message

## How to use

### React to the latest message

Omitting `message_id` reacts to the most recent message in the chat.

### React to a specific message

Pass a `message_id` to react to a specific message. Find message IDs by querying the messages database.

### Remove a reaction

Send an empty string emoji to remove your reaction.

## Common emoji

| Emoji | When to use |
|-------|-------------|
| 👍 | Acknowledgment, approval |
| ❤️ | Appreciation, love |
| 😂 | Something funny |
| 🔥 | Impressive, exciting |
| 🎉 | Celebration, congrats |
| 🙏 | Thanks, prayer |
| ✅ | Task done, confirmed |
| ❓ | Needs clarification |
```

### Document the capability for the container agent

Add a brief reference to the "What You Can Do" section of `groups/main/CLAUDE.md`:

```markdown
- **React to messages** with emoji using the `reactions` skill
```

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Build and Restart

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

## Phase 4: Verify

### Test receiving reactions

1. Send a message from your phone
2. React to it with an emoji on WhatsApp
3. Check the database:

```bash
sqlite3 store/messages.db "SELECT * FROM reactions ORDER BY timestamp DESC LIMIT 5;"
```

### Test sending reactions

Ask the agent to react to a message via the `react_to_message` MCP tool, or use the container skill directly.

Check your phone — the reaction should appear on the message.

## Phase 5: Optional RAG Integration

If you want to search messages by reactions, add reaction ingestion to the RAG system:

1. In the RAG ingestion script, query the reactions table joined with messages
2. Store reaction metadata as payload fields in Qdrant
3. Add reaction-based search filters (by emoji, reactor, or hasReactions)

This enables queries like:
- "Show me messages I bookmarked" (filter: emoji=📌, reactor=your_jid)
- "What did people react to with a heart?" (filter: emoji=❤️)
- "Messages I marked as important" (filter: emoji=⭐)

## Troubleshooting

### Reactions not appearing in database

- Check NanoClaw logs for `Failed to process reaction` errors
- Verify the chat is registered
- Confirm the `messages.reaction` event handler was added correctly

### Migration fails

- Ensure `store/messages.db` exists and is accessible
- If "table reactions already exists", the migration already ran — skip it
