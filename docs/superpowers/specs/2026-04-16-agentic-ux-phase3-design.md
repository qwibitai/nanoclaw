# Agentic UX Phase 3 — Email Trigger Pipeline & Draft Enrichment

**Date:** 2026-04-16
**Status:** Draft
**Depends on:** `2026-04-16-agentic-ux-wiring-design.md` (Phase 2, complete)

## Overview

Phase 2 wired the agentic UX modules to Gmail APIs and completed callback router actions. Three gaps remain in the email trigger pipeline:

1. **Draft enrichment** returns `null` (stub) — needs executor pool integration
2. **Email trigger output** bypasses `classifyAndFormat` — no truncation or action buttons
3. **Archive buttons** aren't attached to agent email responses

All three converge on the same code path: the email trigger's `onOutput` callback in `index.ts` (lines 1588–1605). This phase closes those gaps.

## 1. Executor Pool Integration for Draft Enrichment

### 1.1 Current State

`evaluateEnrichment` in `index.ts` (line 1342) filters drafts by body length (<200 chars) and age (<30 min), then returns `null`. Eligible drafts are logged but not enriched.

### 1.2 Design

Submit eligible drafts to the executor pool as `proactive`-priority tasks. The task runs a focused agent prompt that improves auto-generated draft replies.

**Flow:**

1. `evaluateEnrichment(draft)` is called by `DraftEnrichmentWatcher.poll()`
2. Heuristic gate: skip if `body.length > 200` or age > 30 min (existing)
3. Create a `Promise<string | null>` that enqueues a proactive task via `queue.enqueueTask()`
4. The task calls `runAgent()` with a system prompt focused on draft improvement
5. Parse agent output: if it contains `NO_CHANGE` (case-insensitive), resolve `null`; otherwise resolve with the enriched body text
6. 60-second timeout: if the agent doesn't respond, resolve `null` (skip enrichment)

**Agent prompt template:**

```
You are improving an auto-generated email draft reply.

Subject: {draft.subject}
Current draft body:
---
{draft.body}
---

Instructions:
- Improve the draft with better tone, completeness, and context
- Keep the same intent and meaning
- Return ONLY the improved body text
- If the draft is already adequate, return exactly: NO_CHANGE
```

**Task priority:** `proactive` — lowest priority, never blocks interactive work or scheduled tasks.

**Concurrency:** `evaluateEnrichment` blocks the draft watcher's poll loop until the task completes or times out. This is acceptable because:
- Poll interval is 60s, timeout is 60s — worst case delays next poll by one cycle
- `proactive` tasks only run when no interactive/scheduled work is pending
- The draft watcher processes one draft at a time sequentially

### 1.3 Dependencies

- `ExecutorPool.enqueueTask()` — existing, accepts `(groupJid, taskId, fn, priority)`
- `runAgent()` — existing, spawns agent container
- Main group JID — the Telegram notification JID (found via `Object.keys(registeredGroups).find(jid => jid.startsWith('tg:'))`) is used to route the task, since draft enrichment is a background operation that uses the same container pool as email triggers

### 1.4 Interface Changes

The `evaluateEnrichment` callback signature stays the same: `(draft: DraftInfo) => Promise<string | null>`. The implementation changes from a stub to a real executor-backed function.

Pass `queue` (ExecutorPool) and `runAgent` references into the callback closure. Also pass the main group JID for task routing.

## 2. Email Preview in SSE Pipeline

### 2.1 Current State

The email trigger output path in `index.ts` (line 1601):

```typescript
const clean = formatOutbound(output.result);
if (clean) await onResult(clean);
```

`formatOutbound` strips `<internal>` tags and normalizes confidence markers. It does NOT:
- Classify the message category
- Truncate email bodies
- Attach action buttons (Expand, Archive)

### 2.2 Design

After `formatOutbound()`, pipe through `classifyAndFormat()` to get classification metadata and formatted text with truncation.

**Change in the onOutput callback:**

```typescript
const clean = formatOutbound(output.result);
if (clean) {
  const { text: formatted, meta } = classifyAndFormat(clean);
  // Send with action buttons if the channel supports them
  await onResult(formatted, meta);
}
```

**`onResult` signature change:**

Currently `onResult` is `(text: string) => Promise<void>`. Extend to `(text: string, meta?: MessageMeta) => Promise<void>`.

In the email trigger setup (`enqueueEmailTrigger` in `ipc.ts`), the `onResult` callback calls `deps.sendMessage(agentJid, text)`. Update this to pass `meta.actions` to the channel:

```typescript
onResult: async (text, meta) => {
  const channel = deps.findChannel(agentJid);
  if (channel && meta?.actions?.length && channel.sendMessageWithButtons) {
    await channel.sendMessageWithButtons(agentJid, text, meta.actions);
  } else {
    await deps.sendMessage(agentJid, text);
  }
}
```

### 2.3 Channel Support

