# Telegram UX Improvements: Actionable Buttons, Error Recovery, Message Consolidation, Mini App Access

## Problem

Four UX issues observed in production Telegram messages (2026-04-16):

1. **No actionable buttons** — Agent suggests "Want me to forward this to Philip?" but the Yes/No buttons don't execute anything. User must type a reply.
2. **Archive error** — "confirm_archive failed: No Gmail channel registered for account: topcoder1@gmail.com" because SSE stores full email addresses but GmailOpsRouter registers by alias (`personal`).
3. **Duplicate messages** — A single agent container run produces 2+ Telegram messages for the same email (detailed analysis + "Email · FYI" follow-up).
4. **Mini app buried** — The "🌐 Full Email" button only appears after clicking "📧 Expand" — two taps deep. No permanent entry point.

## Solution

### 1. Account Alias Resolution (Archive Bug Fix)

`GmailOpsRouter` gains a reverse map from email addresses to aliases. When `register(alias, channel)` is called, it also stores `channel.emailAddress → alias`. The Gmail channel already knows its OAuth email address.

`getChannel(account)` resolution order:
1. Exact match on alias (e.g., `personal`) — current behavior
2. Exact match on email→alias map (e.g., `topcoder1@gmail.com` → `personal`)
3. Throw `Error` — preserves error for genuinely unknown accounts

**Error recovery in callback router:** When `confirm_archive` fails:
1. Log the error
2. Show "⚠️ Archive failed — retrying..."
3. Attempt alias resolution and retry once
4. If still failing: "⚠️ Couldn't archive. Try again later." with a Retry button (`retry_archive:entityId`)

**Changes:**
- `src/gmail-ops.ts` — add `emailAddress` to `GmailOpsProvider` interface, add reverse map in `GmailOpsRouter`, update `getChannel()` resolution
- `src/channels/gmail.ts` — expose `emailAddress` getter (from OAuth profile)
- `src/callback-router.ts` — add retry logic in `confirm_archive`, add `retry_archive` case
- `src/index.ts` — pass email address during `register()` call

### 2. Message Consolidation (Edit-in-Place)

When the agent container produces multiple output chunks in a single run, subsequent chunks edit the original Telegram message instead of sending new ones.

**Mechanism:**
- First output chunk: send as new message via `sendMessageWithActions()`, save returned `message_id`
- Subsequent chunks from same container run: call `editMessageTextAndButtons()` on the original message, appending new text and updating buttons
- If edit fails (message too old, deleted, etc.): fall back to sending a new message

**Scope boundary:** Only consolidates chunks within a single container run (identified by run ID). Cross-run deduplication is handled by the existing EmailTriggerDebouncer.

**Changes:**
- `src/index.ts` — track `lastMessageId` per container run in the `onData` callback, decide send-vs-edit

### 3. Actionable Buttons (Forward, Open URL, RSVP)

A new action detection layer extracts structured actions from agent output and attaches purpose-built buttons that actually execute the action.

**Action detection** — regex patterns on agent output text, similar to `question-detector.ts`:

| Pattern | Action | Button |
|---------|--------|--------|
| `forward.*to\s+(\S+@\S+)` | Forward email to extracted address | `📨 Forward to user@...` |
| `RSVP.*(?:yes\|attend\|going)` | RSVP yes to calendar event | `✅ RSVP Yes` / `❌ Decline` |
| `click.*link\|open.*link\|magic.*link` | Open URL via browser sidecar | `🔗 Open Link` |

**Priority:** Action-specific buttons replace generic Yes/No buttons from the question detector. If `action-detector` returns results, those take priority. If not, `question-detector` runs as fallback.

**Execution — new callback-router cases:**

- **`forward:threadId:recipient`** → confirmation step: edit message to "Forward to recipient?" with [Confirm / Cancel]
- **`confirm_forward:threadId:recipient`** → calls `gmailOps.forwardThread(account, threadId, recipient)`, edits message to "✅ Forwarded to recipient"
- **`rsvp:eventId:accepted`** / **`rsvp:eventId:declined`** → calls `calendarOps.rsvp(eventId, response)`, edits message to "✅ RSVP'd" or "❌ Declined"
- **`open_url:encodedUrl`** → confirmation step: shows full URL with [Confirm / Cancel]
- **`confirm_open_url:encodedUrl`** → triggers browser sidecar to open URL, edits message to "✅ Opened"

**Safety:**
- Forward: two-step confirmation (same pattern as archive)
- Open URL: always shows full URL for inspection before confirming
- RSVP: executes immediately (low-risk, reversible)

