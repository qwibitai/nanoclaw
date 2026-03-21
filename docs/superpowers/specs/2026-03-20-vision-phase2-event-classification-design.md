# Phase 2: Event-Driven Classification Layer

## Goal

Replace NanoClaw's 8-hour polling cron with event-driven perception. Raw events (emails, calendar changes) flow through a local Ollama classification tier before reaching Claude. Ollama handles 80% of volume (routine classification, extraction). Claude handles 20% (judgment, synthesis). Target: reduce daily Claude token usage from ~450K to ~60-100K while increasing responsiveness from hours to seconds.

## Architecture

```
Raw Events
  ├── Gmail Watcher (push via Google Pub/Sub, polling fallback)
  ├── Calendar Watcher (icalbuddy polling, 60s interval)
  └── (future: bioRxiv RSS, Slack Socket Mode)
       ↓
Event Router (src/event-router.ts, host-side, in-process)
  ├── Call Ollama /api/generate with event-type classification prompt
  ├── Parse structured JSON response (importance, urgency, topic, routing)
  ├── Apply trust matrix (data/trust.yaml)
  └── Route to one of:
       ├── Autonomous: execute via script/tool, log only
       ├── Draft: create draft, notify user for approval
       ├── Notify: publish to bus, include in next context packet
       └── Escalate: trigger Claude session immediately
            ↓
Message Bus (data/bus/) ← Phase 1
            ↓
Context Assembler ← Phase 1 (injects classified events into next Claude session)
```

All components run within the existing NanoClaw Node.js process. No new services or daemons.

## Components

### 1. Event Router (`src/event-router.ts`)

The central routing module. Receives raw events from watchers, classifies via Ollama, applies trust rules, routes to the appropriate destination.

**Interface:**

```typescript
interface RawEvent {
  type: 'email' | 'calendar' | 'paper' | 'message';
  source: string;           // e.g., 'gmail:mgandal@gmail.com'
  payload: Record<string, unknown>;
  receivedAt: string;        // ISO timestamp
}

interface ClassifiedEvent extends RawEvent {
  classification: {
    importance: number;      // 0-1
    urgency: 'low' | 'medium' | 'high' | 'critical';
    topic: string;           // extracted topic
    summary: string;         // 1-2 sentence summary
    suggestedRouting: string; // group folder or 'user'
    requiresClaude: boolean;  // true if Ollama can't handle alone
    confidence: number;      // 0-1 classification confidence
  };
  routing: 'autonomous' | 'draft' | 'notify' | 'escalate';
  trustRule?: string;        // which trust rule matched
}

class EventRouter {
  constructor(config: {
    ollamaHost: string;
    ollamaModel: string;
    trustMatrixPath: string;
    messageBus: MessageBus;
    healthMonitor: HealthMonitor;
    onEscalate: (event: ClassifiedEvent) => Promise<void>;
  });

  route(event: RawEvent): Promise<ClassifiedEvent>;
  getStats(): { processed: number; byRouting: Record<string, number>; avgLatencyMs: number };
}
```

**Ollama Classification:**

- Model: `qwen3:8b` (already running for SimpleMem/QMD embeddings)
- Endpoint: `http://localhost:11434/api/generate` (host-side, not container)
- Non-streaming (`stream: false`)
- System prompt instructs JSON output with specific fields
- Per-event-type prompts in `src/classification-prompts.ts`
- Timeout: 30 seconds per classification (fallback: route as 'notify' with low confidence)

**Trust Matrix Application:**

After Ollama classifies, the router checks `data/trust.yaml`:
- If classification confidence × importance meets the threshold → autonomous
- If below threshold but routine → draft
- If novel/ambiguous → notify (include in context packet for next Claude session)
- If critical urgency → escalate (trigger Claude session immediately)

**Health Monitor Integration:**

- Records Ollama latency per classification
- If Ollama response time exceeds 10 seconds consistently, degrades to 'notify' routing (skip classification, queue everything for Claude)
- Records event throughput per watcher

### 2. Trust Matrix (`data/trust.yaml`)

