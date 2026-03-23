# Thread Routing and Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix message routing and session persistence so each Discord thread gets reliable, isolated conversation context that survives restarts.

**Architecture:** Replace ephemeral `pending-{id}` / Discord-thread-ID session directories with stable `ctx-{id}` naming keyed to the ThreadContext DB row. Persist thread context ID on messages so the message loop can group by thread. Pass thread context through the full send path for exact-match targeting.

**Tech Stack:** TypeScript, better-sqlite3, vitest, Discord.js

**Spec:** `docs/superpowers/specs/2026-03-23-thread-routing-and-session-persistence-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db.ts` | Modify | Schema migration, storeMessage, query updates |
| `src/types.ts` | Modify | Update NewMessage comment, Channel.sendMessage signature |
| `src/container-runner.ts` | Modify | Remove migrateThreadDirs |
| `src/channels/discord.ts` | Modify | Exact-match send targeting, remove activeConversation/migrateThreadDirs |
| `src/index.ts` | Modify | Per-thread message loop grouping, threadContextId plumbing |
| `src/migrate-sessions.ts` | Create | One-time session directory migration |
| `src/routing.test.ts` | Modify | Add thread routing tests |

---

### Task 1: DB schema — add thread_context_id to messages

**Files:**
- Modify: `src/db.ts:28-48` (createSchema), `src/db.ts:201-224` (migration area)
- Modify: `src/db.ts:373-387` (storeMessage)
- Modify: `src/db.ts:459-478` (getNewMessages)
- Modify: `src/db.ts:503-518` (getUnprocessedMessages)
- Modify: `src/types.ts:61` (NewMessage.thread_context_id comment)
- Test: `src/routing.test.ts`

- [ ] **Step 1: Write failing test for thread_context_id persistence**

```typescript
// In src/routing.test.ts, add at the top with existing imports:
import { storeMessage, getNewMessages, getUnprocessedMessages, markMessagesProcessed } from './db.js';

// Add new describe block:
describe('thread_context_id persistence', () => {
  it('storeMessage persists thread_context_id and getUnprocessedMessages returns it', () => {
    storeChatMetadata('dc:123', '2024-01-01T00:00:00.000Z', 'Test', 'discord', true);
    storeMessage({
      id: 'msg-1',
      chat_jid: 'dc:123',
      sender: 'user1',
      sender_name: 'User',
      content: '@Andy hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      thread_context_id: 42,
    });

    const msgs = getUnprocessedMessages('dc:123', 'Andy');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].thread_context_id).toBe(42);
  });

  it('storeMessage works without thread_context_id', () => {
    storeChatMetadata('dc:123', '2024-01-01T00:00:00.000Z', 'Test', 'discord', true);
    storeMessage({
      id: 'msg-2',
      chat_jid: 'dc:123',
      sender: 'user1',
      sender_name: 'User',
      content: '@Andy hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });

    const msgs = getUnprocessedMessages('dc:123', 'Andy');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].thread_context_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routing.test.ts`
Expected: FAIL — `thread_context_id` not in INSERT or SELECT

- [ ] **Step 3: Add column to createSchema**

In `src/db.ts`, update the CREATE TABLE messages statement (line 37-48) to add the column:

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT,
  is_from_me INTEGER,
  is_bot_message INTEGER DEFAULT 0,
  thread_context_id INTEGER,
  PRIMARY KEY (id, chat_jid),
  FOREIGN KEY (chat_jid) REFERENCES chats(jid)
);
```

- [ ] **Step 4: Add migration for existing DBs**

In `src/db.ts`, after the `processed` column migration block (~line 224), add:

```typescript
  // Migration: Add thread_context_id to messages table
  if (!columnExists(database, 'messages', 'thread_context_id')) {
    database.exec(
      'ALTER TABLE messages ADD COLUMN thread_context_id INTEGER',
    );
    logger.info('Migration: added thread_context_id column to messages');
  }
