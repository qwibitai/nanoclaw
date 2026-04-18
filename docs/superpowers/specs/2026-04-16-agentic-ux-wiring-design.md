# Agentic UX Wiring — Integration Design Spec

**Date:** 2026-04-16
**Status:** Draft
**Depends on:** `2026-04-16-agentic-ux-design.md` (Phase 1, complete)

## Overview

Phase 1 built all the agentic UX modules (classifier, formatter, batcher, status bar, auto-approval, archive tracker, email preview, callback router, draft enrichment watcher, Mini App). This phase wires those modules to real Gmail APIs and completes the end-to-end flows that were left as stubs or disconnected.

## 1. GmailOps Interface

A narrow interface that decouples consumers from the full `GmailChannel`:

```typescript
// src/gmail-ops.ts
export interface GmailOps {
  archiveThread(account: string, threadId: string): Promise<void>;
  listRecentDrafts(account: string): Promise<DraftInfo[]>;
  updateDraft(account: string, draftId: string, newBody: string): Promise<void>;
  getMessageBody(account: string, messageId: string): Promise<string | null>;
}
```

### 1.1 GmailChannel Methods

Four new methods on `GmailChannel`, each delegating to the existing `this.gmail` instance:

- **`archiveThread(threadId)`** — `gmail.users.threads.modify({ removeLabelIds: ['INBOX'] })`. Single API call archives the entire thread.
- **`listRecentDrafts()`** — `gmail.users.drafts.list({ maxResults: 10 })` then `drafts.get()` for each to extract subject/body. Returns `DraftInfo[]`.
- **`updateDraft(draftId, newBody)`** — `gmail.users.drafts.update()` with re-encoded raw message. Preserves To/Subject/References headers from the existing draft.
- **`getMessageBody(messageId)`** — `gmail.users.messages.get({ format: 'full' })` then reuse existing `extractTextBody()` (make it a public method).

### 1.2 GmailOpsRouter

A thin router that maps account alias → `GmailChannel` instance:

```typescript
// src/gmail-ops.ts
export class GmailOpsRouter implements GmailOps {
  private channels = new Map<string, GmailChannel>();

  register(alias: string, channel: GmailChannel): void;
  async archiveThread(account: string, threadId: string): Promise<void>;
  async listRecentDrafts(account: string): Promise<DraftInfo[]>;
  async updateDraft(account: string, draftId: string, newBody: string): Promise<void>;
  async getMessageBody(account: string, messageId: string): Promise<string | null>;
}
```

Each method looks up `this.channels.get(account)`, throws if not found. Instantiated in `index.ts` after Gmail channels connect.

## 2. Archive Flow (End-to-End)

### 2.1 Callback Router — `archive` Action

Two-step confirmation:

1. **First tap** (`archive:{emailId}`) — `editMessageButtons()` replaces button row with `[✅ Confirm Archive] [❌ Cancel]`. A 5-second timeout reverts to original buttons if no second tap.
2. **Second tap** (`confirm_archive:{emailId}`) — Look up the email's account and threadId from `archiveTracker.getUnarchived()`. Call `gmailOps.archiveThread(account, threadId)`. Call `archiveTracker.markArchived(emailId, 'archived')`. Edit message to append "✅ Archived" and remove buttons.

Cancel button (`cancel_archive:{emailId}`) reverts to original button row immediately.

### 2.2 "Archive All" Text Command

When the main group receives `"archive all"` (case-insensitive, exact match):

1. Get `archiveTracker.getUnarchived()`
2. For each, call `gmailOps.archiveThread(account, threadId)`
3. Mark all as archived in DB
4. Reply with `✅ Archived N threads`
5. On partial failure, report which succeeded and which failed

Intercepted in the inbound message handler in `index.ts`, before agent dispatch. Only matches the exact phrase — no regex partial matches.

### 2.3 Recording Actions from SSE Pipeline

Listen to `email.action.completed` on the EventBus. When fired, call:

```typescript
archiveTracker.recordAction(
  event.payload.emailId,
  event.payload.threadId,
  event.payload.account,
  event.payload.action  // e.g., 'replied', 'delegated', 'dismissed'
);
```

This ensures acted-on emails enter the archive flow for the morning digest cleanup section.

## 3. Email Preview Expansion (3-Tier)

### 3.1 Tier 1: Summary (Default)

When `classifyAndFormat()` processes a message with `meta.category === 'email'` and `meta.emailId`:

- Truncate body to 300 chars via `truncatePreview(body, 300)`
- Attach actions: `[📧 Expand] [🌐 Full Email] [Archive]`
- "Full Email" uses `web_app` button type pointing to Mini App `/email/{emailId}?account={account}`

### 3.2 Tier 2: Inline Preview

Callback `expand:{emailId}:{account}`:

1. Check `getCachedEmailBody(emailId)` — if miss, call `gmailOps.getMessageBody(account, emailId)` and `cacheEmailBody()`
2. `editMessageTextAndButtons()` with 800-char truncated body
3. Button row becomes: `[📧 Collapse] [🌐 Full Email] [Archive]`

Callback `collapse:{emailId}`:

1. `editMessageTextAndButtons()` back to 300-char summary from cache
2. Button row reverts to: `[📧 Expand] [🌐 Full Email] [Archive]`

### 3.3 Tier 3: Full in Mini App

The `/email/:emailId` route already exists. Add `?account=` query parameter. If the email body isn't in the in-memory cache, fetch via `gmailOps.getMessageBody()` and cache it.

## 4. Draft Enrichment Wiring

### 4.1 Callbacks

Wire `DraftEnrichmentWatcher` in `index.ts` with:

