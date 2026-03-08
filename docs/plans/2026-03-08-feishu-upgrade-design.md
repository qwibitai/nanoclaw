# Feishu Channel Upgrade Design

Date: 2026-03-08
Reference: `openclaw/extensions/feishu/src/`

## Scope

7 features, all changes contained in `src/channels/feishu.ts` + new helper `parsePostContent` (ported from OpenClaw `post.ts`).

No changes to: `src/types.ts`, `src/router.ts`, `src/index.ts`, `Channel` interface.

---

## Architecture

```
FeishuChannel
├── New private helpers
│   ├── buildPostPayload(text)           → post msg_type JSON
│   ├── parsePostContent(content)        → ported from openclaw post.ts (pure fn)
│   ├── fetchQuotedMessage(client, id)   → fetch + parse parent_id content
│   └── downloadMedia(client, ...)       → download to groups/{folder}/media/
│
├── sendMessage()   ← post format, reply threading, withdrawn fallback
├── handleMessage() ← post parsing, quoted context, media download
└── setTyping()     ← backoff circuit breaker
```

New private state fields:
```typescript
private typingBackoffUntil = 0;
// lastMessageIdByJid already exists — reused as reply_to_message_id
```

---

## Feature 1 & 2: Post Format (Markdown rendering)

Always use `post` msg_type. Replaces current `text` msg_type.

```typescript
function buildPostPayload(text: string): string {
  return JSON.stringify({
    zh_cn: { content: [[{ tag: 'md', text }]] }
  });
}
```

Message chunking (4000 byte limit) retained as safety fallback — each chunk sent as a separate post message.

Test impact: `sendMessage` tests asserting `msg_type: 'text'` must be updated to `msg_type: 'post'`.

---

## Feature 3: @mention Outbound

No change to `sendMessage(jid, text)` signature.

Feishu `post` format natively renders `<at user_id="ou_xxx">Name</at>` tags in text as mention notifications. Agent can write these directly in its output — no special parsing needed in NanoClaw.

---

## Feature 4: Thread Reply

`sendMessage` checks `lastMessageIdByJid[jid]` and uses `message.reply()` when available.
Withdrawn message fallback from OpenClaw `send.ts`:

```typescript
const WITHDRAWN_REPLY_ERROR_CODES = new Set([230011, 231003]);

if (replyMsgId) {
  const res = await client.im.message.reply({
    path: { message_id: replyMsgId },
    data: { msg_type: 'post', content: payload }
  });
  if (isWithdrawnReplyError(res)) {
    // fallback to create
    await client.im.message.create({ ... });
  }
} else {
  await client.im.message.create({ ... });
}
```

---

## Feature 5: Quoted Message Parsing

In `handleMessage`, when `message.parent_id` is present, fetch and prepend quoted content:

```typescript
if (message.parent_id) {
  const quoted = await fetchQuotedMessage(client, message.parent_id);
  if (quoted) content = `[Quoted: ${quoted}]\n${content}`;
}
```

`fetchQuotedMessage` uses `client.im.message.get()` and parses result via `parseQuotedContent()`.
Supports: `text`, `post`, `image`, `file`, `interactive` types (reference: OpenClaw `send.ts:parseQuotedMessageContent`).

---

## Feature 6: Typing Circuit Breaker

Backoff error codes (from OpenClaw `typing.ts`):
```typescript
const FEISHU_BACKOFF_CODES = new Set([99991400, 99991403, 429]);
```

Two detection paths (SDK can fail silently):
1. `catch(err)` — check `err.code` or `err.response.data.code`
2. Non-throwing response — check `res?.code` in response body

Backoff is **per-instance** (app-level rate limit, not per-jid). Duration: 5 minutes.

```typescript
private typingBackoffUntil = 0;
private readonly TYPING_BACKOFF_MS = 5 * 60 * 1000;

// In setTyping():
if (Date.now() < this.typingBackoffUntil) return;
// On backoff error detected:
this.typingBackoffUntil = Date.now() + this.TYPING_BACKOFF_MS;
```

---

## Feature 7: Media Download

**Standalone media messages** (`image`, `file`, `audio`):
```typescript
if (['image', 'file', 'audio'].includes(msgType)) {
  const mediaPath = await downloadMedia(client, msgId, msgType, content, groupFolder);
  content = mediaPath
    ? `[Downloaded: ${mediaPath}]`
    : `[${msgType}: unable to download]`;
}
```

**Post messages with embedded images**:
```typescript
if (msgType === 'post') {
  const { textContent, imageKeys } = parsePostContent(rawContent);
  content = textContent;
  for (const imageKey of imageKeys) {
    const path = await downloadMedia(client, msgId, 'image', imageKey, groupFolder);
    if (path) content += `\n[Image: ${path}]`;
  }
}
```

Download path: `groups/{folder}/media/{timestamp}_{filename}`

`downloadMedia` handles three SDK response shapes (from OpenClaw `media.ts:readFeishuResponseBuffer`):
- `Buffer` / `ArrayBuffer` — direct
- `getReadableStream()` — stream concat
- `writeFile()` — write to temp path then read

Resource type mapping: `image` → `'image'`, everything else → `'file'`.

---

## Test Updates Required

`src/channels/feishu.test.ts`:
- `sendMessage` suite: update `msg_type: 'text'` → `msg_type: 'post'`, `content` format to match post payload
- `setTyping` suite: add backoff circuit breaker tests (rate limit response, 5-min cooldown)
- New `handleMessage` tests: quoted message prepending, media content replacement

---

## Implementation Order

1. Feature 6 — Typing circuit breaker (isolated, low risk)
2. Feature 1/2 — Post format (update sendMessage + tests)
3. Feature 4 — Thread reply (extends sendMessage)
4. Feature 5 — Quoted message parsing (extends handleMessage)
5. Feature 7 — Media download (most complex, isolated to handleMessage)
6. Feature 3 — @mention (no code change, document in agent prompt)