```

- [ ] **Step 5: Update storeMessage INSERT**

In `src/db.ts`, update `storeMessage` (line 373-387):

```typescript
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR IGNORE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, processed, thread_context_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.is_bot_message ? 1 : 0, // Bot messages are born processed
    msg.thread_context_id ?? null,
  );
}
```

- [ ] **Step 6: Update getNewMessages SELECT**

In `src/db.ts`, update `getNewMessages` (line 459-478) to include `thread_context_id` in the SELECT:

```typescript
export function getNewMessages(
  jids: string[],
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[] } {
  if (jids.length === 0) return { messages: [] };

  const placeholders = jids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, thread_context_id
       FROM messages
       WHERE processed = 0 AND chat_jid IN (${placeholders})
         AND is_bot_message = 0 AND content NOT LIKE ?
         AND content != '' AND content IS NOT NULL
       ORDER BY timestamp
       LIMIT ?`,
    )
    .all(...jids, `${botPrefix}:%`, limit) as NewMessage[];

  return { messages: rows };
}
```

- [ ] **Step 7: Update getUnprocessedMessages SELECT**

In `src/db.ts`, update `getUnprocessedMessages` (line 503-518) to include `thread_context_id`:

```typescript
export function getUnprocessedMessages(
  chatJid: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  return db
    .prepare(
      `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, thread_context_id
       FROM messages
       WHERE processed = 0 AND chat_jid = ?
         AND is_bot_message = 0 AND content NOT LIKE ?
         AND content != '' AND content IS NOT NULL
       ORDER BY timestamp
       LIMIT ?`,
    )
    .all(chatJid, `${botPrefix}:%`, limit) as NewMessage[];
}
```

- [ ] **Step 8: Update NewMessage type comment**

In `src/types.ts`, line 61, change:

```typescript
  thread_context_id?: number; // Thread context ID (Discord only, not persisted to DB)
```

to:

```typescript
  thread_context_id?: number; // Thread context ID — persisted in messages table
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run src/routing.test.ts`
Expected: PASS

- [ ] **Step 10: Run full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: All pass

- [ ] **Step 11: Commit**

```bash
git add src/db.ts src/types.ts src/routing.test.ts
git commit -m "feat: persist thread_context_id on messages table"
```

---

### Task 2: Remove migrateThreadDirs from container-runner

**Files:**
- Modify: `src/container-runner.ts:140-164` (remove migrateThreadDirs)

- [ ] **Step 1: Run typecheck to confirm current state is clean**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Remove migrateThreadDirs function**

In `src/container-runner.ts`, delete the `migrateThreadDirs` function (lines 140-164) and its export.

- [ ] **Step 3: Remove migrateThreadDirs from discord.ts import and call site**

In `src/channels/discord.ts`, line 10, remove `migrateThreadDirs` from the import:

```typescript
// Before:
import { migrateThreadDirs } from '../container-runner.js';
// After: (delete this entire import line)
```

In `src/channels/discord.ts`, lines 499-507, remove the migrateThreadDirs call block:

```typescript
// Delete this block:
          // Migrate session/IPC dirs from pending-{id} to real thread ID
          const group = this.opts.registeredGroups()[jid];
          if (group) {
            migrateThreadDirs(
              group.folder,
              `pending-${triggerInfo.contextId}`,
              thread.id,
            );
          }
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no remaining references to migrateThreadDirs)

- [ ] **Step 5: Commit**

```bash
git add src/container-runner.ts src/channels/discord.ts
git commit -m "refactor: remove migrateThreadDirs — ctx-{id} dirs never rename"
```

---

### Task 3: Stable ctx-{id} session directory naming

**Files:**
- Modify: `src/index.ts:214-262` (processGroupMessages — threadId and session path)
- Modify: `src/index.ts:634-644` (message loop — threadId assignment)
- Modify: `src/channels/discord.ts:81-92` (setCurrentThreadContext key)
- Modify: `src/channels/discord.ts:477-528` (sendMessage — pendingTrigger and currentSendTarget)

- [ ] **Step 1: Update processGroupMessages to use ctx-{id} threadId**

In `src/index.ts`, in `processGroupMessages` (around line 214-223), after the thread context lookup, convert to ctx-based threadId:

Find the block that resolves `threadContext` and the subsequent `threadId` usage. The key change: when `threadContext` exists, the threadId passed to the container should be `ctx-${threadContext.id}` instead of the Discord thread ID or `pending-{id}`.

Replace the threadId used for session path construction (lines 236-253) so it uses `ctx-${threadContext.id}`:

```typescript
  // Convert to stable ctx-{id} for filesystem paths
  const containerThreadId = threadContext
    ? `ctx-${threadContext.id}`
    : threadId;
```

Then use `containerThreadId` in place of `threadId` at every site that uses threadId for filesystem or container identity:
- Session path construction (the ternary at ~line 237 that builds `sessionBase`)
- Session file verification path (~line 237-261)
- `channel.setCurrentThreadContext` call (~line 305)
- `queue.closeStdin` call (~line 299)
- `queue.notifyIdle` call (~line 347)
- `queue.sendMessage` in the message loop IPC path
- `runAgent` call — pass `containerThreadId` as `threadId` parameter
- Inside `runAgent`, `queue.registerProcess` call (~line 488) — receives threadId from opts

Grep for `threadId` in processGroupMessages and runAgent to find all sites. The only place the original Discord `threadId` is still needed is for the `threadContext` lookup itself.

- [ ] **Step 2: Update message loop threadId assignment**

In `src/index.ts`, in `startMessageLoop` (lines 634-644), when a thread context is found, use `ctx-${ctxId}` instead of `ctx.thread_id ?? \`pending-${ctxId}\``:

```typescript
          for (const msg of [...groupMessages].reverse()) {
            const ctxKey = `${msg.id}:${msg.chat_jid}`;
            const ctxId = messageThreadContext.get(ctxKey);
            if (ctxId) {
              messageThreadContext.delete(ctxKey);
              threadId = `ctx-${ctxId}`;
              break;
            }
          }
```

Note: The `messageThreadContext` Map will be removed in Task 5, but for now we keep it and just change the threadId format. Task 7 rewrites the entire message loop, so this intermediate change only needs to work correctly, not be final.

- [ ] **Step 3: Update Discord channel send targeting keys**

In `src/channels/discord.ts`, update `setCurrentThreadContext` (line 81-92) to use `ctx-{id}`:

```typescript
  setCurrentThreadContext(
    jid: string,
    threadId: string,
    context: ThreadContext | null,
  ): void {
    const key = `${jid}:${threadId}`;
    if (context) {
      this.currentSendTarget.set(key, context);
    } else {
      this.currentSendTarget.delete(key);
    }
  }
```

This already uses the threadId passed in. Since `index.ts` now passes `ctx-{id}` as the threadId, the key format changes automatically.

In `sendMessage`, update the `pendingTrigger` lookup (lines 480-488) and `currentSendTarget` iterations (lines 531-549, 656-668) to use exact key match with `ctx-{id}`. This will be fully reworked in Task 6 — for now just ensure the key format is consistent.

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/channels/discord.ts
git commit -m "feat: use stable ctx-{id} session directory naming"
```

---

### Task 4: One-time session directory migration script

**Files:**
- Create: `src/migrate-sessions.ts`
- Modify: `src/index.ts` (call from main)

- [ ] **Step 1: Write the migration script**

Create `src/migrate-sessions.ts`:

```typescript
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getThreadContextById, getThreadContextByThreadId } from './db.js';
import { logger } from './logger.js';

