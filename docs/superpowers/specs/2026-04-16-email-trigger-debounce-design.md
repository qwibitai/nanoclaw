# Email Trigger Debounce + Selective Push Suppression

## Problem

When related emails arrive in rapid succession (e.g., 3 Chase wire transfer notifications within 2 minutes), the current pipeline produces ~8 Telegram messages:

1. Each SSE event writes a separate IPC trigger file, spawning a separate agent container run
2. Each agent run shares the same session, sees prior messages in context, and produces escalating summaries of the same emails
3. Both Consumer A (IPC → agent) and Consumer B (event bus → push notification) fire on the same emails

Evidence from production (2026-04-16):
- 3 tracked items with thread IDs `19d9759c...`, `19d975a8...`, `19d975bf...` arrived 45s and 90s apart (135s total window)
- 5 container runs spawned: 3 initial + 2 escalation follow-ups
- All 5 share session ID `f97dc7ad`, so each agent run re-analyzes prior output and escalates

## Solution

Two changes:

### 1. IPC Trigger Debounce

A new `EmailTriggerDebouncer` class buffers incoming emails instead of writing IPC files immediately. When the first email arrives, a 60-second timer starts. Subsequent emails reset the timer. When the timer fires (60s of quiet), all buffered emails are flushed as a single merged IPC file, producing one agent container run.

**Parameters:**
- `trigger.debounceMs`: 60000 (60s). Time to wait for more emails after most recent arrival. Tunable via `config set`.
- `trigger.maxHoldMs`: 300000 (5 min). Safety cap — force-flush regardless of new arrivals, preventing indefinite buffering from a continuous email trickle.

**Deduplication:** The buffer deduplicates by `thread_id`. If superpilot re-sends the same thread in a subsequent SSE push within the debounce window, it merges rather than doubles.

**What is NOT debounced:** The `email.received` event bus emission still fires immediately on each SSE event. This allows Consumer B (sse-classifier + tracked_items) to classify and track emails in real time. Only the IPC file write (which triggers the agent container) is debounced.

### 2. Selective Push Suppression

Consumer B (the `email.received` handler in `index.ts`) currently sends an immediate push notification for every `push`-tier email. With this change, it checks whether the email is already in the debounce buffer — if so, it suppresses the push notification since the agent will handle it.

**Mechanism:** The debouncer exposes `has(threadId): boolean`. The `email.received` handler checks this before sending push notifications:

- `debouncer.has(threadId)` → skip push (agent will handle)
- `!debouncer.has(threadId)` → send push as before (fallback for non-debounced paths)

**Ordering guarantee:** `handleTriagedEmails` adds emails to the debouncer buffer *before* emitting `email.received`. Both operations are synchronous in the same function call, so the debouncer always knows about the email by the time Consumer B checks.

**What stays unchanged:**
- `digest`-tier emails: never get push notifications, unaffected
- `tracked_items` dedup in `classifyFromSSE`: remains in place, still prevents re-notifying on subsequent SSE pushes for the same thread
- If the debouncer is disabled or not initialized, `has()` returns false and push notifications fire as before — safe fallback

## Architecture

```
SSE event (1 email) ─┬─► debouncer.add(emails)     [buffer, don't write IPC yet]
                     │     ├─ dedup by thread_id
                     │     ├─ start/reset 60s timer
                     │     └─ on flush: write merged IPC file → 1 agent run
                     │
                     └─► eventBus.emit('email.received')
                           └─► classifyFromSSE()
                                 └─► push tier?
                                       ├─ debouncer.has(threadId) → suppress
                                       └─ !has → send push notification
```

**Result for wire scenario:**
- 3 SSE events arrive over 135s
- Debouncer buffers all 3 (first resets timer twice)
- After 60s of quiet, flushes 1 merged IPC file with 3 wire emails
- Agent sees all 3 wires in one prompt, produces 1 consolidated response
- Push notifications suppressed for all 3 (debouncer.has returns true)
- **8 messages → 1 message**

## EmailTriggerDebouncer API

```typescript
class EmailTriggerDebouncer {
  constructor(opts: {
    debounceMs: number;      // from UxConfig trigger.debounceMs
    maxHoldMs: number;        // from UxConfig trigger.maxHoldMs
    onFlush: (emails: SSEEmail[], label: string) => void;
  })

  add(emails: SSEEmail[], label: string): void
  has(threadId: string): boolean
  flush(): void              // force-flush (for graceful shutdown)
  getBufferSize(): number    // for smoketest
  destroy(): void            // cleanup timers
}
```

**`onFlush` callback:** Receives the merged email list and writes the IPC file + emits logs. This is the same logic currently in `handleTriagedEmails` after the buffer, extracted into a callback so the debouncer is testable without filesystem access.

**Multi-connection label handling:** When emails from different SSE connections (different labels) merge in the same debounce window, `onFlush` receives the label from the first email that started the buffer. The label is for logging only — it doesn't affect IPC file content or agent behavior.

## Configuration

Two new keys added to `UxConfig` defaults:

| Key | Default | Type | Description |
|-----|---------|------|-------------|
| `trigger.debounceMs` | `60000` | number | Quiet period before flushing buffered emails |
| `trigger.maxHoldMs` | `300000` | number | Maximum time to hold emails before force-flush |

Tunable at runtime via `config set trigger.debounceMs 30000`.

## Observability

**Logging:**
- `info` on first email entering empty buffer (thread_id, starts timer)
- `info` on merge into existing buffer (current count, time since first)
- `info` on flush (final count, total hold time, thread_ids)
- `debug` on push suppression (thread_id, reason: "in debounce buffer")

**Smoketest:** Add "Trigger debouncer" check to `handleSmokeTest` — reports active/inactive and current buffer size.

## Files Changed

| File | Change |
|------|--------|
| `src/email-trigger-debouncer.ts` | New — EmailTriggerDebouncer class |
| `src/__tests__/email-trigger-debouncer.test.ts` | New — unit tests |
| `src/email-sse.ts` | `handleTriagedEmails` adds to debouncer instead of writing IPC directly. IPC-write logic extracted to `writeIpcTrigger` (used as `onFlush` callback) |
| `src/index.ts` | Initialize debouncer with UxConfig values, pass to `startEmailSSE`. `email.received` handler checks `debouncer.has()` before sending push. Smoketest deps updated |
| `src/ux-config.ts` | Add `trigger.debounceMs` and `trigger.maxHoldMs` defaults |
| `src/chat-commands.ts` | `SmokeTestDeps` gains `triggerDebouncer` field |
| `src/__tests__/email-trigger-debounce-integration.test.ts` | New — integration test for debounce + suppression flow |

## Edge Cases

- **Solo emails:** Held for 60s, then flushed as single-email IPC file. Push suppressed. Total delay: ~60s + agent run time. Acceptable trade-off for consistency.
- **Mixed accounts in one window:** Emails from different accounts merge into one prompt. The agent sees the cross-account pattern (this is desirable — it caught the 2-account wire correlation).
- **NanoClaw restart:** Buffer is in-memory only, lost on restart. Superpilot resends on SSE reconnect, so emails will re-trigger. Safe.
- **Debouncer disabled:** If `trigger.debounceMs` is set to 0, debouncer passes through immediately (no buffering). `has()` returns false since buffer is always empty. Equivalent to current behavior.
- **Max hold cap:** If emails trickle in continuously (one every 50s), the 5-minute max hold forces a flush. Prevents indefinite buffering.
