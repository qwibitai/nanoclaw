# NanoClaw Chat Interface UX: From Notification Noise to Command Center

**Date:** 2026-04-14
**Status:** CEO reviewed. SCOPE EXPANSION mode. 7 proposals, 7 accepted, 0 deferred.
**Depends on:** [Scope Expansion Design](2026-04-13-nanoclaw-scope-expansion-design.md) (event bus, trust engine, executor pool)

## Problem

NanoClaw's Telegram chat is noisy. The morning briefing surfaces items you already handled. "What did I miss?" gives shallow counts without content. There's no way to dismiss, acknowledge, or prioritize items. FYI updates arrive with the same weight as action-required items. The result: you stop trusting the briefing and go check email directly, which defeats the entire point.

**Core pain points:**
1. No awareness of user actions (replied emails, accepted invites still show as pending)
2. No urgency separation (ESCALATE items look the same as FYI)
3. No dismissal mechanism (items persist until they age out or get re-processed)
4. Briefing runs on a schedule, not when you need it
5. Archived emails still appear in status reports

## Design Principles

1. **Don't make me check.** Push what matters, batch what doesn't.
2. **Know what I already did.** Auto-detect replies, RSVPs, and resolutions before surfacing items.
3. **Quiet days should be quiet.** No digest on days with nothing to report.
4. **One chat, structured flow.** Don't fragment attention across multiple groups or topics.
5. **Degrade gracefully.** If auto-detection fails, ask in the next digest. Never lose items silently.

## Architecture

### Interaction Model: Event Stream + Dashboard Morning

The chat operates in two modes:

**Morning Dashboard (scheduled, 7:30 AM PT)**
A structured overview message that sets the day's agenda. Dashboard-style layout with clear sections. Runs every morning regardless of volume.

**Event Stream (real-time, rest of day)**
Individual push messages for action-required items as they're detected. Each is its own message with inline action buttons. Non-urgent items accumulate silently until the next smart digest.

```
7:30 AM  ┌──────────────────────────────┐
         │  MORNING DASHBOARD           │
         │  Action Required (3)         │
         │  Waiting On You (2)          │
         │  Overnight Summary (resolved │
         │    4 items, 2 FYI)           │
         └──────────────────────────────┘
              │
              ▼  (real-time, throughout day)
10:15 AM [PUSH] 🔴 Email from Sarah Chen re: Q2 budget approval
         [Approve] [Dismiss] [Snooze 2h]
              │
12:30 PM [PUSH] 🔴 Calendar conflict: 2pm Design Review vs 2pm Standup
         [Keep Design Review] [Keep Standup] [Dismiss]
              │
3:00 PM  ┌──────────────────────────────┐
         │  SMART DIGEST                │
         │  Resolved: budget email ✓    │
         │  FYI: 3 Discord threads      │
         │  Stale: PR review from Wed?  │
         └──────────────────────────────┘
              │
6:00 PM  (no digest — nothing accumulated)
```

### Classification Pipeline

Items flow through a layered classification before reaching the chat:

```
Source              Specialist           Orchestrator          Output
─────────────────────────────────────────────────────────────────────
Gmail          →  SuperPilot triage  →  NanoClaw decision  →  push/digest/resolved
Calendar       →  (direct)           →  NanoClaw decision  →  push/digest/resolved
Discord        →  (direct)           →  NanoClaw decision  →  push/digest/resolved
Other channels →  (direct)           →  NanoClaw decision  →  push/digest/resolved
```

**SuperPilot's role:** Classify emails (needs-attention, FYI, newsletter, transactional). This classification is an input signal, not the final decision.

**NanoClaw's role:** Make the final push/digest/resolved decision by combining:
- SuperPilot classification (for emails)
- Trust tier (ESCALATE/PROPOSE/AUTO)
- Cross-source context (already replied? already RSVPed? thread resolved?)
- User action detection (Gmail `from:me`, `in:inbox`, calendar RSVP status)
- Item age and staleness

**Decision matrix:**