const MARKER_FILE = path.join(DATA_DIR, '.session-migration-v1-done');

/**
 * One-time migration: rename session directories from pending-{id} and
 * Discord-thread-ID formats to the stable ctx-{id} naming scheme.
 *
 * Runs once on startup if the marker file doesn't exist.
 */
export function migrateSessionDirs(): void {
  if (fs.existsSync(MARKER_FILE)) return;

  // Migrate both sessions and IPC directories
  const roots = [
    path.join(DATA_DIR, 'sessions'),
    path.join(DATA_DIR, 'ipc'),
  ];

  let migrated = 0;
  let deleted = 0;
  let skipped = 0;

  for (const rootDir of roots) {
    if (!fs.existsSync(rootDir)) continue;

  for (const groupFolder of fs.readdirSync(rootDir)) {
    const groupDir = path.join(rootDir, groupFolder);
    if (!fs.statSync(groupDir).isDirectory()) continue;

    for (const entry of fs.readdirSync(groupDir)) {
      const entryPath = path.join(groupDir, entry);
      if (!fs.statSync(entryPath).isDirectory()) continue;

      // Skip known non-thread directories
      if (
        entry === '.claude' ||
        entry === 'agent-runner-src' ||
        entry.startsWith('task_') ||
        entry.startsWith('ctx-')
      ) {
        continue;
      }

      // Case 1: pending-{id} directories — extract numeric ID directly
      const pendingMatch = entry.match(/^pending-(\d+)$/);
      if (pendingMatch) {
        const ctxId = pendingMatch[1];
        const target = path.join(groupDir, `ctx-${ctxId}`);
        if (fs.existsSync(target)) {
          // Target already exists, delete the pending dir
          fs.rmSync(entryPath, { recursive: true });
          deleted++;
        } else {
          fs.renameSync(entryPath, target);
          migrated++;
        }
        continue;
      }

      // Case 2: Numeric directories (Discord thread IDs) — look up in DB
      if (/^\d+$/.test(entry)) {
        const ctx = getThreadContextByThreadId(entry);
        if (ctx) {
          const target = path.join(groupDir, `ctx-${ctx.id}`);
          if (fs.existsSync(target)) {
            // Conflict: keep whichever has the newer .jsonl
            const existingTime = newestJsonlMtime(target);
            const candidateTime = newestJsonlMtime(entryPath);
            if (candidateTime > existingTime) {
              fs.rmSync(target, { recursive: true });
              fs.renameSync(entryPath, target);
            } else {
              fs.rmSync(entryPath, { recursive: true });
            }
            deleted++;
          } else {
            fs.renameSync(entryPath, target);
            migrated++;
          }
        } else {
          // No matching DB record — orphaned
          fs.rmSync(entryPath, { recursive: true });
          deleted++;
        }
        continue;
      }

      // Unknown directory format — skip
      skipped++;
    }
  }
  } // end roots loop

  logger.info(
    { migrated, deleted, skipped },
    'Session directory migration complete',
  );
  fs.writeFileSync(MARKER_FILE, new Date().toISOString());
}