Static YAML config (not LLM-generated). Defines autonomy boundaries per action type and context.

```yaml
# Default: notify (include in context packet, let Claude decide)
default_routing: notify

rules:
  # Email classification routing
  - event_type: email
    conditions:
      sender_domain: ["ucla.edu", "nih.gov", "sfari.org"]
      importance_gte: 0.7
    routing: notify
    reason: "Important institutional email — always surface"

  - event_type: email
    conditions:
      importance_lt: 0.3
      sender_domain_not: ["ucla.edu", "nih.gov"]
    routing: autonomous
    action: log_only
    reason: "Low-importance external email — log, don't surface"

  # Calendar routing
  - event_type: calendar
    conditions:
      change_type: conflict
    routing: escalate
    reason: "Calendar conflicts need judgment"

  - event_type: calendar
    conditions:
      change_type: new_event
      importance_lt: 0.5
    routing: notify
    reason: "New calendar events — surface in next session"
```

Rules are evaluated top-to-bottom, first match wins. The `default_routing` catches anything unmatched.

### 3. Classification Prompts (`src/classification-prompts.ts`)

Template strings with event-type-specific instructions for Ollama. Each returns a system prompt and formats the event payload into a user prompt.

```typescript
export function getEmailClassificationPrompt(email: EmailPayload): {
  system: string;
  prompt: string;
};

export function getCalendarClassificationPrompt(calendarEvent: CalendarPayload): {
  system: string;
  prompt: string;
};
```

**Email classification prompt instructs Ollama to return:**
```json
{
  "importance": 0.85,
  "urgency": "medium",
  "topic": "R01 resubmission timeline",
  "summary": "NIH program officer responds about resubmission deadline...",
  "suggestedRouting": "main",
  "requiresClaude": true,
  "confidence": 0.92
}
```

Prompts are designed for qwen3:8b's capabilities — explicit JSON schema, few-shot examples, clear field definitions. No complex reasoning expected.

### 4. Gmail Watcher (`src/watchers/gmail-watcher.ts`)

Watches for new emails and feeds them to the event router.

**Primary mode: Google Cloud Pub/Sub push notifications**

Gmail API supports push notifications via Pub/Sub. When a new email arrives, Google sends a notification to a configured endpoint. Since NanoClaw runs locally (no public URL), we use a pull subscription instead:

1. Set up a Pub/Sub topic and pull subscription in GCP
2. Call `gmail.users.watch()` to register the subscription
3. Poll the Pub/Sub pull subscription every 10 seconds for notifications
4. On notification: fetch the new message via Gmail API, send to event router

**Fallback mode: Gmail API polling**

If Pub/Sub isn't configured, fall back to polling Gmail API directly:
- Poll every 60 seconds using `messages.list` with `after:` query
- Track last-seen message ID to avoid reprocessing
- State persisted in `data/watchers/gmail-state.json`

**Auth:** Reuse existing OAuth credentials from `~/.gmail-mcp/credentials.json` (mgandal@gmail.com). The `google-auth-library` npm package handles token refresh.

**Interface:**
```typescript
class GmailWatcher {
  constructor(config: {
    credentialsPath: string;
    account: string;
    eventRouter: EventRouter;
    pollIntervalMs: number;     // default 60000
    pubsubSubscription?: string; // GCP subscription name (optional)
  });

  start(): Promise<void>;
  stop(): void;
  getStatus(): { mode: 'pubsub' | 'polling'; lastCheck: string; messagesProcessed: number };
}
```

**Email payload passed to router:**
```typescript
interface EmailPayload {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  snippet: string;       // first ~200 chars
  date: string;
  labels: string[];
  hasAttachments: boolean;
}
```

Only metadata + snippet are sent to Ollama for classification. Full body is NOT fetched unless Claude needs it (fetched on-demand during escalation).

### 5. Calendar Watcher (`src/watchers/calendar-watcher.ts`)

Watches for calendar changes and feeds them to the event router.

**Mode: icalbuddy polling (60-second interval)**

