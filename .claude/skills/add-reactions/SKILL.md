---
name: add-reactions
description: Add WhatsApp emoji reaction support — receive, send, store, search, and voice-command reactions.
---

# Add Reactions

This skill adds complete emoji reaction support to NanoClaw's WhatsApp channel:
- Receive and track reactions from WhatsApp
- Send reactions programmatically
- Store reactions in SQLite with full history
- Voice commands ("react thumbs up to that")
- Optional RAG integration for searching by reactions

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `reactions` is in `applied_skills`, skip to Phase 3 (Verify). The code changes are already in place.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-reactions
```

This deterministically:
- Adds `src/reaction-commands.ts` (voice command parser with 20+ emoji mappings)
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
  PRIMARY KEY (message_id, message_chat_jid, reactor_jid),
  FOREIGN KEY (message_id, message_chat_jid) REFERENCES messages(id, chat_jid)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id, message_chat_jid);
CREATE INDEX IF NOT EXISTS idx_reactions_reactor ON reactions(reactor_jid);
CREATE INDEX IF NOT EXISTS idx_reactions_emoji ON reactions(emoji);
CREATE INDEX IF NOT EXISTS idx_reactions_timestamp ON reactions(timestamp);
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

  return chatJid
    ? (db.prepare(sql).all(reactorJid, emoji, chatJid) as any[])
    : (db.prepare(sql).all(reactorJid, emoji) as any[]);
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

  return chatJid
    ? (db.prepare(sql).all(chatJid) as any[])
    : (db.prepare(sql).all() as any[]);
}
```

### Modify src/channels/whatsapp.ts

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

      const reactorJid = key.participant || key.remoteJid || '';
      const emoji = reaction.text || '';
      const timestamp = new Date().toISOString();

      const { storeReaction } = await import('../db.js');
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
  const { default: Database } = await import('better-sqlite3');
  const path = await import('path');
  const { STORE_DIR } = await import('../config.js');

  const dbPath = path.join(STORE_DIR, 'messages.db');
  const msgDb = new Database(dbPath, { readonly: true });

  const latestMsg = msgDb
    .prepare(
      `SELECT id FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT 1`
    )
    .get(chatJid) as { id: string } | undefined;

  msgDb.close();

  if (!latestMsg) {
    throw new Error(`No messages found for chat ${chatJid}`);
  }

  const isGroup = chatJid.endsWith('@g.us');
  const messageKey = {
    id: latestMsg.id,
    remoteJid: chatJid,
    fromMe: false,
    ...(isGroup && { participant: undefined }),
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

Say or type: "react thumbs up to that last message"

Check your phone — the reaction should appear on the message.

### Test voice command parsing

```typescript
import { parseReactionCommand, isReactionCommand } from './reaction-commands.js';

console.log(parseReactionCommand('react thumbs up'));  // => '👍'
console.log(parseReactionCommand('mark that with a bookmark'));  // => '📌'
console.log(isReactionCommand('react fire'));  // => true
```

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

### Voice commands not working

- Verify `src/reaction-commands.ts` exists and builds
- Check that `handleReactionCommand()` is imported and called in the message handler
- Test with simple commands first: "react thumbs up"

### Migration fails

- Ensure `store/messages.db` exists and is accessible
- If "table reactions already exists", the migration already ran — skip it
