# Change: Upgrade Feishu Channel — Rich Messaging, Inbound Context, Typing Resilience

## Why

NanoClaw's Feishu channel currently sends plain `text` messages (no Markdown rendering), ignores quoted/replied messages and media attachments, and has no rate-limit protection on the typing indicator. This limits usability compared to what the Feishu platform supports.

## What Changes

- **Post format**: `sendMessage` switches from `text` to `post` msg_type so Markdown (code blocks, tables, bold, links) renders correctly in Feishu clients.
- **Thread reply**: Bot replies use `message.reply()` against the triggering message ID; withdrawn-message fallback prevents silent failures.
- **@mention outbound**: `post` format natively renders `<at user_id="...">` tags — no signature change required.
- **Quoted message context**: When an inbound message has `parent_id`, the parent is fetched and prepended as `[Quoted: ...]` so the agent sees full context.
- **Post inbound parsing**: Inbound `post` (rich-text) messages are converted to Markdown text; embedded image keys are extracted for download.
- **Media download**: Inbound `image`, `file`, and `audio` messages (and images embedded in `post`) are downloaded to `groups/{folder}/media/` and the path is appended to `content`.
- **Typing circuit breaker**: Rate-limit and quota errors (codes 99991400, 99991403, 429) trip a 5-minute per-instance backoff, suppressing further typing API calls until the cooldown expires.

## Impact

- Affected specs: `feishu-channel`, `feishu-inbound-context`, `feishu-typing-resilience`
- Affected code: `src/channels/feishu.ts`, `src/channels/feishu.test.ts`
- No changes to: `src/types.ts`, `src/router.ts`, `src/index.ts`, `Channel` interface
- **BREAKING** (internal): `sendMessage` now emits `post` instead of `text` — existing `feishu.test.ts` assertions on `msg_type: 'text'` must be updated.
