# Mini-App Reply/Send Design Spec

**Date:** 2026-04-16
**Track:** A (from `docs/superpowers/plans/2026-04-16-email-alerts-remaining.md`)
**Status:** Approved for implementation planning

## Goal

Add one-tap reply approval to the nanoclaw email mini-app. The agent already drafts replies and persists them as Gmail drafts; the mini-app becomes a thin review/edit/send surface with a 10-second Undo window.

## Non-goals

- Raw composition (user writes from scratch) — use Gmail directly or "Edit in Gmail"
- Forwards from the mini-app — already handled conversationally in Telegram
- Rich text / attachments in v1 — text-only; heavy formatting goes through "Edit in Gmail"
- Cross-device state sync — single-user system
- Persistent pending-send queue — in-memory timer, dropped on restart (fail-safe)

## Clarifying-question answers (recap)

| # | Question | Answer |
|---|----------|--------|
| Q1 | Primary reply flow | Agent-drafts-first; mini-app is review/edit/send |
| Q2 | Send semantics | Send-with-undo (10s deferred send timer) |
| Q3 | Edit flow | Inline textarea + "Edit in Gmail" escape hatch; text-only v1 |
| Q4 | Account routing | Derived from incoming thread (no user picker) |
| Q5 | Forward in mini-app | Skip — conversational chat path already works |

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│ Mini-app (browser/Telegram webview)                       │
│  email-full.html: [Send] [Edit in Gmail] [Archive]        │
│  inline <textarea> for body edits                         │
│  Undo banner post-Send                                    │
└──────────────────┬────────────────────────────────────────┘
                   ↓ HTTP
┌───────────────────────────────────────────────────────────┐
│ nanoclaw (src/mini-app/server.ts)                         │
│  3 new routes: save / send / cancel                       │
│  PendingSendRegistry: Map<draftId, { timer, sendAt }>     │
└──────────────────┬────────────────────────────────────────┘
                   ↓
┌───────────────────────────────────────────────────────────┐
│ GmailOps (src/gmail-ops.ts) — extend interface            │
│  existing: archiveThread, updateDraft, getMessageBody     │
│  NEW:      sendDraft(account, draftId)                    │
└──────────────────┬────────────────────────────────────────┘
                   ↓ Gmail API
┌───────────────────────────────────────────────────────────┐
│ Gmail channel (src/channels/gmail.ts)                     │
│  NEW: sendDraft() → users.drafts.send                     │
└───────────────────────────────────────────────────────────┘
```

### New files

- `src/mini-app/pending-send.ts` — `PendingSendRegistry` class. Pure logic, no Express dependency, fully unit-testable.
- `src/mini-app/pending-send.test.ts` — unit tests for the registry.
- `src/__tests__/mini-app-draft-send-routes.test.ts` — route tests.
- `src/__tests__/mini-app-send-integration.test.ts` — end-to-end with mocked GmailOps.

### Modified files

- `src/mini-app/server.ts` — three new route handlers.
- `src/mini-app/templates/email-full.ts` — new button row, textarea, undo banner, inline JS.
- `src/gmail-ops.ts` — add `getDraftReplyContext` and `sendDraft` to `GmailOps` and `GmailOpsProvider` interfaces; export `DraftReplyContext` type.
- `src/channels/gmail.ts` — implement `getDraftReplyContext` and `sendDraft`.
- `src/gmail-ops.test.ts` — extend for `getDraftReplyContext` and `sendDraft` routing.
- `src/channels/gmail.test.ts` — extend for `getDraftReplyContext` and `sendDraft` Gmail calls.
- `src/index.ts` — wire `registry.shutdown()` to SIGTERM/SIGINT handlers.

### Minimal Telegram callback-router change

- `src/callback-router.ts` — the handler for "Full Email" must check whether a draft exists for the incoming email's threadId (query `draft_originals`). When a draft exists, the callback opens `/reply/:draftId?account=<alias>`; when no draft, the existing `/email/:emailId?account=<alias>` URL is used. This is the only change to `callback-router.ts`.

### Unchanged

- Draft-enrichment pipeline, draft-diff view, draft revert API, Archive button, push-manager.
- No new SQLite tables.

## Component details

### `PendingSendRegistry` — `src/mini-app/pending-send.ts`

```ts
interface PendingSend {
  draftId: string;
  account: string;
  sendAt: number;             // epoch ms
  timer: NodeJS.Timeout;
}

