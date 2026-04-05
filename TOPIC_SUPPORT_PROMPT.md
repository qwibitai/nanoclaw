# Task: Add Telegram Topic (Forum Thread) Support

Wire `thread_id` (Telegram's `message_thread_id`) end-to-end so the agent sees which topic each message came from and responses route back to the correct topic.

## Current state

The Telegram channel already extracts `message_thread_id` at `src/channels/telegram.ts:103` and passes it as `thread_id` in the `NewMessage` object (line 161). The `NewMessage` type in `src/types.ts:54` already has `thread_id?: string`. The Telegram `sendMessage` method at `src/channels/telegram.ts:242` already accepts an optional `threadId` parameter and correctly sets `message_thread_id` on the API call.

**Problem:** thread_id is dropped at every subsequent step — not stored in DB, not included in agent-facing XML, not passed back when sending responses.

## What to change

### 1. `src/db.ts` — Store and retrieve thread_id

**Migration** (~line 113, after the existing `is_bot_message` migration): Add the column using the same try/catch pattern:
```typescript
try {
  database.exec(`ALTER TABLE messages ADD COLUMN thread_id TEXT`);
} catch { /* column already exists */ }
```

**`storeMessage()`** (line 275): Add `thread_id` as 9th column in INSERT. Use `msg.thread_id || null`.

**`storeMessageDirect()`** (line 293): Same — add `thread_id` as 9th column. Use `msg.thread_id || null`. Also add `thread_id?: string` to the inline type parameter.

**`getNewMessages()`** (line 331): Add `thread_id` to the inner SELECT:
```sql
SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, thread_id
```

**`getMessagesSince()`** (line 364): Same — add `thread_id` to SELECT.

### 2. `src/router.ts` — Include topic in agent-facing XML

**`formatMessages()`** (line 13): When `m.thread_id` exists, add a `topic` attribute:
```typescript
const topicAttr = m.thread_id ? ` topic="${escapeXml(m.thread_id)}"` : '';
return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${topicAttr}>${escapeXml(m.content)}</message>`;
```

**`routeOutbound()`** (line 37): Add optional `threadId?: string` parameter, pass to `channel.sendMessage(jid, text, threadId)`.

### 3. `src/types.ts` — Update Channel interface

**`Channel.sendMessage`** (line 87): Add optional threadId:
```typescript
sendMessage(jid: string, text: string, threadId?: string): Promise<void>;
```

### 4. `src/channels/telegram.ts` — thread_id for non-text messages

**`storeNonText()`** (line 171): Extract thread_id and include it:
```typescript
const storeNonText = (ctx: any, placeholder: string) => {
  const chatJid = `tg:${ctx.chat.id}`;
  const group = this.opts.registeredGroups()[chatJid];
  if (!group) return;

  const timestamp = new Date(ctx.message.date * 1000).toISOString();
  const senderName = ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
  const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
  const threadId = ctx.message.message_thread_id;

  const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
  this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);
  this.opts.onMessage(chatJid, {
    id: ctx.message.message_id.toString(),
    chat_jid: chatJid,
    sender: ctx.from?.id?.toString() || '',
    sender_name: senderName,
    content: `${placeholder}${caption}`,
    timestamp,
    is_from_me: false,
    thread_id: threadId ? threadId.toString() : undefined,
  });
};
```

### 5. `src/index.ts` — Route responses back to the originating topic

**`processGroupMessages()`** (~line 221): After collecting `missedMessages`, determine the reply thread from the last message:
```typescript
const replyThreadId = missedMessages[missedMessages.length - 1]?.thread_id;
```

Then in the streaming callback (~line 297), pass it:
```typescript
await channel.sendMessage(chatJid, text, replyThreadId);
```

**IPC `sendMessage` callback** (~line 697): Update to accept and pass threadId:
```typescript
sendMessage: (jid, text, threadId?) => {
  const channel = findChannel(channels, jid);
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text, threadId);
},
```

**Scheduler `sendMessage` callback** (~line 686): Update signature to accept optional threadId for interface compatibility:
```typescript
sendMessage: async (jid, rawText, threadId?) => {
  const channel = findChannel(channels, jid);
  if (!channel) { ... }
  const text = formatOutbound(rawText);
  if (text) await channel.sendMessage(jid, text, threadId);
},
```

### 6. `src/ipc.ts` — Support threadId in IPC messages

**`IpcDeps.sendMessage`** (line 14): Add threadId:
```typescript
sendMessage: (jid: string, text: string, threadId?: string) => Promise<void>;
```

**IPC message handler** (~line 77): Read and pass `data.threadId`:
```typescript
if (data.type === 'message' && data.chatJid && data.text) {
  // ... authorization check ...
  await deps.sendMessage(data.chatJid, data.text, data.threadId);
}
```

Add `threadId?: string` to the `data` type in `processTaskIpc()` (~line 158).

### 7. `src/task-scheduler.ts` — Signature compatibility

**`SchedulerDependencies.sendMessage`** (~line 75):
```typescript
sendMessage: (jid: string, text: string, threadId?: string) => Promise<void>;
```

No behavioral change — scheduled tasks don't originate from topics.

### 8. Tests

**`src/channels/telegram.test.ts`**: Add test cases for:
- Text message in a topic includes `thread_id` in the delivered NewMessage
- Non-text message (photo, voice, etc.) in a topic includes `thread_id`
- `sendMessage` with threadId passes `message_thread_id` to the API
- Messages outside topics have `thread_id: undefined`

Update any existing sendMessage test mocks/assertions that now need the third parameter.

**Other test files** that mock `Channel.sendMessage` or `IpcDeps.sendMessage` — update signatures to accept the optional third arg. Grep for `sendMessage` in test files to find them all.

## Important constraints

- Do NOT modify application code to make a test work (per project rules).
- Only write code comments if absolutely necessary.
- This is additive — all existing behavior for non-topic messages must be unchanged.
- `thread_id` is optional everywhere. When undefined, behavior is identical to current (no topic attribute in XML, no thread routing on responses).
- Do not add topic-to-context mapping logic — that's the agent's job via CLAUDE.md. This change just makes the data available.

## Verification

1. `npm run build` compiles cleanly
2. `npm test` — all tests pass
3. The data flow is: Telegram message with topic → stored with thread_id → retrieved with thread_id → XML has `topic="..."` attribute → agent sees it → response routed back to same topic via `channel.sendMessage(jid, text, threadId)`