**Changes:**
- New `src/action-detector.ts` — `detectActions(text, meta): DetectedAction[]`
- `src/callback-router.ts` — new cases: `forward`, `confirm_forward`, `cancel_forward`, `rsvp`, `open_url`, `confirm_open_url`
- `src/gmail-ops.ts` — add `forwardThread(account, threadId, recipient)` to `GmailOps` interface and `GmailOpsRouter`
- `src/channels/gmail.ts` — implement `forwardThread` using Gmail API: fetch original message with `messages.get`, construct a new message with `To: recipient`, `Subject: Fwd: original_subject`, and the original body as quoted content, send via `messages.send`
- New `src/calendar-ops.ts` — `CalendarOps` interface with `rsvp(eventId, response)`, uses Google Calendar API `events.patch` to update `attendees[].responseStatus`
- `src/router.ts` — `classifyAndFormat` runs action detection, action buttons take priority over generic Yes/No

### 4. Mini App Discoverability

**Menu button:** On Telegram bot startup, call `setChatMenuButton` to set a persistent Web App button:
- Label: "📱 App"
- URL: `MINI_APP_URL` (Cloudflare tunnel)
- Opens mini app dashboard (root `/` route)
- Only set if `MINI_APP_URL` is configured; skip silently otherwise
- One API call per registered Telegram chat at startup

**First-level Full Email button:** Always attach "🌐 Full Email" on email-category messages when `MINI_APP_URL` is set, regardless of body length. No expand step required.

Button order on email messages: [Action buttons] → [🌐 Full Email] → [🗄 Archive]

**Changes:**
- `src/channels/telegram.ts` — call `bot.api.setChatMenuButton()` during connection setup
- `src/router.ts` — always attach Full Email button for email-category messages

## Architecture

```
Agent container output
    │
    ▼
classifyAndFormat(text)
    ├── classifyMessage(text)           → category, urgency
    ├── detectActions(text, meta)       → Forward/RSVP/OpenURL buttons (NEW)
    ├── detectQuestion(text)            → Yes/No fallback (existing)
    └── formatWithMeta(text, meta)      → display text
    │
    ▼
Send or Edit decision (per container run)
    ├── First chunk  → sendMessageWithActions() → save message_id
    └── Later chunks → editMessageTextAndButtons() on saved message_id
    │
    ▼
User taps button
    │
    ▼
callback-router.ts
    ├── forward / confirm_forward  → gmailOps.forwardThread()
    ├── rsvp                       → calendarOps.rsvp()
    ├── open_url / confirm_open_url → browser sidecar
    ├── archive / confirm_archive  → gmailOps.archiveThread() (with alias resolution)
    └── retry_archive              → retry with resolved alias
```

## Files Changed

| File | Change |
|------|--------|
| `src/action-detector.ts` | New — detect forward/RSVP/open-URL actions from agent text |
| `src/calendar-ops.ts` | New — CalendarOps interface + RSVP via Google Calendar API |
| `src/gmail-ops.ts` | Add `forwardThread` to interface, add email→alias reverse map |
| `src/channels/gmail.ts` | Implement `forwardThread`, expose `emailAddress` getter |
| `src/channels/telegram.ts` | Call `setChatMenuButton` on startup |
| `src/callback-router.ts` | New cases: forward, rsvp, open_url, retry_archive; archive error recovery |
| `src/router.ts` | Run action detection, always attach Full Email button for email messages |
| `src/index.ts` | Track lastMessageId per container run for edit-in-place; pass email to register() |
| `src/__tests__/action-detector.test.ts` | New — unit tests for action detection |
| `src/__tests__/callback-router.test.ts` | Tests for forward, rsvp, open_url, retry_archive |
| `src/__tests__/gmail-ops.test.ts` | Tests for email→alias resolution, forwardThread |
| `src/__tests__/calendar-ops.test.ts` | New — tests for RSVP |

## Edge Cases

- **No MINI_APP_URL configured:** Menu button is not set, Full Email buttons are not attached. No errors.
- **Gmail channel has no emailAddress:** Reverse map entry is skipped. Archive still works if the account value happens to be an alias.
- **Forward recipient not an email:** Action detector regex requires `\S+@\S+` — non-email suggestions don't get a Forward button.
- **Multiple actions in one message:** Each detected action gets its own button. All buttons appear in one row.
- **Edit fails on consolidation:** Falls back to sending a new message. User sees two messages instead of one — acceptable degradation.
- **RSVP without calendar event ID:** The action detector extracts event details (date, title) from agent text and matches against upcoming events from the calendar poller's cached data. If no matching event is found, RSVP button is not attached. Match is by date + title substring.
- **Browser sidecar not running:** Open URL confirmation shows but execution fails. Error displayed inline: "⚠️ Browser not available."
- **Debouncer disabled (debounceMs=0):** No impact — consolidation operates at the container-run level, not the debounce level.