| SuperPilot | Trust Tier | User Acted? | Decision |
|-----------|-----------|------------|----------|
| needs-attention | ESCALATE | No | **PUSH** immediately |
| needs-attention | PROPOSE | No | **PUSH** with approve/dismiss |
| needs-attention | AUTO | No | **PUSH** (trust override: needs attention) |
| needs-attention | any | Yes (replied) | **RESOLVED** (show in digest) |
| FYI | any | — | **DIGEST** batch |
| newsletter | any | — | **DIGEST** batch (or suppress) |
| — (calendar) | — | conflict in <30min | **PUSH** |
| — (calendar) | — | conflict in >30min | **DIGEST** |
| — (Discord) | — | @mention from VIP | **PUSH** |
| — (Discord) | — | other | **DIGEST** |

### Item Lifecycle

Every tracked item follows this lifecycle:

```
                    ┌─────────┐
                    │ DETECTED│  (source emits event)
                    └────┬────┘
                         │
                    ┌────▼────┐
                    │CLASSIFY │  (pipeline assigns push/digest)
                    └────┬────┘
                         │
              ┌──────────┼──────────┐
              ▼                     ▼
         ┌─────────┐          ┌─────────┐
         │  PUSHED  │          │ QUEUED  │  (waiting for digest)
         │(to chat) │          │         │
         └────┬─────┘          └────┬────┘
              │                     │
              ▼                     ▼
         ┌─────────┐          ┌─────────┐
         │ PENDING  │          │DIGESTED │  (shown in digest)
         │(awaiting │          │         │
         │ action)  │          └────┬────┘
         └────┬─────┘               │
              │                     │
              ├──────────┬──────────┘
              ▼          ▼
         ┌─────────┐ ┌─────────┐
         │RESOLVED │ │  STALE  │  (2 digest cycles, no response)
         │(auto or │ │(auto-   │
         │ manual) │ │archive) │
         └─────────┘ └─────────┘
```

**State transitions:**
- DETECTED → CLASSIFY: Immediate, on event bus emission
- CLASSIFY → PUSHED: Item classified as push-worthy
- CLASSIFY → QUEUED: Item classified as digest-worthy
- PUSHED → PENDING: Message sent to Telegram
- PENDING → RESOLVED: Auto-detected (user acted) or manual (button/reply)
- QUEUED → DIGESTED: Shown in smart digest
- PENDING/DIGESTED → STALE: Unconfirmed after 2 digest cycles (auto-archive)

## Components

### 1. Morning Dashboard

**Trigger:** Scheduled task, 7:30 AM PT daily.

**Sections (top to bottom):**

```
📋 MORNING DASHBOARD — Mon Apr 14

━━ ACTION REQUIRED (3) ━━
1. 🔴 Email: Sarah Chen — Q2 budget needs your sign-off (received 11pm)
2. 🔴 Email: Legal — contract review for Acme Corp (2 days old)
3. 🟡 Calendar: Design review conflicts with standup at 2pm

━━ WAITING ON OTHERS (2) ━━
4. ⏳ PR #847: waiting on Alex's review (submitted yesterday)
5. ⏳ Email: vendor quote — sent follow-up, no reply yet

━━ OVERNIGHT SUMMARY ━━
✅ Resolved: 4 items (3 emails auto-replied by rules, 1 Discord thread closed)
📬 FYI: 2 newsletter digests, 1 GitHub notification
📊 Quiet night — no escalations

━━━━━━━━━━━━━━━━━━━━━━
Reply with a number to act, or just start your day.
```

**Data sources:**
- `processed_items` table for tracked items and their states
- SuperPilot API for email classifications
- Gmail MCP for action detection (`from:me`, `in:inbox`)
- Calendar MCP for today's conflicts
- Discord channel history (last 12h)

**Behavioral rules:**
- Always runs, even on quiet days (shows "Nothing urgent. Clean slate today.")
- Filters out items where user already acted (Gmail reply sent, calendar accepted)
- Filters out items no longer in inbox (archived = resolved)
- Numbers items for quick reply-based action ("reply 1" to handle first item)
- Resets the smart digest accumulator

### 2. Push Notifications

**Trigger:** Real-time, via event bus subscription.

