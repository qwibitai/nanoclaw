# Agentic UX Design — NanoClaw Telegram Interface

**Date:** 2026-04-16
**Status:** Draft
**Approach:** Message Renderer (A) + Event-Driven Consumers (C) Hybrid

## Problem Statement

NanoClaw currently operates as a narrator — it reports what happened and asks what to do. Despite having a trust engine, executor pool, browser sidecar, and event bus, the Telegram interface is a flat chronological text stream with no visual hierarchy, no inline actions, and no situational awareness. The gap between backend capability and frontend presentation is the core problem.

**The desired shift:** NanoClaw should act first and report what it did. The bias flips from "ask permission" to "execute and summarize." The UI should surface what needs attention, suppress what doesn't, and make every action one tap away.

## Design Principles

1. **Act first, report what you did** — default to execution, not narration
2. **Silent success, loud failure** — auto-handled items are dimmed and batched; failures escalate immediately
3. **One tap to act** — every actionable message has inline buttons; two-step safety for destructive/financial actions
4. **Situational awareness at a glance** — pinned status bar shows active agents, pending items, daily stats
5. **Detail on demand** — complex tasks open a Telegram Mini App, not more chat messages
6. **Work with the inbox, not replace it** — NanoClaw enriches SuperPilot drafts and Gmail workflows, doesn't duplicate them

## Architecture

### Hybrid: Message Renderer + Event-Driven Consumers

**Message Renderer Pipeline** (for individual message formatting):
```
Agent Output → Classifier → Formatter → Action Attacher → Channel Dispatch
```
Inserted into the existing `router.ts` pipeline between agent output and `routeOutbound()`.

**Event-Driven Consumers** (for aggregate/live views):
```
Event Bus → StatusBarManager
           → AutoApprovalTimer
           → MiniAppStateManager
           → DraftEnrichmentWatcher
           → FailureEscalator
```
New consumers subscribe to existing event bus. The pinned status bar and Mini App are naturally event-driven — they aggregate state across multiple agents and time.