- `listRecentDrafts` → `gmailOpsRouter.listRecentDrafts(account)`
- `updateDraft` → `gmailOpsRouter.updateDraft(account, draftId, newBody)`
- `evaluateEnrichment` → Heuristic first pass:
  - Skip if body > 200 chars (likely already composed)
  - Skip if draft is older than 30 minutes (user may be editing)
  - For short drafts (< 50 chars — likely auto-reply stubs), submit to executor pool as low-priority task with prompt: "This is an auto-generated draft reply. Improve it with context from the thread, fix tone, ensure completeness. Return the improved body only, or 'NO_CHANGE' if adequate."
  - Parse agent response: if `NO_CHANGE`, return `null`; otherwise return the enriched body

### 4.2 Notification

On `email.draft.enriched` event, send Telegram message:

```
✏️ Draft enriched: "Re: {subject}"
[↩ Revert] [✅ Keep]
```

- `revert:{draftId}` → `draftWatcher.revert(draftId)`, edit message to "↩ Reverted to original"
- `keep:{draftId}` → remove buttons, no further action

### 4.3 Accounts

Derive from `SSE_CONNECTIONS` config — these are the accounts with SuperPilot integration. Default poll interval: 60 seconds.

### 4.4 Draft Diff View

New Mini App route `GET /draft-diff/:draftId`:

- Query `draft_originals` table for `original_body`
- Show side-by-side or inline diff (original vs enriched)
- Revert button in the Mini App calls back to NanoClaw API

## 5. Callback Router Expansion

### 5.1 Updated Action Roster

| Action | Handler |
|--------|---------|
| `archive:{emailId}` | Show confirm/cancel buttons (5s timeout) |
| `confirm_archive:{emailId}` | Gmail archive + DB mark + edit msg |
| `cancel_archive:{emailId}` | Revert to original buttons |
| `expand:{emailId}:{account}` | Fetch body, cache, show 800-char preview |
| `collapse:{emailId}` | Revert to 300-char summary |
| `revert:{draftId}` | Revert draft + edit msg |
| `keep:{draftId}` | Remove buttons |
| `answer:{questionId}:{value}` | (existing) |
| `stop:{taskId}` | (existing) |
| `dismiss:{itemId}` | (existing) |

### 5.2 Interface Changes

`handleCallback` becomes async:

```typescript
export async function handleCallback(
  query: CallbackQuery,
  deps: CallbackRouterDeps,
): Promise<void>
```

`CallbackRouterDeps` adds:

```typescript
export interface CallbackRouterDeps {
  archiveTracker: ArchiveTracker;
  autoApproval: AutoApprovalTimer;
  statusBar: StatusBarManager;
  gmailOps: GmailOps;
  draftWatcher: DraftEnrichmentWatcher;
  findChannel: (jid: string) => Channel | undefined;
}
```

### 5.3 Error Handling

Every Gmail API call wraps in try/catch. On failure:

- Edit message to show `⚠️ {action} failed: {reason}`
- Log error with full context
- No retry button (user can re-tap the original action)

## 6. Integration Wiring in index.ts

### 6.1 Initialization Order

1. Gmail channels connect (existing)
2. Create `GmailOpsRouter`, register each connected Gmail channel by alias
3. Create `DraftEnrichmentWatcher` with real callbacks from router
4. Start draft watcher
5. Register `email.action.completed` listener → `archiveTracker.recordAction()`
6. Wire `gmailOps` and `draftWatcher` into `CallbackRouterDeps`

### 6.2 "Archive All" Intercept

In the inbound message handler, before agent dispatch:

```typescript
if (message.content.trim().toLowerCase() === 'archive all') {
  // Handle inline, don't send to agent
  const unarchived = archiveTracker.getUnarchived();
  let archived = 0;
  for (const email of unarchived) {
    try {
      await gmailOpsRouter.archiveThread(email.account, email.thread_id);
      archiveTracker.markArchived(email.email_id, email.action_taken);
      archived++;
    } catch (err) {
      logger.error({ err, emailId: email.email_id }, 'Failed to archive');
    }
  }
  await sendReply(`✅ Archived ${archived}/${unarchived.length} threads`);
  return; // Skip agent dispatch
}
```

### 6.3 Email Truncation in Router

In `classifyAndFormat()`, when the classified message has `category === 'email'`:

- Extract emailId and account from internal tags (already parsed by classifier)
- Truncate body to 300 chars
- Attach expand/full/archive actions to `meta.actions`
- Set `meta.emailId` and `meta.account`

## 7. Mini App Extensions

### 7.1 Email Route Update

`GET /email/:emailId` — add `?account=` query param. If body not in cache, fetch via `gmailOps.getMessageBody(account, emailId)` and cache it. Pass `gmailOps` to the Mini App server constructor.

### 7.2 Draft Diff Route

`GET /draft-diff/:draftId` — new route:

1. Query `draft_originals` for `original_body` and `enriched_at`
2. Fetch current draft body from Gmail via `gmailOps.listRecentDrafts()` → find by draftId (the enriched version lives in Gmail, not locally)
3. Render inline diff with additions highlighted green, removals red
4. Include "Revert" button that POSTs to `/api/draft/:draftId/revert`

### 7.3 Revert API

`POST /api/draft/:draftId/revert` — calls `draftWatcher.revert(draftId)`, returns JSON `{ success: true }`.

## Testing Strategy

Each section gets unit tests following the existing TDD pattern:

- `gmail-ops.test.ts` — mock `gmail_v1.Gmail`, verify each method calls correct API
- `callback-router.test.ts` — extend existing tests for new actions
- `email-preview-integration.test.ts` — 3-tier flow with mocked channel
- `draft-enrichment-integration.test.ts` — end-to-end with mocked Gmail
- `archive-flow.test.ts` — full two-step + batch archive
- `mini-app-server.test.ts` — extend for new routes