EventKit callbacks would require a native macOS bridge (Swift/ObjC). For Phase 2, we use icalbuddy polling which is simpler and sufficient for calendar events (they change infrequently). EventKit can be added in a future phase if needed.

1. Run `icalbuddy` every 60 seconds to get events for the next 7 days
2. Diff against previous snapshot to detect: new events, modified events, deleted events, conflicts
3. On change: send to event router with change type

**Interface:**
```typescript
class CalendarWatcher {
  constructor(config: {
    calendars: string[];        // e.g., ['MJG', 'Outlook', 'Gandal_Lab_Meetings']
    eventRouter: EventRouter;
    pollIntervalMs: number;     // default 60000
    lookAheadDays: number;      // default 7
  });

  start(): Promise<void>;
  stop(): void;
  getStatus(): { lastCheck: string; eventsTracked: number; changesDetected: number };
}
```

**Calendar payload passed to router:**
```typescript
interface CalendarPayload {
  changeType: 'new_event' | 'modified' | 'deleted' | 'conflict';
  event: {
    title: string;
    start: string;
    end: string;
    location?: string;
    calendar: string;
    attendees?: string[];
  };
  conflictsWith?: {
    title: string;
    start: string;
    end: string;
  };
}
```

**icalbuddy invocation:**
```bash
/opt/homebrew/bin/icalbuddy -ic "MJG,Outlook,Gandal_Lab_Meetings" \
  -df "%Y-%m-%d" -tf "%H:%M" -b "" -nc -nrd \
  eventsFrom:today to:"+7d"
```

Output is parsed line-by-line. Previous snapshot stored in `data/watchers/calendar-snapshot.json`.

### 6. Structured Agent Outputs

Formalize how agents publish to the message bus. This is mostly a convention + types, not new code.

**Extended BusMessage fields:**

```typescript
interface StructuredFinding extends BusMessage {
  // Existing fields: id, from, topic, action_needed, priority, finding, timestamp

  // New structured fields (optional, for typed findings)
  payload?: {
    type: 'email_summary' | 'calendar_update' | 'research_finding' | 'task_status';

    // Email summaries (from Ollama classification)
    emailId?: string;
    senderImportance?: number;
    requiresResponse?: boolean;

    // Research findings
    paperId?: string;
    relevanceScore?: number;
    relatedGrants?: string[];

    // Calendar updates
    changeType?: string;
    conflictDetected?: boolean;
  };
}
```

Agents are not required to use the `payload` field — plain `finding` strings continue to work. The typed payload enables the context assembler to format classified events more densely in the context packet.

### 7. Context Assembler Extensions

Extend `assembleContextPacket()` to include classified events from the router's output:

```typescript
// New section in assembleContextPacket():
// 7. Classified events (last 24h)
const classifiedEvents = readClassifiedEvents(groupFolder); // from bus or dedicated store
if (classifiedEvents.length > 0) {
  const formatted = classifiedEvents
    .map(e => `[${e.classification.urgency}] ${e.classification.summary} (from: ${e.source})`)
    .join('\n');
  sections.push(`\n--- Recent Events (classified) ---\n${formatted}`);
}
```

This replaces the current pattern where agents spend their first 10-30 seconds querying SimpleMem and QMD for context. The context packet now includes pre-digested event summaries.

### 8. Health Monitor Extensions

Add Ollama-specific metrics to the existing HealthMonitor:

```typescript
// New methods on HealthMonitor:
recordOllamaLatency(latencyMs: number): void;
getOllamaP95Latency(windowMs: number): number;
isOllamaDegraded(): boolean; // true if p95 > 10s
```