class PendingSendRegistry {
  schedule(draftId: string, account: string, delayMs: number,
           onFire: () => Promise<void>): { sendAt: number }
  cancel(draftId: string): boolean
  has(draftId: string): boolean
  shutdown(): void
}
```

Behavior:
- `schedule()` with the same `draftId` replaces any existing timer (idempotent; double-tap Send simply pushes `sendAt` out).
- `cancel()` returns `true` if a timer existed, `false` if it already fired or never existed.
- `shutdown()` clears all timers without firing — called from SIGTERM/SIGINT. Safer default: email never leaves if process dies during the 10s window.
- `onFire` rejections are caught inside the registry: logged at `error` level + emitted on the event-bus as `draft.send.failed`. The registry itself doesn't crash on fire errors.

### New routes — `src/mini-app/server.ts`

```
GET   /reply/:draftId?account=<alias>
  Renders the mini-app reply view (HTML).
  → server resolves account from query param + validates against draft_originals
  → server calls gmailOps.getDraftReplyContext(account, draftId)
  → renders renderEmailFull() with incoming headers + editable draft body + buttons
  200: HTML page
  404: HTML stub "Draft no longer exists — [Open thread in Gmail]"

PATCH /api/draft/:draftId/save
  body: { body: string }
  → gmailOps.updateDraft(account, draftId, body)
  200: { ok: true }
  404: draft not found in draft_originals
  500: Gmail API error

POST /api/draft/:draftId/send
  body: {}
  → registry.schedule(draftId, account, 10_000, () => gmailOps.sendDraft(account, draftId))
  200: { ok: true, sendAt: number }
  404: draft not found
  500: (rare) registry error

POST /api/draft/:draftId/send/cancel
  body: {}
  → registry.cancel(draftId)
  200: { ok: true, cancelled: boolean }
```

All four routes look up the account by querying `draft_originals` in SQLite (existing table, keyed by `draft_id`, includes account alias). The `GET /reply/:draftId` route accepts `account` as a query param but cross-checks against `draft_originals` to prevent account confusion. 404 if the draft row is missing in any case.

### `getDraftReplyContext` + `sendDraft` — `src/gmail-ops.ts` + `src/channels/gmail.ts`

Two new methods on the interfaces:

```ts
interface DraftReplyContext {
  body: string;                 // current agent-enriched draft body (plain text)
  incoming: {                   // headers of the email being replied TO
    from: string;
    to: string;
    subject: string;
    date: string;
    cc?: string;
  };
}

interface GmailOps {
  // existing methods...
  getDraftReplyContext(account: string, draftId: string): Promise<DraftReplyContext | null>;
  sendDraft(account: string, draftId: string): Promise<void>;
}

interface GmailOpsProvider {
  // existing methods...
  getDraftReplyContext(draftId: string): Promise<DraftReplyContext | null>;
  sendDraft(draftId: string): Promise<void>;
}
```

Rationale: `draft_originals` stores only the *pre-enrichment* body (used for the diff view). The mini-app needs the current agent-enriched body AND the incoming email headers. Both can be fetched in a single `gmail.users.drafts.get` call because a draft includes its threadId, and we can read sibling message headers from the same thread. We return a composite object to keep the interface surface narrow and avoid two round-trips in the route handler.

Implementation in `channels/gmail.ts`:
- `getDraftReplyContext`: `gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'full' })` → extract draft body (prefer `text/plain`; fall back to stripped `text/html`). Find the most recent non-draft message in the same thread via `gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] })` → populate `incoming`. Returns `null` if the draft no longer exists (404).
- `sendDraft`: `gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } })`. Logs on success with `{ account, draftId, threadId }`; logs + rethrows on failure.

### Mini-app UI — `src/mini-app/templates/email-full.ts`

Renders:
- Incoming email header (from, subject, date) — unchanged styling.
- **Agent's draft body** in an editable `<textarea class="compose">` (auto-grows with JS; text-only; placeholder: "Agent's draft — edit before sending").
- Button row: `[ Send ]` `[ Edit in Gmail ]` `[ Archive ]`.
- Hidden `<div class="undo-banner">` — shows after Send with 10s countdown + Undo button.
- Inline `<script>` block wiring fetch calls, countdown, button state transitions.

New template props (driven by route handler that queries `draft_originals`): `draftId`, `account`, `draftBody`.

"Edit in Gmail" URL: `https://mail.google.com/mail/u/{account}/#drafts?compose={draftId}`. Before opening, JS flushes any pending textarea edits via `PATCH /save`.

## Data flow

### Happy path

The Telegram callback that handles the "Full Email" button already knows both `emailId` and (when one exists) the associated `draftId`. The callback URL becomes `/reply/:draftId?account=<alias>` (new route) when a draft exists; the existing `/email/:emailId` route is unchanged for emails without a draft.