**Push criteria (any of these = immediate push):**
- Trust tier ESCALATE (NanoClaw cannot handle autonomously)
- SuperPilot "needs-attention" AND user has NOT already acted
- Calendar conflict within 30 minutes
- Discord @mention from configured VIP list
- Any source with urgency keywords ("urgent", "deadline", "ASAP", "blocking") from known contacts

**Message format:**

```
🔴 ACTION: Email from Sarah Chen
Re: Q2 Budget Approval

"Hi, the board needs sign-off by EOD Wednesday.
Can you review the attached and approve?"

[✅ Approve] [❌ Dismiss] [⏰ Snooze 2h]
```

**Behavioral rules:**
- Each push is a standalone message (not edited into a thread)
- Include enough context to act without opening the source app (sender, subject, key excerpt)
- Inline buttons map to trust actions (approve → AUTO-handle, dismiss → mark resolved, snooze → re-push in 2h)
- Suppress duplicate pushes: if item already pushed and still PENDING, don't re-push
- Rate limit: max 3 pushes in any 30-minute window. If exceeded, batch remaining into a "3 items need attention" summary push

### 3. Smart Digest

**Trigger:** Threshold-based. Fires when 5+ items accumulate in the QUEUED state since last digest or morning dashboard. Never fires if fewer than 5 items. Morning dashboard resets the counter.

**Sections:**

```
📊 DIGEST — 3:00 PM

━━ RESOLVED SINCE LAST CHECK ━━
✅ Budget email — you replied at 10:32am
✅ Calendar conflict — you kept Design Review
✅ Discord #dev — thread marked resolved

━━ FYI ━━
📬 3 GitHub notifications (2 CI passes, 1 review requested)
📬 Newsletter: TechCrunch AI roundup
📬 Discord #general: 12 messages (nothing directed at you)

━━ STILL PENDING ━━
⏳ PR review request from Alex (#847) — pushed 4h ago

━━━━━━━━━━━━━━━━━━━━━━
Next digest when 5+ items accumulate.
```

**Behavioral rules:**
- "Resolved" section shows auto-detected resolutions with evidence ("you replied at X")
- "FYI" section batches low-priority items with counts, not full details
- "Did you handle?" section shows the fallback ask for unconfirmed items (4h+ since push)
- Fallback items include action buttons (done/remind/skip)
- If no items to report, digest does not fire (quiet days stay quiet)
- Max one digest per 2 hours to avoid notification fatigue

### 4. Auto-Detect Resolution

**Purpose:** Determine whether the user already handled an item without requiring manual dismissal.

**Detection methods by source:**

| Source | Detection Method | Check Frequency |
|--------|-----------------|-----------------|
| Gmail | `from:me` in thread (user replied) | Every email-poll cycle |
| Gmail | NOT `in:inbox` (user archived) | Every email-poll cycle |
| Gmail | Label changes (user categorized) | Every email-poll cycle |
| Calendar | RSVP status changed (accepted/declined) | Every 15 min |
| Discord | Thread marked resolved or user replied | Every 15 min |
| Push buttons | User tapped Approve/Dismiss in Telegram | Immediate (callback) |

**Resolution confidence:**
- Gmail `from:me` in thread → HIGH confidence (definitely replied)
- Gmail archived → HIGH confidence (intentionally moved out of inbox)
- Calendar RSVP → HIGH confidence (explicit action)
- Discord reply → MEDIUM confidence (reply != resolution)
- No signal after 4h → LOW confidence → trigger fallback ask

### 5. Passive Pending + Staleness

**Design decision (CEO review + outside voice):** No active "Did you handle?" fallback asks. Asking creates meta-notifications that double interaction cost. Instead, unconfirmed items appear passively in the digest's "still pending" section. If you saw it and didn't act, that IS your answer.

**Lifecycle:**
1. Item pushed, enters PENDING state
2. Auto-detection checks run every cycle (Gmail from:me, archived, RSVP)
3. If resolved → mark resolved, show in digest's "resolved" section
4. If still pending after 4h → show in digest's "still pending" section (passive, no buttons)
5. If still pending after 2 digest cycles → transitions to STALE (auto-archived)