When `isOllamaDegraded()` returns true, the event router skips Ollama classification and routes everything as 'notify' (fallback to Claude batch processing). This prevents slow Ollama from blocking the event pipeline.

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/event-router.ts` | Central event classification and routing |
| `src/event-router.test.ts` | Tests for event router |
| `src/classification-prompts.ts` | Ollama prompt templates per event type |
| `src/classification-prompts.test.ts` | Tests for prompt generation |
| `src/watchers/gmail-watcher.ts` | Gmail push/poll watcher |
| `src/watchers/gmail-watcher.test.ts` | Tests for Gmail watcher |
| `src/watchers/calendar-watcher.ts` | Calendar icalbuddy polling watcher |
| `src/watchers/calendar-watcher.test.ts` | Tests for calendar watcher |
| `data/trust.yaml` | Trust matrix configuration |

### Modified Files

| File | Changes |
|------|---------|
| `src/index.ts` | Initialize event router, watchers; wire into main loop |
| `src/config.ts` | Add watcher config constants (poll intervals, Ollama settings) |
| `src/context-assembler.ts` | Add classified events section |
| `src/health-monitor.ts` | Add Ollama latency tracking |
| `src/message-bus.ts` | No changes (existing interface sufficient) |
| `package.json` | Add `google-auth-library`, `googleapis` dependencies |

## Dependencies

### NPM packages (new)

- `google-auth-library` — OAuth2 token refresh for Gmail API
- `googleapis` — Gmail API client (used by gmail-watcher)
- `js-yaml` — Parse trust.yaml

### External services

- **Ollama** — already running locally on port 11434
- **Google Cloud Pub/Sub** — optional, for Gmail push notifications (requires GCP project setup)
- **icalbuddy** — already installed at `/opt/homebrew/bin/icalbuddy`

## Error Handling

- **Ollama timeout (>30s):** Route event as 'notify' with `confidence: 0`, include raw payload. Log warning.
- **Ollama not running:** All events route as 'notify'. Health monitor records errors. Alert sent via Telegram.
- **Gmail API auth failure:** Log error, retry with exponential backoff (max 5 retries). After 5 failures, stop watcher, alert via Telegram.
- **icalbuddy not found:** Skip calendar watcher entirely, log warning at startup.
- **Malformed Ollama response:** Parse what we can, fill missing fields with defaults (importance: 0.5, urgency: 'medium', routing: 'notify').
- **Trust matrix parse error:** Fall back to `default_routing: notify` for all events.

## Testing Strategy

- **Event router:** Mock Ollama HTTP responses, verify correct routing for each trust rule. Test fallback when Ollama is slow/down.
- **Classification prompts:** Verify prompt generation produces valid strings. No need to test Ollama's actual classification quality (that's prompt engineering, not unit testing).
- **Gmail watcher:** Mock Gmail API responses, verify message parsing and state tracking. Test polling fallback mode.
- **Calendar watcher:** Mock icalbuddy output, verify diff detection (new, modified, deleted, conflict). Test snapshot persistence.
- **Integration:** Verify end-to-end flow from raw event → classified event on message bus → context packet inclusion.

## Known Limitations (Acceptable for Phase 2)

1. **No real-time email push without GCP setup.** Gmail Pub/Sub requires a GCP project with Pub/Sub API enabled. Polling fallback (60s) is acceptable for most use cases. Push can be configured later without code changes.

2. **Calendar polling, not push.** EventKit callbacks would give instant detection but require a Swift bridge binary. icalbuddy polling at 60s is sufficient — calendar events rarely change more than a few times per hour.

3. **Single Ollama model for all event types.** qwen3:8b handles email and calendar classification. If classification quality is poor for a specific event type, a specialized model can be swapped per-prompt in a future iteration.

4. **Trust matrix is static YAML.** No automatic promotion based on approval rates (that's Phase 3). Manual editing of trust.yaml is required to change autonomy levels.

5. **No full email body to Ollama.** Only metadata + snippet (200 chars) are classified. This is intentional — keeps Ollama fast and avoids sending sensitive content through local inference. Full body is fetched on-demand when Claude handles the event.

## Phase 3 Preview

Phase 3 builds on this event-driven foundation:
1. **Trust/autonomy framework** — automatic promotion based on approval tracking (SQLite table logging trust decisions, weekly analysis)
2. **Knowledge graph (Layer 5)** — entities, relationships, and temporal context from classified events build a structured knowledge layer
3. **Proactive scheduling** — agents notice scheduling gaps and propose actions without being asked