1. Telegram card's "Full Email" (with draft) → opens mini-app at `/reply/:draftId?account=<alias>`.
2. Server queries `draft_originals` by `draftId` → `{ account, original_body, expires_at }` (used for diff/expiry awareness; not the live body).
3. Server calls `gmailOps.getDraftReplyContext(account, draftId)` → `{ body, incoming: { from, to, subject, date, cc? } }` in one composite call.
4. Template renders with `incoming` headers + editable current `body` + action buttons. If the method returns `null`, render a stub: "Draft no longer exists — [Open thread in Gmail]".
5. User edits, taps Send.
6. JS: `PATCH /api/draft/:draftId/save` (body contents) → success.
7. JS: `POST /api/draft/:draftId/send` → server schedules timer for now+10s, returns `{ sendAt }`.
8. UI swaps button row for undo banner; JS runs visible countdown.
9. Timer fires → `gmailOps.sendDraft(account, draftId)` → Gmail moves draft to Sent.
10. Banner updates to "Sent." and auto-dismisses after 3s.

### Undo path

1. User taps Undo within 10s window.
2. JS: `POST /api/draft/:draftId/send/cancel`.
3. Server: `registry.cancel(draftId)` → clears timer → returns `{ cancelled: true }`.
4. UI: banner disappears, button row returns. No Gmail send occurred. Saved draft body remains in Gmail (matches Gmail's own behavior).

### Edit-in-Gmail path

1. User taps "Edit in Gmail".
2. JS flushes current textarea via `PATCH /api/draft/:draftId/save` first.
3. On 200, opens `https://mail.google.com/mail/u/{account}/#drafts?compose={draftId}` in a new tab/webview.
4. User edits there, returns, taps Send. Server-side send path picks up whatever is in Gmail's current draft.

### Edge cases

| Case | Behavior |
|------|----------|
| Double-tap Send | Registry replaces timer; `sendAt` pushed out 10s from latest tap. One send fires. |
| Close mini-app after Send, before 10s | Timer runs server-side → send fires. Matches "I hit send" mental model. |
| Restart nanoclaw before 10s fires | `shutdown()` clears timers → no send. User reopens mini-app and can re-send. |
| Cancel after fire | Returns `{ cancelled: false }` → UI: "Too late — already sent." |
| `updateDraft` fails on save | UI: "Couldn't save — try Edit in Gmail". Send button disabled until retry. |
| `sendDraft` fails in timer | Event-bus `draft.send.failed` → Telegram notification with Retry + Open-in-Gmail buttons (reuses push-manager + callback-router). |
| Account not registered | Route returns 404 `ACCOUNT_NOT_REGISTERED` → UI: "Account not registered — open in Gmail." |
| Draft deleted in Gmail between save and send | `sendDraft` returns 404 from Gmail → error event → UI/Telegram notification: "Draft no longer exists." |
| Two mini-app sessions on same draft | Not supported (single-user); second session won't see the first's undo state. Out of scope. |

## Error handling

### Response shape

```ts
// Success
{ ok: true, ...payload }

// Client error (4xx)
{ ok: false, error: string, code: 'DRAFT_NOT_FOUND' | 'ACCOUNT_NOT_REGISTERED' | 'INVALID_BODY' }

// Server error (5xx)
{ ok: false, error: string, code: 'GMAIL_API_ERROR' | 'INTERNAL' }
```

Client branches on `code`; shows `error` verbatim when no specific handler applies.

### Logging (pino, structured fields)

| Level | Event | Fields |
|-------|-------|--------|
| info | `Draft save via mini-app` | `{ account, draftId, bodyLen }` |
| info | `Draft send scheduled` | `{ account, draftId, sendAt, delayMs }` |
| info | `Draft send cancelled` | `{ account, draftId }` |
| info | `Draft sent` | `{ account, draftId, threadId, elapsedMs }` |
| warn | `Pending send dropped at shutdown` | `{ pendingCount, draftIds }` |
| error | `Draft send failed` | `{ account, draftId, err }` |
| error | `Draft save failed from mini-app` | `{ account, draftId, err }` |

Component bindings: `{ component: 'mini-app' }` for routes, `{ component: 'gmail' }` for channel-level logs.

### Out-of-UI failure notification

If `sendDraft` fails inside the timer and the mini-app is closed:
1. Registry emits `draft.send.failed` event on the existing event-bus with `{ account, draftId, subject, error }`.
2. An event-bus subscriber routes a Telegram message to the user via push-manager: "❌ Couldn't send reply to *{subject}* — [Retry] [Open in Gmail]".
3. Retry callback uses the existing callback-router pattern; reissuing hits the same `POST /send` route.

### Deliberately not done

- No retry-with-backoff inside `onFire` — fail fast, notify user, let them decide.
- No persistent error log table — pino + Telegram notification are sufficient.
- No circuit breaker on Gmail API (single-user scale).
- No server-side body sanitization — Gmail sanitizes; we trust the user.

## Testing strategy

### Unit tests

**`src/mini-app/pending-send.test.ts`** (new):
- `schedule` fires `onFire` after `delayMs`
- `schedule` same `draftId` twice replaces timer (only latest fires)
- `cancel` of pending timer → `true`, no fire
- `cancel` after fire → `false`
- `shutdown` clears all timers, no fires after
- `onFire` rejection → caught, logged, event-bus emits `draft.send.failed`

**`src/gmail-ops.test.ts`** (extend):
- `GmailOpsRouter.getDraftReplyContext` delegates to registered channel by account
- `GmailOpsRouter.sendDraft` delegates to registered channel by account
- Unknown account → throws existing error message

**`src/channels/gmail.test.ts`** (extend):
- `getDraftReplyContext(draftId)` → calls `drafts.get` + `threads.get`, returns composite `{ body, incoming }`
- `getDraftReplyContext(draftId)` → returns `null` on 404 from Gmail
- `getDraftReplyContext(draftId)` → falls back to stripped `text/html` when draft has no `text/plain` part
- `getDraftReplyContext(draftId)` → populates `incoming` from the most recent non-draft message in the thread
- `sendDraft(draftId)` → calls `gmail.users.drafts.send` with `{ userId: 'me', requestBody: { id: draftId } }`
- Logs success with `{ account, draftId, threadId }`
- Propagates errors after logging

### Route tests

**`src/__tests__/mini-app-draft-send-routes.test.ts`** (new):
- `GET /reply/:draftId` → 200 HTML containing the rendered template with incoming headers + body textarea
- `GET /reply/:draftId` missing draft → 200 HTML stub "Draft no longer exists" (not 404 — UX preference)
- `PATCH /save` happy → 200, `updateDraft` mock called once
- `PATCH /save` missing row → 404 with `DRAFT_NOT_FOUND`
- `POST /send` happy → 200 with `sendAt`, registry has entry
- `POST /send/cancel` pending → 200 `{ cancelled: true }`
- `POST /send/cancel` not pending → 200 `{ cancelled: false }`
- Uses `vi.useFakeTimers()` + `advanceTimersByTime` to exercise fire path

### Integration tests

**`src/__tests__/mini-app-send-integration.test.ts`** (new):
- Seed `draft_originals` row + mock `GmailOps` with in-memory store.
- Flow: `save → send → advance(9s) → cancel` → assert `sendDraft` never called.
- Flow: `send → advance(10s)` → assert `sendDraft` called exactly once with correct `{ account, draftId }`.
- Flow: `sendDraft` throws → assert event-bus receives `draft.send.failed` with correct fields.

### Manual smoke checklist (documented only, not automated)

1. Start dev server; open mini-app for a real agent-drafted reply.
2. Tap Send → Undo within 5s → banner clears, no Sent entry in Gmail.
3. Tap Send → wait 10s → email appears in Gmail Sent folder.
4. Edit body → tap Edit in Gmail → Gmail compose opens with the edited body.
5. Kill nanoclaw mid-10s window → restart → no send occurred.

### Coverage targets

- `PendingSendRegistry` → 100%.
- New route handlers → happy + at least one failure each.
- `sendDraft` Gmail impl → one success + one failure.

### Deliberately not tested

- Gmail API (always mocked).
- Browser-side countdown JS (covered by manual smoke).
- Retry logic (none exists).
- Cross-device state (out of scope).

## Implementation ordering (for writing-plans)

Recommended task sequence:
1. `PendingSendRegistry` + unit tests (pure logic, no dependencies).
2. `getDraftReplyContext` + `sendDraft` in `GmailOps` + `GmailOpsProvider` interfaces + Gmail channel impl + tests.
3. Three new routes in `mini-app/server.ts` + route tests (uses methods from step 2).
4. Event-bus `draft.send.failed` subscriber for out-of-UI failure notification.
5. `email-full.ts` template changes: fetch current body via new route, buttons, textarea, undo banner, inline JS.
6. Wire `registry.shutdown()` into `src/index.ts` SIGTERM/SIGINT handlers.
7. Integration tests.
8. Manual smoke run-through.

Each step commits independently with its own tests landing in the same commit.