Telegram's `sendMessageWithButtons` already exists and accepts `ActionButton[]` for inline keyboard buttons. WhatsApp and other channels fall back to plain `sendMessage` (buttons are silently dropped).

### 2.4 Imports

Add `classifyAndFormat` import from `./router.js` in `index.ts`. Already exported.

## 3. Archive Buttons on Agent Email Responses

### 3.1 Current State

When the agent responds to an email trigger, the response text may not match the `[Email ...` classifier pattern — the agent formats its own response freely. So `classifyAndFormat` alone can't reliably detect email responses for button attachment.

### 3.2 Design

Use trigger context rather than text classification. The email trigger callback already knows the email metadata (thread_id, account, emailId) from the IPC payload. After classification, unconditionally attach archive buttons if this is an email trigger response.

**Flow:**

1. Email trigger fires with `emails[]` from IPC payload (each has `thread_id`, `account`)
2. Agent processes and responds
3. In `onOutput`, after `classifyAndFormat()`:
   - If `meta.category !== 'email'` (classifier didn't detect it), force-attach archive buttons using trigger metadata
   - Record each email in `archiveTracker.recordAction(emailId, threadId, account, 'replied')` so the archive callback can look up the thread

**Button attachment:**

```typescript
for (const email of triggerEmails) {
  const emailId = email.thread_id; // thread_id serves as emailId
  archiveTracker.recordAction(emailId, email.thread_id, email.account, 'replied');

  if (!meta.actions.some(a => a.callbackData?.startsWith('archive:'))) {
    meta.actions.push({
      label: '🗄 Archive',
      callbackData: `archive:${emailId}`,
      style: 'secondary',
    });
  }
}
```

### 3.3 Scope

This only applies to email trigger responses. Regular agent messages (from user chat) continue through the existing path unchanged.

### 3.4 Thread-to-Email Mapping

The `archiveTracker` already stores `email_id → (thread_id, account)` mappings. The archive callback handler (in `callback-router.ts`) looks up this mapping when `confirm_archive:{emailId}` fires. Using `thread_id` as the `emailId` is consistent with how the SSE pipeline identifies emails.

## 4. Integration Points

All three changes converge in `src/index.ts`:

| Change | Location | Files Modified |
|--------|----------|---------------|
| Draft enrichment executor | `evaluateEnrichment` callback (line 1342) | `src/index.ts` |
| Email preview pipeline | `onOutput` in email trigger (line 1601) | `src/index.ts`, `src/ipc.ts` |
| Archive buttons | Same `onOutput` callback | `src/index.ts` |

### 4.1 Data Flow

```
SSE event → handleTriagedEmails → IPC trigger file
  → ipc.ts reads trigger → enqueueEmailTrigger(jid, prompt, onResult)
    → executor pool runs agent → onOutput callback
      → formatOutbound (strip internal tags)
      → classifyAndFormat (truncate, classify, attach buttons)  [NEW]
      → force-attach archive buttons from trigger metadata       [NEW]
      → onResult(formatted, meta)                                [CHANGED]
        → channel.sendMessageWithButtons(jid, text, actions)     [NEW]
```

### 4.2 Draft Enrichment Data Flow

```
DraftEnrichmentWatcher.poll()
  → listRecentDrafts(account) → Gmail API
  → evaluateEnrichment(draft)
    → heuristic gate (body < 200 chars, age < 30 min)
    → queue.enqueueTask(mainJid, taskId, fn, 'proactive')  [NEW]
      → runAgent(group, prompt, jid, onOutput)              [NEW]
      → parse response: NO_CHANGE → null, else → enrichedBody
    → return enrichedBody
  → updateDraft(account, draftId, enrichedBody)
  → emit email.draft.enriched
```

## 5. Error Handling

- **Draft enrichment timeout:** 60s `Promise.race` with a timeout. On timeout, resolve `null` (no enrichment). Log at `warn` level.
- **Draft enrichment agent failure:** If `runAgent` returns `'error'`, resolve `null`. Log at `error` level.
- **classifyAndFormat on non-email text:** Returns the text unchanged with default metadata. No action buttons added. Safe no-op.
- **Missing archiveTracker:** If `archiveTracker` is not initialized (shouldn't happen in production), skip button attachment. Log warning.
- **Channel without button support:** Falls back to plain `sendMessage`. Buttons silently dropped.

## 6. Testing Strategy

- `draft-enrichment-executor.test.ts` — mock executor pool + runAgent, verify proactive priority, timeout behavior, NO_CHANGE parsing
- `email-trigger-pipeline.test.ts` — mock channel with sendMessageWithButtons, verify classifyAndFormat is called, buttons attached
- `archive-buttons-trigger.test.ts` — verify archive buttons attached from trigger metadata, archiveTracker called
- Extend `callback-router.test.ts` — verify archive flow works with thread_id-based emailIds from triggers