function newestJsonlMtime(dir: string): number {
  let newest = 0;
  try {
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d)) {
        const p = path.join(d, entry);
        const stat = fs.statSync(p);
        if (stat.isDirectory()) walk(p);
        else if (entry.endsWith('.jsonl') && stat.mtimeMs > newest) {
          newest = stat.mtimeMs;
        }
      }
    };
    walk(dir);
  } catch {
    // ignore
  }
  return newest;
}
```

- [ ] **Step 2: Call from main() in index.ts**

In `src/index.ts`, add import:

```typescript
import { migrateSessionDirs } from './migrate-sessions.js';
```

In `main()`, after `initDatabase()` (line 760) and before `loadState()` (line 762), add:

```typescript
  migrateSessionDirs();
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/migrate-sessions.ts src/index.ts
git commit -m "feat: add one-time session directory migration to ctx-{id} scheme"
```

---

### Task 5: Remove messageThreadContext Map, use DB column

**Files:**
- Modify: `src/index.ts:86` (remove Map declaration)
- Modify: `src/index.ts:634-644` (message loop — read from msg.thread_context_id)
- Modify: `src/index.ts:861-866` (onMessage callback — stop populating Map)

- [ ] **Step 1: Write failing test for thread grouping from DB**

Add to `src/routing.test.ts`:

```typescript
describe('message thread grouping from DB', () => {
  it('getNewMessages returns thread_context_id for grouping', () => {
    storeChatMetadata('dc:123', '2024-01-01T00:00:00.000Z', 'Test', 'discord', true);
    storeMessage({
      id: 'msg-a',
      chat_jid: 'dc:123',
      sender: 'user1',
      sender_name: 'User',
      content: '@Andy hello from thread 1',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      thread_context_id: 10,
    });
    storeMessage({
      id: 'msg-b',
      chat_jid: 'dc:123',
      sender: 'user2',
      sender_name: 'User2',
      content: '@Andy hello from thread 2',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
      thread_context_id: 20,
    });
    storeMessage({
      id: 'msg-c',
      chat_jid: 'dc:123',
      sender: 'user3',
      sender_name: 'User3',
      content: '@Andy hello no thread',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_from_me: false,
    });

    // getNewMessages is already imported at top of file
    const { messages } = getNewMessages(['dc:123'], 'Andy');
    expect(messages).toHaveLength(3);

    // Group by thread
    const byThread = new Map<string, typeof messages>();
    for (const m of messages) {
      const key = `${m.chat_jid}:${m.thread_context_id ?? 'default'}`;
      const existing = byThread.get(key) || [];
      existing.push(m);
      byThread.set(key, existing);
    }

    expect(byThread.size).toBe(3);
    expect(byThread.has('dc:123:10')).toBe(true);
    expect(byThread.has('dc:123:20')).toBe(true);
    expect(byThread.has('dc:123:default')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (should pass already from Task 1)

Run: `npx vitest run src/routing.test.ts`
Expected: PASS

- [ ] **Step 3: Remove messageThreadContext Map**

In `src/index.ts`:

1. Delete the Map declaration (line 86):
```typescript
// DELETE: const messageThreadContext = new Map<string, number>();
```

2. In `onMessage` callback (~line 861-866), remove the Map population:
```typescript
// DELETE:
      if (msg.thread_context_id) {
        messageThreadContext.set(
          `${msg.id}:${msg.chat_jid}`,
          msg.thread_context_id,
        );
      }
```

3. In `startMessageLoop` (lines 634-644), replace the Map-based threadId lookup with reading from the DB-returned message field. This will be fully reworked in Task 7 (per-thread grouping), but for now change:

```typescript
          // OLD: look up from in-memory Map
          for (const msg of [...groupMessages].reverse()) {
            const ctxKey = `${msg.id}:${msg.chat_jid}`;
            const ctxId = messageThreadContext.get(ctxKey);
            if (ctxId) {
              messageThreadContext.delete(ctxKey);
              threadId = `ctx-${ctxId}`;
              break;
            }
          }

          // NEW: read from DB-persisted field
          for (const msg of [...groupMessages].reverse()) {
            if (msg.thread_context_id) {
              threadId = `ctx-${msg.thread_context_id}`;
              break;
            }
          }
```

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/routing.test.ts
git commit -m "refactor: remove messageThreadContext Map, use DB column"
```

---

### Task 6: Exact-match send targeting in Discord channel

**Files:**
- Modify: `src/types.ts:101` (Channel.sendMessage signature)
- Modify: `src/channels/discord.ts:58-92` (remove activeConversation, update pendingTrigger type)
- Modify: `src/channels/discord.ts:460-587` (sendMessage — exact-match lookup)
- Modify: `src/channels/discord.ts:633-679` (sendFile — exact-match lookup)
- Modify: `src/index.ts:328` (onOutput — pass threadContextId)

- [ ] **Step 1: Update Channel.sendMessage signature in types.ts**

In `src/types.ts`, line 101:

```typescript
  // Before:
  sendMessage(jid: string, text: string): Promise<void>;
  // After:
  sendMessage(jid: string, text: string, threadContextId?: number): Promise<void>;
```

- [ ] **Step 2: Remove activeConversation from Discord channel**

In `src/channels/discord.ts`:

1. Delete the declaration (line 69):
```typescript
// DELETE: private activeConversation = new Set<string>();
```

2. Delete all `.add()` calls — search for `this.activeConversation.add(` and remove each line:
   - Line 193: `this.activeConversation.add(chatJid);`
   - Line 224: `this.activeConversation.add(chatJid);`
   - Line 230: `this.activeConversation.add(chatJid);` (inside the explicit mention check)
   - Line 243: `this.activeConversation.add(chatJid);`

3. Delete the `.has()` guard and Step 2.5 fallback block (lines 555-574):
```typescript
// DELETE entire block:
      if (this.activeConversation.has(jid)) {
        const recentCtx = getActiveThreadContexts(jid, 24);
        // ...
      } // end activeConversation guard
```

4. Delete the `.delete()` call (line 579):
```typescript
// DELETE: this.activeConversation.delete(jid);
```

5. Remove the `getActiveThreadContexts` import if no longer used elsewhere.

- [ ] **Step 3: Rekey pendingTrigger to number key**

In `src/channels/discord.ts`:

Change the `pendingTrigger` type (line 65-68):

```typescript
  // Before:
  private pendingTrigger = new Map<
    string,
    { message: Message; contextId: number }
  >();
  // After:
  private pendingTrigger = new Map<
    number,
    { message: Message }
  >();
```

Update the `.set()` calls:
- Line 257: `this.pendingTrigger.set(ctx.id, { message });`
- Line 284: `this.pendingTrigger.set(ctx.id, { message });`

- [ ] **Step 4: Rewrite sendMessage with exact-match lookup**

In `src/channels/discord.ts`, replace the `sendMessage` method (~lines 460-587):

```typescript
  async sendMessage(jid: string, text: string, threadContextId?: number): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Step 1: If there's a pending trigger for this context → create a new thread
      if (threadContextId !== undefined) {
        const triggerInfo = this.pendingTrigger.get(threadContextId);
        if (triggerInfo) {
          this.pendingTrigger.delete(threadContextId);
          try {
            const thread = await triggerInfo.message.startThread({
              name: text.slice(0, 100).replace(/\n/g, ' ') || 'Response',
            });
            // Update the thread context with the actual Discord thread ID
            updateThreadContext(threadContextId, { threadId: thread.id });
            // Update in-memory send target so subsequent streaming outputs go to this thread
            const sendKey = `${jid}:ctx-${threadContextId}`;
            const ctx = this.currentSendTarget.get(sendKey);
            if (ctx) {
              ctx.thread_id = thread.id;
            }
            await this.sendChunked(thread, text);
            logger.info(
              { jid, threadId: thread.id, threadContextId, length: text.length },
              'Discord message sent to new thread',
            );
            return;
          } catch (err) {
            logger.warn(
              { jid, err },
              'Failed to create thread, falling back to channel',
            );
            // Fall through to channel send
          }
        }
      }

      // Step 2: If there's a currentSendTarget for this context → send to that thread
      if (threadContextId !== undefined) {
        const sendKey = `${jid}:ctx-${threadContextId}`;
        const ctx = this.currentSendTarget.get(sendKey);
        if (ctx?.thread_id) {
          try {
            const thread = await textChannel.threads.fetch(ctx.thread_id);
            if (thread) {
              await this.sendChunked(thread, text);
              logger.info(
                { jid, threadId: ctx.thread_id, threadContextId, length: text.length },
                'Discord message sent to existing thread',
              );
              return;
            }
          } catch {
            // Thread deleted, fall through
          }
        }
      }

      // Step 3: No thread context (scheduled task, IPC, etc.) — send to main channel
      await this.sendChunked(textChannel, text);
      logger.info(
        { jid, length: text.length },
        'Discord message sent to channel',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }
```

- [ ] **Step 5: Update sendFile with exact-match lookup**

`sendFile` keeps its existing signature (no `threadContextId` parameter) because IPC callers don't have thread context. Instead, it searches `currentSendTarget` for any entry matching this `jid` — which is safe because `sendFile` is only called from IPC during an active container, and `currentSendTarget` will have exactly one entry for that jid's active thread.

In `src/channels/discord.ts`, update `sendFile` (~lines 633-679) — replace the prefix-scan `for` loop with:

```typescript
      // Find active thread for this jid from currentSendTarget
      let target: { send: (options: object) => Promise<unknown> } = textChannel;
      for (const [key, ctx] of this.currentSendTarget) {
        if (key.startsWith(`${jid}:`) && ctx.thread_id) {
          try {
            const thread = await textChannel.threads.fetch(ctx.thread_id);
            if (thread) target = thread;
          } catch {
            // Thread deleted, fall through to channel
          }
          break;
        }
      }
```

This is the same pattern as before but is intentional here — `sendFile` has no way to know which thread it's targeting since the IPC caller doesn't pass thread context. The `Channel.sendFile` interface in `types.ts` is NOT changed.

- [ ] **Step 6: Pass threadContextId through onOutput in index.ts**

In `src/index.ts`, in `processGroupMessages`, update the `onOutput` callback (~line 328):

```typescript
        // Before:
        await channel.sendMessage(chatJid, text);
        // After:
        await channel.sendMessage(chatJid, text, threadContext?.id);
```

- [ ] **Step 7: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/channels/discord.ts src/index.ts
git commit -m "feat: exact-match send targeting, remove activeConversation"
```

---

### Task 7: Per-thread message loop grouping

**Files:**
- Modify: `src/index.ts:553-700` (startMessageLoop)

- [ ] **Step 1: Write failing test for per-thread grouping**

Add to `src/routing.test.ts`:

```typescript
describe('per-thread message grouping', () => {
  it('groups messages by (chatJid, threadContextId)', () => {
    const messages = [
      { chat_jid: 'dc:1', thread_context_id: 10, id: 'a' },
      { chat_jid: 'dc:1', thread_context_id: 20, id: 'b' },
      { chat_jid: 'dc:1', thread_context_id: 10, id: 'c' },
      { chat_jid: 'dc:1', id: 'd' }, // no thread
      { chat_jid: 'dc:2', thread_context_id: 30, id: 'e' },
    ] as any[];

    const groups = new Map<string, typeof messages>();
    for (const msg of messages) {
      const key = `${msg.chat_jid}:${msg.thread_context_id ? `ctx-${msg.thread_context_id}` : 'default'}`;
      const existing = groups.get(key) || [];
      existing.push(msg);
      groups.set(key, existing);
    }

    expect(groups.size).toBe(4);
    expect(groups.get('dc:1:ctx-10')).toHaveLength(2);
    expect(groups.get('dc:1:ctx-20')).toHaveLength(1);
    expect(groups.get('dc:1:default')).toHaveLength(1);
    expect(groups.get('dc:2:ctx-30')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (pure logic test, should pass immediately)

Run: `npx vitest run src/routing.test.ts`
Expected: PASS

- [ ] **Step 3: Restructure the message loop**

In `src/index.ts`, replace the message loop body inside `startMessageLoop` (lines ~558-694). The new structure groups by `(chatJid, threadContextId)` instead of just `chatJid`:

```typescript
      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Group by (chatJid, threadContextId) — each thread-group is independent
        const threadGroups = new Map<string, { chatJid: string; threadCtxId: number | undefined; messages: NewMessage[] }>();
        for (const msg of messages) {
          const threadKey = msg.thread_context_id
            ? `${msg.chat_jid}:ctx-${msg.thread_context_id}`
            : `${msg.chat_jid}:default`;
          const existing = threadGroups.get(threadKey);
          if (existing) {
            existing.messages.push(msg);
          } else {
            threadGroups.set(threadKey, {
              chatJid: msg.chat_jid,
              threadCtxId: msg.thread_context_id ?? undefined,
              messages: [msg],
            });
          }
        }

        for (const [_key, { chatJid, threadCtxId, messages: groupMessages }] of threadGroups) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const threadId = threadCtxId ? `ctx-${threadCtxId}` : 'default';

          // Trigger check: thread messages skip (already have context),
          // non-thread messages need trigger unless main group or container active
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
          if (needsTrigger && !threadCtxId) {
            if (!queue.isActive(chatJid, threadId)) {
              const allowlistCfg = loadSenderAllowlist();
              const hasTrigger = groupMessages.some(
                (m) =>
                  TRIGGER_PATTERN.test(m.content.trim()) &&
                  (m.is_from_me ||
                    isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
              );
              if (!hasTrigger) {
                markMessagesProcessed(
                  groupMessages.map((m) => ({ id: m.id, chat_jid: m.chat_jid })),
                );
                continue;
              }
            }
          }

          // Detect /goal prefix
          let priority: 'interactive' | 'goal' | 'scheduled' = 'interactive';
          let goalTimeoutMs: number | undefined;
          for (const msg of groupMessages) {
            const goalMatch = msg.content
              .trim()
              .match(/^\/goal(?:\s+(\d+)([hm]))?\s*/i);
            if (goalMatch) {
              priority = 'goal';
              if (goalMatch[1] && goalMatch[2]) {
                const value = parseInt(goalMatch[1], 10);
                const unit = goalMatch[2].toLowerCase();
                goalTimeoutMs = Math.min(
                  unit === 'h' ? value * 3600000 : value * 60000,
                  GOAL_TIMEOUT_MAX,
                );
              } else {
                goalTimeoutMs = GOAL_TIMEOUT_DEFAULT;
              }
              msg.content = msg.content.replace(
                /^\/goal(?:\s+\d+[hm])?\s*/i,
                '',
              );
              break;
            }
          }

          // Try IPC to active container for this specific thread
          const allPending = getUnprocessedMessages(chatJid, ASSISTANT_NAME);
          // Filter to this thread's messages only
          const threadPending = threadCtxId
            ? allPending.filter((m) => m.thread_context_id === threadCtxId)
            : allPending.filter((m) => !m.thread_context_id);
          const messagesToSend = threadPending.length > 0 ? threadPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE, channel);
          const pipedMessageRefs = messagesToSend.map((m) => ({
            id: m.id,
            chat_jid: m.chat_jid,
          }));

          if (queue.sendMessage(chatJid, threadId, formatted)) {
            logger.debug(
              { chatJid, threadId, count: messagesToSend.length },
              'Piped messages to active container',
            );
            markMessagesProcessed(pipedMessageRefs);
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            logger.info(
              { chatJid, threadId },
              'No active container, enqueuing for new container',
            );
            queue.enqueueThreadMessageCheck(
              chatJid,
              threadId,
              priority,
              goalTimeoutMs,
            );
          }
        }
      }
```

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/routing.test.ts
git commit -m "feat: message loop groups by (chatJid, threadContextId)"
```

---

### Task 8: Bypass trigger check in processGroupMessages for threaded messages

**Files:**
- Modify: `src/index.ts:198-211` (processGroupMessages trigger check)

`processGroupMessages` has its own trigger check (separate from the message loop). When processing threaded messages, this check can incorrectly filter them out — thread messages don't need a trigger since the Discord channel already prepended one, and the thread context confirms they belong to the bot.

- [ ] **Step 1: Add thread bypass to processGroupMessages trigger check**

In `src/index.ts`, in `processGroupMessages`, find the trigger check block (~lines 198-211). Add a bypass when the threadId indicates a thread context:

```typescript
  // For non-main groups, check if trigger is required and present
  const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
  const isThreadContext = threadId !== undefined && threadId.startsWith('ctx-');
  if (needsTrigger && !isThreadContext) {
    // ... existing trigger check logic stays unchanged
  }
```

The key change: `!isThreadContext` is added to the condition. Thread messages (with `ctx-` prefix threadId) skip the trigger check entirely.

- [ ] **Step 2: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "fix: skip trigger check for threaded messages in processGroupMessages"
```

---

### Task 9: Integration verification

**Files:**
- No code changes — verification only

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Verify no stale references**

Run: Search for removed artifacts:

```bash
grep -r "migrateThreadDirs" src/ --include="*.ts"
grep -r "activeConversation" src/ --include="*.ts"
grep -r "messageThreadContext" src/ --include="*.ts"
grep -r "pending-" src/ --include="*.ts" | grep -v node_modules | grep -v migrate-sessions
```

Expected: No matches (except comments/docs)

- [ ] **Step 5: Commit any cleanup**

If step 4 found stale references, clean them up and commit.

```bash
git add -A
git commit -m "chore: clean up stale references from thread routing refactor"
```
