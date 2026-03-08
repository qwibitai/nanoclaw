## 1. Typing Circuit Breaker (feishu-typing-resilience)

- [x] 1.1 Add `typingBackoffUntil = 0` private field to `FeishuChannel`
- [x] 1.2 Add `FEISHU_BACKOFF_CODES = new Set([99991400, 99991403, 429])` constant
- [x] 1.3 Add `isBackoffError(err)` helper — checks `err.code` and `err.response?.data?.code`
- [x] 1.4 Update `setTyping(true)`: check `Date.now() < typingBackoffUntil` → return early
- [x] 1.5 Update `setTyping(true)` reaction.create: check response body code + catch, set backoff on match
- [x] 1.6 Update `setTyping(false)` reaction.delete: same backoff detection
- [x] 1.7 Add tests: thrown backoff error trips breaker, response-body code trips breaker, backoff suppresses calls, non-backoff errors are silently ignored

## 2. Post Message Format (feishu-channel)

- [x] 2.1 Add `buildPostPayload(text: string): string` helper
- [x] 2.2 Update `sendMessage`: replace `msg_type: 'text'` with `msg_type: 'post'` using `buildPostPayload`
- [x] 2.3 Update existing `sendMessage` tests: change `msg_type: 'text'` → `'post'`, update `content` assertion to match post payload shape

## 3. Thread Reply (feishu-channel)

- [x] 3.1 Add `WITHDRAWN_REPLY_CODES = new Set([230011, 231003])` constant
- [x] 3.2 Update `sendMessage`: when `lastMessageIdByJid[jid]` exists, call `im.message.reply()` instead of `im.message.create()`
- [x] 3.3 Add withdrawn-message fallback: if reply response code is in `WITHDRAWN_REPLY_CODES`, call `im.message.create()`
- [x] 3.4 Add tests: reply uses cached message ID, no cached ID falls back to create, withdrawn reply falls back to create

## 4. Post Inbound Parsing + Quoted Message Context (feishu-inbound-context)

- [x] 4.1 Port `parsePostContent(content: string)` from OpenClaw `post.ts` as a private module-level function in `feishu.ts`
- [x] 4.2 Update `handleMessage`: when `message_type === 'post'`, call `parsePostContent` and use `textContent`
- [x] 4.3 Add `fetchQuotedMessage(client, parentId)` helper using `im.message.get()` + content parsing (text/post/image/file/interactive)
- [x] 4.4 Update `handleMessage`: when `message.parent_id` is present, call `fetchQuotedMessage` and prepend `[Quoted: ...]\n` to content
- [x] 4.5 Add tests: post message text extraction, quoted message prepend, fetch failure does not block delivery

## 5. Media Download (feishu-inbound-context)

- [x] 5.1 Add `downloadMedia(client, msgId, type, keyOrContent, groupFolder)` helper — uses `im.messageResource.get()`, handles Buffer/ArrayBuffer/Stream SDK response shapes
- [x] 5.2 Update `handleMessage`: for `message_type` in `['image','file','audio']`, call `downloadMedia` and replace content with `[Downloaded: <path>]` or `[<type>: unable to download]`
- [x] 5.3 Update `handleMessage` post branch: after `parsePostContent`, iterate `imageKeys` and call `downloadMedia` for each, appending `\n[Image: <path>]`
- [x] 5.4 Add tests: image download sets content path, download failure produces placeholder, embedded post images are appended

## 6. Validation

- [x] 6.1 Run `npm run typecheck` — zero errors
- [x] 6.2 Run `npm test` — all tests pass (408/408)
- [x] 6.3 Run `npm run format` — no diff