This avoids coupling agents to UI concerns (agents don't know about categories or buttons) while getting live-update benefits where they matter.

---

## Section 1: Message Classification & Rendering Pipeline

### Classifier

Sits in the router between agent output and channel dispatch. Analyzes message content and context to assign metadata:

| Field | Values | Purpose |
|-------|--------|---------|
| `category` | `financial`, `security`, `email`, `team`, `account`, `auto-handled` | Icon + color bar |
| `urgency` | `info`, `attention`, `action-required`, `urgent` | Sort order, notification behavior |
| `actions` | Array of `{ label, callback, style, confirmRequired }` | Inline buttons |
| `batchable` | boolean | Can be grouped with similar items |
| `miniAppUrl` | optional URL | "View Details" button opens Mini App |

### Classification Approach

Rule-based (no ML needed — message types are well-defined):

- **Pattern matching** on known senders/subjects (Chase, Spamhaus, wire notifications, receipts)
- **Trust engine domain** as fallback context — `finance.read`, `comms.write`, etc. (already classified via `TOOL_CLASS_MAP`)
- **Event type** from the event bus provides additional signal

### Rendering Rules

| Category + Urgency | Visual Treatment |
|---------------------|-----------------|
| `auto-handled` + `info` | Dimmed text, grey left bar, batched together |
| `financial` + `action-required` | Green left bar, cross-referenced explanation, two-step confirm button |
| `security` + `urgent` | Red left bar, plan summary, execute/modify/defer buttons, silence-means-approval timer |
| `email` + `attention` | Blue left bar, diff summary if draft enriched, view/send/revert buttons |
| `team` + `info` | Purple left bar, condensed single-line format |
| `account` + `info` | Silent execution, only surfaces on failure (red bar, retry/escalate buttons) |

### Integration Point

`router.ts` → insert between `stripInternalTags()` / `normalizeConfidenceMarkers()` and `routeOutbound()`. The classifier produces a `MessageMeta` object; the formatter uses it to construct the channel-appropriate message (HTML for Telegram, markdown for Discord, etc.).

---

## Section 2: Pinned Status Bar

A single message that NanoClaw keeps editing in-place via `sendProgress()` — the live operations dashboard.

### Structure

```
NANOCLAW STATUS · Updated 30s ago
─────────────────────────────
ACTIVE (3)
● 🛡 Spamhaus investigation · step 2/3 · port scanning
● 📧 Enriching 2 drafts · dev@whoisxml
◉ ⚙ Nstproxy #13 · waiting for CAPTCHA

NEEDS YOU (2)
💰 Wire confirmation — $54.9K
📧 Chase secure message — review needed

TODAY: 12 auto-handled · 3 drafts enriched · 2 needs you · 1 blocked
```

### Behavior

- **Updates on state change**, not on a timer — edits when agents start, complete, block, or items arrive. Avoids Telegram rate limits.
- **Debounced** — waits 2 seconds after last event before editing (coalesces rapid-fire updates).
- **Agent lifecycle** — appears on `task.started`, updates on progress, disappears on `task.complete`. All driven by existing event bus.
- **Blocked items** — yellow indicator with reason (CAPTCHA, 2FA, timeout). Tapping status bar opens Mini App.
- **"Needs You" section** — items persist until acted on (confirm, archive, approve). Counter is the glanceable metric.
- **Daily stats** — reset at midnight PT. Running totals of autonomous vs. user-required actions.
- **One per chat** — pinned in the main group. NanoClaw deletes the old status message and creates a new one if the old one gets buried (Telegram doesn't support true pinned-message editing, so we pin the latest).

### Implementation

New `StatusBarManager` class subscribes to event bus:
- `task.started` / `task.progress` / `task.complete` → update Active section
- `item.classified` with `urgency >= attention` → add to Needs You
- `item.resolved` / callback query processed → remove from Needs You
- `task.failed` / `task.blocked` → update blocked counter
- All auto-handled items → increment daily counter

---

## Section 3: Action Buttons & Interaction Model

### Button Types

| Type | Example | Behavior |
|------|---------|----------|
| Primary action | `✓ Confirm Both` | Green, one tap executes |
| Destructive safe | `📥 Archive` | Grey → tap → transforms to `⚠ Confirm Archive \| Cancel` for 5s |
| Plan execution | `▶ Execute Plan` | Red/orange, one tap starts the agent |
| Secondary | `Review Details`, `View Diff` | Grey, opens detail or Mini App |
| Timed auto-approve | `▶ Starting in 15m...` | Countdown visible, tap to cancel or accelerate |

### Interaction Modes by Domain

| Domain | Buttons | Autonomy |
|--------|---------|----------|
| Account management | None (silent). Failure: retry/escalate/dismiss | Execute silently, escalate on failure |
| Financial | Two-step confirm + review details | Cross-reference and explain, user confirms |
| Security/ops | Execute/modify/defer + auto-approve timer | Brief with plan. Urgent: 15-min silence-means-approval |
| Email drafts | View Diff / Send Now / Revert | Draft-and-hold, notify of changes |
| Routine approvals | Single-tap primary button | Quick-reply shorthand always works |

### Callback Routing

- Button taps hit `onCallbackQuery()` in the Telegram channel (already exists in `channels/telegram.ts`)
- Callback data format: `action:entityId` (e.g., `archive:msg_abc123`, `confirm_wires:txn_456`)
- After action completes, original message edits in-place: buttons replaced with result text (`✓ Archived`, `✓ Wires confirmed`)

### Two-Step Safety

For destructive and financial actions:
1. User taps the action button (e.g., "Archive")
2. Message edits in-place: original button replaced with `⚠ Confirm [action] | Cancel` + 5-second countdown
3. If countdown expires or user taps Cancel → reverts to original buttons
4. If user taps Confirm → executes action, replaces buttons with result

### Quick-Reply Shortcuts

Always available alongside buttons:

| Shortcut | Action |
|----------|--------|
| `y` or `go` | Approve the most recent pending action |
| `stop` | Cancel any silence-means-approval timer |
| `status` | Force status bar refresh |

---

## Section 4: Telegram Mini App

Detail view for complex tasks — opens inside Telegram as a web panel. Same HTML also served as a regular web URL for desktop deep-dives.

### Architecture

- Lightweight Express server bundled with NanoClaw, configurable port
- Serves HTML pages per active task: `https://{host}/task/{taskId}`
- Telegram bot sends messages with `web_app` button → opens Mini App inside Telegram
- Same URL works in a regular browser for desktop use
- Public URL via existing Cloudflare tunnel or ngrok (required for Telegram Mini Apps)

### Task Detail Page Structure

- **Header** — task name, status badge (in progress / blocked / complete), elapsed time
- **Progress steps** — vertical timeline with status icons (✓ done / ● active / ○ pending), description, substatus, expandable log output per step
- **Live log** — monospace scrolling log with timestamps, auto-scrolls, color-coded (green=success, red=error, blue=action, grey=info)
- **Findings panel** — highlighted cards for important discoveries mid-task (e.g., "open relay found on port 25")
- **Action bar** — Pause / Abort / Add Step buttons, persistent at bottom

### State Management

- Task state stored in SQLite (extends existing `db.ts`)
- Mini App polls `/api/task/{taskId}/state` every 2 seconds, or uses SSE for live streaming
- Events from event bus (`task.started`, `task.progress`, `task.complete`) update task state in SQLite
- On completion, detail page shows final summary + follow-up action buttons

### Which Tasks Get a Mini App View

- Any task with 2+ steps
- Any task estimated to take >30 seconds
- Security investigations, research tasks, multi-email operations
- Simple one-shot actions (archive, confirm) do NOT get a Mini App — inline buttons are sufficient

---

## Section 5: Draft Enrichment Pipeline

How NanoClaw works with SuperPilot's auto-drafts — a quality layer, not a replacement.

### Flow

1. SuperPilot creates auto-draft in Gmail (or skips the email entirely)
2. NanoClaw's email watcher detects new draft via Gmail API polling
3. **Enrichment evaluator** decides if the draft needs enhancement:
   - Does it reference something NanoClaw has more context on? (invoices, tickets, conversations from other channels)
   - Is critical context missing that NanoClaw can fill in?
   - Is the tone inappropriate for the recipient?
   - If none → leave the draft alone, no notification
4. If enrichment needed → modify draft in-place via `drafts.update` (same draft ID, same thread position)
5. Store original draft body in SQLite (keyed by draft ID) for revert capability
6. Notify in Telegram: blue bar, `📧 Email · draft enriched`, change summary, `View Diff | Send Now | Revert` buttons
7. "View Diff" opens Mini App showing before/after with highlighted changes
8. "Revert" calls `drafts.update` with stored original body

### When SuperPilot Doesn't Draft

If SuperPilot skipped an email (no rule matched, deemed not worth replying), NanoClaw can create a new draft if it determines a reply is warranted based on broader context:
- Cross-channel knowledge (team discussed this in Telegram/Discord)
- Financial context (invoice referenced, payment received)
- Action items that need acknowledgment

New drafts follow the same draft-and-hold pattern — created in Gmail, notification in Telegram with buttons.

### What NanoClaw Enriches

- Cross-references: invoice numbers, ticket IDs, amounts from other systems
- Context from other channels: "Dmitrii confirmed this in Telegram yesterday"
- Missing follow-ups: "You discussed staging access but the draft doesn't mention it"
- Tone adjustment: only when clearly off (e.g., too casual for a financial counterparty)

### What NanoClaw Does NOT Do

- Rewrite drafts that are fine — avoid churn
- Send without approval — always draft-and-hold
- Replace SuperPilot — NanoClaw is the escalation/enrichment layer

### Revert Safety

- Original draft body stored in SQLite keyed by draft ID
- Revert available for 24 hours, then original is purged
- Revert calls `drafts.update` with the stored original — single API call

---

## Section 6: Event-Driven Status & Autonomy

Event bus consumers that power the pinned status bar, auto-approval, and agent coordination.

### New Event Consumers

| Consumer | Subscribes To | Produces |
|----------|--------------|----------|
| `StatusBarManager` | `task.*`, `item.*`, `digest.*` | Edits pinned message on state change |
| `AutoApprovalTimer` | `plan.proposed` | Starts countdown, emits `plan.auto-approved` or `plan.cancelled` |
| `MiniAppStateManager` | `task.*` | Updates task state in SQLite for Mini App polling |
| `DraftEnrichmentWatcher` | `email.draft.created` | Triggers enrichment evaluator |
| `FailureEscalator` | `task.failed`, `task.blocked` | Sends loud failure message with retry/escalate buttons |

### StatusBarManager

- Subscribes to all task and item events
- Debounces updates: waits 2 seconds after last event before editing pinned message
- Tracks: active agents (count + per-agent summary), pending-your-action items, daily counters
- Resets daily counters at midnight PT

### AutoApprovalTimer

- Triggered when a plan is proposed with `urgency: urgent`
- Starts a 15-minute countdown
- Sends message with countdown: "Auto-executing in 14:58 unless cancelled"
- `stop` quick-reply or Cancel button emits `plan.cancelled`
- Timer expiry emits `plan.auto-approved` → executor picks it up
- Non-urgent plans never auto-approve — buttons only

### Trust Engine Integration

- Classifier assigns `domain.operation` to each action (uses existing `TOOL_CLASS_MAP` with 80+ tools)
- Actions above trust threshold → execute silently, log to status bar
- Actions below threshold → surface with buttons for approval
- Each approval/denial feeds back into trust scores (existing mechanism)
- Trust decay at -0.01/day prevents stale auto-approvals (existing mechanism)

---

## Section 7: Message Batching & Noise Reduction

### Batching Rules

Messages classified as `auto-handled` + `info` are held in a buffer. Buffer flushes on:
- **5 items accumulated** — sends single collapsed message
- **10 minutes elapsed** since first buffered item
- **Higher-priority message arrives** — flush batch first, then send important message (always at bottom/most recent)

### Batch Message Format

Grey left bar, `✓ Auto-handled · N items`, one line per item, dimmed text.

### What Gets Batched

- Marketing emails dismissed
- Duplicate thread notifications
- Receipts and confirmations for known services
- Welcome emails from known signup flows
- Team FYI messages with no action needed

### What Never Gets Batched

- Anything with `urgency` above `info`
- Financial items (always individual with explanation)
- Security items (always individual with plan)
- Draft enrichment notifications
- Failure escalations

### Morning Digest

- Sent once daily at configurable time (default 8:00 AM PT)
- Summarizes overnight activity: "While you slept: 14 auto-handled, 2 drafts enriched, 1 pending your action"
- Pending items get inline buttons right in the digest
- Regular message, not a replacement for the pinned status bar

---

## Section 8: Email Preview & Full View

Three tiers of depth for viewing email content — summary alone often isn't enough.

### Tier 1: Intelligent Summary (Default)

NanoClaw's classification produces a concise summary with key points and pending actions. This is the default message shown in chat — no email body included.

### Tier 2: Quick Preview (Inline Expand)

- "Preview ▼" button on any email notification
- Tapping it edits the message in-place to include the first ~500 characters of the actual email body
- Email body fetched via Gmail API on demand (not stored in the notification)
- "Collapse ▲" shrinks back to summary
- Useful for quick context without leaving the chat

### Tier 3: Full Email (Mini App)

- "Full Email ↗" button opens the Mini App with complete rendered email
- Preserves HTML formatting, shows attachments list, full headers (From, To, CC, Date)
- Reply chain shown threaded
- Action buttons available at bottom of the full view (Reply, Archive, Forward)

### Implementation

- Gmail API `messages.get` with `format: full` for preview/full content
- Cache fetched email bodies in memory (not SQLite) with 30-minute TTL to avoid repeated API calls
- Preview truncation: first 500 chars, break at word boundary, append "— truncated, tap Full Email for complete message"

---

## Section 9: Auto-Attached Question Buttons

When NanoClaw asks a question, appropriate buttons are auto-attached based on question type.

### Question Detection

The message classifier detects question patterns in outbound messages:
- Yes/no: "Want me to...?", "Should I...?", "All expected?", "Is this correct?"
- Confirmation: "Were both expected?", "Approve this?"
- Multi-option: numbered lists with a question at the end

### Button Variants

| Question Type | Buttons |
|---------------|---------|
| Yes/No | `Yes \| No \| Let me think...` |
| Financial confirmation | `Yes, all expected \| Not all — review \| Details ↗` |
| Multi-option | One button per option + `Let me respond` fallback |

### "Let me think..." / Defer Behavior

- Snoozes the item — removes from immediate view but keeps it in "Needs You" on the status bar
- Re-surfaces in the next digest or after a configurable snooze interval (default 2 hours)
- Item is never auto-resolved by snoozing — it stays pending until explicitly acted on

### Implementation

- Detection runs in the message formatter, after classification
- Pattern matching on the last sentence/line of the outbound message
- Buttons attached via `sendMessageWithActions()` — same mechanism as action buttons
- Callback data format: `answer:questionId:yes`, `answer:questionId:no`, `answer:questionId:defer`

---

## Section 10: Post-Action Archive Flow

After an action is performed on an email, NanoClaw offers archiving without auto-archiving. Respects the rule: **never auto-archive emails**.

### Layer 1: Inline Post-Action

After the user acts on an email (confirms, replies, approves):
1. Message edits in-place: buttons replaced with result text + new buttons
2. Result format: `✓ [action completed]` + `📥 Archive | Done`
3. "Archive" → two-step confirm (consistent with safety pattern throughout)
4. "Done" → item resolved, disappears from "Needs You", email stays in inbox
5. If both ignored → item auto-resolves after timeout, email stays in inbox

### Layer 2: Morning Digest Batch Sweep

For acted-on emails that weren't archived:
- Morning digest includes an "Inbox Cleanup" section
- Lists only emails where NanoClaw completed an action (replied, confirmed, verified)
- Never includes emails that were just read or previewed
- Buttons: `Archive All N | Review List | Skip`
- "Archive All" gets two-step confirm
- "Review List" opens Mini App with per-email detail
- "Skip" dismisses — section won't re-appear until next digest with new items
- If user never archives, that's fine — no nagging beyond the single daily digest mention

### Tracking

- New `acted_emails` table in SQLite: `email_id`, `thread_id`, `account`, `action_taken`, `acted_at`, `archived_at` (null until archived)
- Populated when a callback action completes on an email notification
- Morning digest queries for `archived_at IS NULL AND acted_at > yesterday`

---

## New Events Required

Events that must be added to the event bus (not already emitted):

| Event | Emitted By | Data |
|-------|-----------|------|
| `plan.proposed` | Agent container on plan output | `{ taskId, plan, urgency, domain }` |
| `plan.auto-approved` | AutoApprovalTimer | `{ taskId }` |
| `plan.cancelled` | AutoApprovalTimer on user cancel | `{ taskId }` |
| `email.draft.created` | Gmail watcher | `{ draftId, threadId, account }` |
| `email.draft.enriched` | DraftEnrichmentWatcher | `{ draftId, changes }` |
| `task.progress` | Container runner | `{ taskId, step, total, substatus }` |
| `email.action.completed` | Archive tracker | `{ emailId, threadId, account, action }` |

Existing events already emitted and consumed: `task.started`, `task.complete`, `task.failed`, `task.queued`, `item.classified`, `digest.sent`.

## Files Modified

| File | Changes |
|------|---------|
| `src/router.ts` | Insert classifier + formatter pipeline before `routeOutbound()` |
| `src/types.ts` | Add `MessageMeta` interface, extend `Action` type |
| `src/db.ts` | Add task state table, draft originals table |
| `src/events.ts` | Add new event types listed above |
| `src/channels/telegram.ts` | Mini App button support (`web_app` keyboard), two-step callback handling |
| New: `src/message-classifier.ts` | Rule-based classifier |
| New: `src/message-formatter.ts` | Category → visual format rendering |
| New: `src/status-bar.ts` | StatusBarManager event consumer |
| New: `src/auto-approval.ts` | AutoApprovalTimer event consumer |
| New: `src/draft-enrichment.ts` | DraftEnrichmentWatcher + evaluator |
| New: `src/mini-app/server.ts` | Express server for Mini App HTML |
| New: `src/mini-app/templates/` | HTML templates for task detail pages |
| New: `src/failure-escalator.ts` | FailureEscalator event consumer |
| New: `src/message-batcher.ts` | Batch buffer + flush logic |
| New: `src/email-preview.ts` | Gmail API fetch, preview truncation, caching |
| New: `src/question-detector.ts` | Pattern matching for auto-attaching yes/no/multi-option buttons |
| New: `src/archive-tracker.ts` | Post-action archive flow, acted_emails table, batch sweep |