**Auto-archive behavior:**
- STALE items are logged but removed from active tracking
- They appear in the next digest's resolved section as "auto-archived (stale)"
- They do NOT generate new pushes
- Stale count is tracked for the learning system (high stale rate = classification needs tuning)

### 6. "What Did I Miss?" Command

**Current state:** Returns shallow counts ("Emails processed: 5"). No content detail.

**Redesigned behavior:** Generates an on-demand digest equivalent. Same format as smart digest, but triggered manually instead of by threshold.

```
User: what did I miss?

📊 CATCH-UP — since 2:00 PM

━━ ACTION REQUIRED ━━
🔴 Email: Legal — contract review (pushed at 2:15pm, still pending)

━━ RESOLVED ━━
✅ 2 emails auto-handled (newsletters archived)
✅ Discord thread #metrics closed

━━ FYI ━━
📬 1 GitHub notification (CI pass)
📬 4 Discord messages in #general

━━━━━━━━━━━━━━━━━━━━━━
1 item needs your attention.
```

**Behavioral rules:**
- Scoped to time since last interaction (last message from user in chat)
- Uses the same classification pipeline as smart digest
- Resets the smart digest accumulator (prevents double-reporting)
- If nothing happened: "All clear since [time]. Nothing needs your attention."

## Data Model

### Item Tracking Table

Extends the existing `processed_items` table or creates a new `tracked_items` table:

```sql
CREATE TABLE tracked_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,          -- 'gmail', 'calendar', 'discord', etc.
  source_id TEXT NOT NULL,       -- email thread ID, event ID, message ID
  group_name TEXT NOT NULL,      -- NanoClaw group (usually 'main')
  state TEXT NOT NULL,           -- 'detected', 'pushed', 'pending', 'queued',
                                 -- 'digested', 'resolved', 'stale'
  classification TEXT,           -- 'push', 'digest', 'resolved'
  superpilot_label TEXT,         -- SuperPilot's classification (emails only)
  trust_tier TEXT,               -- 'auto', 'propose', 'escalate'
  title TEXT NOT NULL,           -- Short display title
  summary TEXT,                  -- Content excerpt for push/digest display
  detected_at INTEGER NOT NULL,  -- Unix timestamp
  pushed_at INTEGER,             -- When push was sent (if applicable)
  resolved_at INTEGER,           -- When resolution was detected
  resolution_method TEXT,        -- 'auto:gmail_reply', 'auto:archived',
                                 -- 'manual:button', 'manual:reply', 'stale'
  digest_count INTEGER DEFAULT 0,-- Number of digest cycles this appeared in
  telegram_message_id INTEGER,   -- For button callback tracking
  classification_reason TEXT,    -- JSON: full decision chain for debuggability
                                 -- e.g. {"superpilot":"needs-attention","trust":"escalate",
                                 --       "learning":"no_adjustment","calendar":"not_in_meeting",
                                 --       "final":"push"}
  metadata TEXT                  -- JSON blob for source-specific data
);

CREATE INDEX idx_tracked_state ON tracked_items(group_name, state);
CREATE INDEX idx_tracked_source ON tracked_items(source, source_id);
```

### Digest State

```sql
CREATE TABLE digest_state (
  group_name TEXT PRIMARY KEY,
  last_digest_at INTEGER,          -- Unix timestamp of last digest
  last_dashboard_at INTEGER,       -- Unix timestamp of last morning dashboard
  queued_count INTEGER DEFAULT 0,  -- Items accumulated since last digest
  last_user_interaction INTEGER    -- For "what did I miss?" scoping
);
```

## Integration Points

### Event Bus Events (new)

```typescript
// Emitted when classification pipeline makes a decision
'item.classified'    → { itemId, decision: 'push' | 'digest' | 'resolved', source, reason }

// Emitted when push message sent
'item.pushed'        → { itemId, telegramMessageId }

// Emitted when resolution auto-detected
'item.resolved'      → { itemId, method: 'auto:gmail_reply' | 'auto:archived' | ... }

// Emitted when digest fires
'digest.sent'        → { groupName, itemCount, digestType: 'smart' | 'morning' | 'ondemand' }

// Emitted when item goes stale
'item.stale'         → { itemId, digestCycles: number }
```

### Existing Systems Modified

| System | Change |
|--------|--------|
| `email-poll` | Add resolution detection (check `from:me`, `in:inbox`) before processing |
| `morning-briefing` | Replace with morning dashboard format, query `tracked_items` |
| `trust-commands.ts` ("what did I miss?") | Replace count-based response with on-demand digest |
| `processed_items` table | Add `tracked_items` table alongside (don't break existing) |
| Task scheduler | Add smart digest check on interval (every 15 min) |

### Process Boundary (CEO review + outside voice decision)

Classification is split across process boundaries:

**Container agent (email-poll):** Writes SuperPilot label + source metadata to `tracked_items` table. The container has MCP tool access (SuperPilot, Gmail, Calendar). It detects new items and writes their initial classification.

**Orchestrator process:** Reads `tracked_items`, applies trust tier overlay + learning adjustments + calendar-aware delivery logic. Makes the final push/digest/resolved decision. Has event bus access, trust engine, and learning loop.

**Data bridge:** The email-poll container writes to the shared SQLite DB (`/workspace/project/store/messages.db`). The orchestrator reads from the same DB on a 15-second polling interval (not event-driven, since container writes happen outside the orchestrator's process).

### Channel Interface Changes (required for Phase 3)

The current `Channel` interface at `src/types.ts` has `sendMessage(jid: string, text: string): Promise<void>`. This must be extended:

```typescript
interface Channel {
  sendMessage(jid: string, text: string): Promise<void>;
  sendMessageWithKeyboard?(
    jid: string,
    text: string,
    keyboard: InlineKeyboard
  ): Promise<number>;  // returns message ID for callback tracking
  onCallbackQuery?(handler: (query: CallbackQuery) => void): void;
}
```

Optional methods so non-Telegram channels aren't affected. The push manager checks for `sendMessageWithKeyboard` availability and falls back to `sendMessage` with text-based action instructions.

### Telegram-Specific

- **Inline buttons:** Use Telegram's `InlineKeyboardMarkup` for action buttons on push messages
- **Callback queries:** Add `bot.on('callback_query:data', ...)` handler in TelegramChannel
- **Message formatting:** Use Telegram's HTML parse_mode for structured sections (more reliable than MarkdownV2, no escaping issues)
- **Rate limiting:** Respect Telegram's rate limits (30 messages/second to same chat)

## Configuration

```typescript
interface ChatInterfaceConfig {
  morningDashboardTime: string;    // Default: '07:30' (PT)
  digestThreshold: number;         // Default: 5 (items before digest fires)
  digestMinInterval: number;       // Default: 7200 (seconds, 2h minimum between digests)
  fallbackAskWindow: number;       // Default: 14400 (seconds, 4h before asking)
  staleAfterDigestCycles: number;  // Default: 2
  pushRateLimit: number;           // Default: 3 (max pushes per 30 min)
  pushRateWindow: number;          // Default: 1800 (seconds)
  vipList: string[];               // Discord/email VIP senders that always push
  urgencyKeywords: string[];       // Default: ['urgent', 'deadline', 'asap', 'blocking']
}
```

## Migration Path

This design builds on existing infrastructure. No breaking changes.

**Phase 1: Item Tracking + Resolution Detection**
- Create `tracked_items` and `digest_state` tables
- Add resolution detection to email-poll (Gmail `from:me`, `in:inbox` checks)
- Emit `item.classified` and `item.resolved` events on event bus

**Phase 2: Morning Dashboard**
- Replace morning briefing output format with dashboard layout
- Query `tracked_items` for state-aware display
- Filter resolved items before display

**Phase 3: Push Notifications**
- Add classification pipeline (SuperPilot signal + trust tier + context)
- Send push messages with inline buttons
- Handle button callbacks (approve/dismiss/snooze)
- Implement push rate limiting

**Phase 4: Smart Digest**
- Add digest state tracking
- Implement threshold-based digest trigger (check every 15 min)
- Build digest message format with resolved/FYI/fallback sections
- Implement "what did I miss?" as on-demand digest

**Phase 5: Fallback + Staleness**
- Add fallback ask logic (4h window, include in digest)
- Add stale detection (2 digest cycles)
- Auto-archive stale items
- Track stale rates for learning system feedback

## Scope Expansions (CEO Review)

### 7. Thread Intelligence

Instead of tracking individual items, NanoClaw groups related items into "threads of work." An ongoing deal = email chain + calendar meeting + Discord thread + pending contract. The dashboard shows threads, not individual items.

**Data model changes:**

```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  group_name TEXT NOT NULL,
  title TEXT NOT NULL,            -- "Acme Corp deal", "Q2 budget approval"
  source_hint TEXT,               -- primary source that created the thread
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  item_count INTEGER DEFAULT 1,
  state TEXT DEFAULT 'active'     -- 'active', 'resolved', 'stale'
);

-- tracked_items gets a thread_id foreign key
ALTER TABLE tracked_items ADD COLUMN thread_id TEXT REFERENCES threads(id);
CREATE INDEX idx_tracked_thread ON tracked_items(thread_id);
```

**Grouping heuristics (phased, CEO review + outside voice decision):**

**Phase 1 (ship with):** Same Gmail thread ID = same thread. Zero false-positive risk. Gmail provides thread IDs natively.

**Phase 6 (deferred):** Cross-source correlation:
- Calendar event with attendees matching email senders = same thread
- Discord thread mentioning email subject or contact name = LLM-assisted matching
- Manual override: user can group items via reply command

Cross-source correlation is deferred because bad grouping damages trust. Ship simple, prove value, then add complexity.

**Dashboard display:**
```
━━ ACTION REQUIRED (2 threads) ━━
1. 🔴 Acme Corp deal (3 items: email, calendar, contract)
   Latest: Legal sent contract review — needs sign-off
2. 🟡 Q2 Budget (2 items: email, calendar conflict)
   Latest: Sarah Chen waiting on your approval
```

**Resolution:** Thread resolves when all items in it are resolved. Partial resolution shows progress: "Acme Corp deal (2/3 resolved)."

### 8. Context-Aware Delivery

NanoClaw checks your calendar before pushing. During calendar events, non-ESCALATE pushes are held in a buffer. When the meeting ends (based on calendar end time), a micro-briefing is delivered.

```
📨 Meeting over (Product Sync ended)
2 things landed while you were in the meeting:
1. 🔴 Email: Legal — contract review for Acme Corp
2. 📬 3 Discord messages in #engineering
```

**Implementation:**
- Before each push, check Calendar MCP for current events
- If in a meeting: buffer the push in `tracked_items` with state `held`
- Schedule a check for calendar event end time
- On meeting end: deliver buffered items as a micro-briefing
- ESCALATE items bypass the buffer (that's the whole point of ESCALATE)

**Config addition:**
```typescript
holdPushDuringMeetings: boolean;  // Default: true
microBriefingDelay: number;       // Default: 60 (seconds after meeting ends)
```

### 9. "Handle It" Delegation Button

Push messages get a fourth button: "Handle it." When tapped, NanoClaw autonomously resolves the item.

**First-time behavior (PROPOSE tier):**
1. User taps "Handle it" on an email push
2. NanoClaw drafts a reply and sends it back in Telegram: "Here's my draft reply. Send it?"
3. User approves or edits
4. NanoClaw sends the reply via Gmail MCP
5. Trust engine records: this sender/topic was delegated and approved

**Graduated behavior (AUTO tier, after trust graduation):**
1. User taps "Handle it"
2. NanoClaw immediately handles it (sends reply, accepts invite, etc.)
3. Shows confirmation: "Done. Replied to Sarah re: budget approval."
4. No approval needed because trust engine graduated this action class

**Action types:**
| Source | "Handle it" Action |
|--------|-------------------|
| Email (needs reply) | Draft and send reply |
| Email (FYI) | Archive the email |
| Calendar conflict | Accept the higher-priority event, decline the other |
| Calendar invite | Accept or decline based on pattern |
| Discord @mention | Draft and post a reply |

**Guardrails:**
- First 10 delegations for any action class always go through PROPOSE (draft approval)
- Email replies are never sent without the user seeing the draft at least once for that sender
- Financial, legal, or HR-tagged emails are permanently ESCALATE (never auto-handle)
- All delegated actions are logged in `tracked_items` with `resolution_method = 'delegated'`

### 10. Predictive Classification (Learning Loop)

Static rules serve as defaults. After accumulating user behavior data, NanoClaw adjusts classification.

**Data collection:**
Every user action on a tracked item is recorded:
- Push → immediate action (within 5 min) = high priority signal
- Push → snooze = "not now but later" signal  
- Push → dismiss = "not important" signal
- Push → no action for 4h = low priority signal
- Digest item → user asked for details = higher priority than expected

**Learning model:**
```typescript
interface ClassificationAdjustment {
  source: string;           // 'gmail', 'discord', etc.
  sender_pattern: string;   // email domain, Discord user, etc.
  subject_pattern?: string; // keyword patterns
  original_classification: 'push' | 'digest';
  observed_behavior: 'immediate_action' | 'snooze' | 'dismiss' | 'ignore';
  count: number;            // how many times this pattern occurred
  adjustment: 'promote' | 'demote' | 'none';
  confidence: number;       // 0-1, increases with count
}
```

**Adjustment rules:**
- 3+ dismissals from same sender pattern → demote to digest
- 3+ immediate actions on digest items from same pattern → promote to push
- 5+ snoozes at same time-of-day → adjust delivery time
- Minimum 10 data points before any adjustment takes effect
- User can reset adjustments: "reset learning" command

**Storage:** New table `classification_adjustments` alongside `tracked_items`.

### 11. Weekend Mode + Quiet Hours

**Config additions:**
```typescript
quietHours: {
  enabled: boolean;           // Default: true
  start: string;              // Default: '22:00' (PT)
  end: string;                // Default: '07:00' (PT)
  weekendMode: boolean;       // Default: true (suppress Sat/Sun)
  escalateOverride: boolean;  // Default: true (ESCALATE always pushes)
};
```

During quiet hours and weekends:
- Non-ESCALATE pushes are buffered (same mechanism as context-aware delivery)
- Morning dashboard at configured time delivers everything
- ESCALATE items always push through
- "What did I miss?" works normally (on-demand, unaffected)

### 12. Thread Context in Push Messages

For emails that are part of an ongoing conversation, the push message includes the user's last reply.

**Enhanced push format:**
```
🔴 ACTION: Email from Sarah Chen
Re: Q2 Budget Approval

"Hi, the board needs sign-off by EOD Wednesday.
Can you review the attached and approve?"

📝 Your last reply (3 days ago):
"Let me check with legal and get back to you."

[✅ Approve] [❌ Dismiss] [⏰ Snooze 2h] [🤖 Handle it]
```

**Implementation:** When constructing a push for a Gmail item, query the thread via Gmail MCP for the most recent message with `from:me`. Extract first 2 lines or 140 characters. Include as a "Your last reply" section.

### 13. Snooze Intelligence

Track snooze patterns and feed them into the learning loop.

**Pattern tracking:**
- Record snooze time, snooze duration chosen, item source, sender pattern
- After 3+ snoozes of same sender/topic to same time window → suggest reclassification
- In digest: "You've snoozed vendor emails to afternoon 5 times. Want me to auto-digest them and include in the 1pm batch?"

**Integration with learning loop (Expansion #4):**
Snooze data feeds `classification_adjustments`:
- Repeated snooze to afternoon → `adjustment: 'demote'` for that sender pattern
- Repeated snooze to "2h later" → delivery time shift, not classification change

## Updated Migration Path

**Phase 1: Foundation (Item Tracking + Resolution Detection)**
- Create `tracked_items`, `threads`, `digest_state`, and `classification_adjustments` tables
- Add resolution detection to email-poll (Gmail `from:me`, `in:inbox` checks)
- Emit `item.classified` and `item.resolved` events on event bus
- Basic thread grouping (same Gmail thread ID)

**Phase 2: Morning Dashboard**
- Replace morning briefing output format with dashboard layout
- Query `tracked_items` with thread grouping for display
- Filter resolved items/threads before display
- Add quiet hours / weekend mode config

**Phase 3: Push Notifications + Context-Aware Delivery**
- **Prerequisite:** Extend Channel interface with sendMessageWithKeyboard() and onCallbackQuery()
- Add callback_query handler to TelegramChannel
- Add orchestrator-side classification overlay (trust tier + calendar check)
- Send push messages with inline buttons (approve/dismiss/snooze/handle-it)
- Handle button callbacks including delegation flow
- Calendar-aware push buffering + micro-briefing
- Thread context in push messages (last user reply)
- Push rate limiting + quiet hours / weekend mode

**Phase 4: Smart Digest + On-Demand**
- Add digest state tracking
- Implement threshold-based digest trigger
- Build digest message format with resolved/FYI/still-pending sections
- Implement "what did I miss?" as on-demand digest
- Snooze pattern tracking

**Phase 5: Learning Loop + Staleness**
- Classification adjustment storage and application
- Snooze intelligence feeding learning loop
- Stale detection (2 digest cycles, passive)
- Auto-archive stale items
- Learning system feedback (stale rates, classification accuracy)

**Phase 6: Cross-Source Thread Correlation (deferred)**
- Calendar attendee → email sender matching
- Discord thread → email subject LLM-assisted correlation
- Manual thread grouping via reply command
- Thread quality metrics (false positive rate tracking)

## Non-Goals

- **Multi-chat separation:** Decided against splitting into multiple Telegram groups. One chat, structured messages.
- **Edited dashboard messages:** Decided against maintaining a single edited "live" message. It fights Telegram's chat paradigm.
- **LLM-based classification as sole decision-maker:** Static rules remain the starting point. The learning loop adjusts classification from user behavior, not from LLM re-evaluation of content.
- **Notification sounds/priority:** Telegram doesn't offer per-message notification customization via bot API. All messages use default notification.
- **Cross-device sync:** Resolution detection handles this implicitly (if you replied on phone, NanoClaw detects it via Gmail API regardless of device).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | 7 proposals, 7 accepted, 0 deferred |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 12 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**UNRESOLVED:** 0 decisions pending
**VERDICT:** CEO + ENG CLEARED. Ready to implement.

### Eng Review Decisions (2026-04-14)

- ARCH-1: `tracked_items` replaces `processed_items` (gradual migration with rollback)
- ARCH-2: IPC watcher instead of 15s polling (sub-second event detection)
- ARCH-3: Abstract `sendMessageWithActions(jid, text, actions: Action[])` instead of Telegram-specific InlineKeyboard
- ARCH-4: New `src/classification.ts` module owns classify() function
- ARCH-5: Morning dashboard moves to orchestrator (not container SKILL.md edit). Email-poll SKILL.md simplified to raw data writer.
- ARCH-6: Migrate all Telegram messages to HTML parse_mode
- QUAL-1: Unified PushBuffer for meeting/quiet/weekend/rate-limit hold conditions
- QUAL-2: State machine transition validator (transitionState() throws on invalid transitions)
- QUAL-3: Add 'held' state to state machine for meeting buffer
- QUAL-4: Typed ClassificationReason interface (JSON only at DB boundary)
- PERF-1: Composite index `idx_tracked_dashboard(group_name, state, thread_id)`
- TEST-1: Regression test for "what did I miss?" rewrite (migrate trust-commands.test.ts assertions)
- TENSION-1: Container writes raw SuperPilot labels, orchestrator owns all classification
- TENSION-2: Morning dashboard generated by orchestrator's digest-engine.ts (container skill deprecated)
- TENSION-3: Phase 0 quick fix (SQL filter + dismiss command) ships before full spec
- TENSION-4: daily-digest.ts deprecated, replaced by digest-engine.ts
- TENSION-5: Gradual migration from processed_items to tracked_items with rollback
