# Phase 2: Event-Driven Classification Layer

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 8-hour polling with event-driven perception. Raw events (emails, calendar changes) flow through local Ollama classification before reaching Claude. Reduces daily token usage from ~450K to ~60-100K while improving responsiveness from hours to seconds.

**Architecture:** Extend NanoClaw's existing Node.js process with an event router module that receives events from watchers, classifies via Ollama HTTP API, applies a YAML trust matrix, and routes classified events to the message bus. Gmail and calendar watchers feed raw events into the router. The Phase 1 context assembler injects classified events into Claude sessions.

**Tech Stack:** TypeScript (Node.js), Ollama HTTP API (qwen3:8b), Gmail API (googleapis), icalbuddy (macOS, invoked via `execFileSync` — no shell), js-yaml for trust matrix, vitest for tests.

**Spec:** `docs/superpowers/specs/2026-03-20-vision-phase2-event-classification-design.md`

**Security note:** The calendar watcher invokes icalbuddy via `execFileSync` (not `exec` or `execSync`) to avoid shell injection. Arguments are passed as an array, not interpolated into a shell command string.

**Key codebase facts (verified against actual files):**
- `src/config.ts`: Last constant at line 110 (`MAX_ERRORS_PER_HOUR`). Uses `HOME_DIR` (line 25) for home directory paths.
- `src/health-monitor.ts`: Class at line 37, private fields lines 38-42, last method `getStatus()` at line 143, closing brace line 159
- `src/context-assembler.ts`: Import block lines 12-20, bus queue section starts line 93, `assembleContextPacket` uses `CONTEXT_PACKET_MAX_SIZE`, `DATA_DIR`, `GROUPS_DIR`, `TIMEZONE` from config
- `src/index.ts`: `main()` at line 723, healthMonitor init line 732, messageBus init line 754, startSchedulerLoop at line 882, shutdown handler lines 763-771
- `src/message-bus.ts`: `BusMessage` interface lines 25-34 (has `[key: string]: unknown` index signature)
- Ollama API pattern in `container/agent-runner/src/ollama-mcp-stdio.ts`: `POST /api/generate` with `{model, prompt, stream: false, system?}`, response `{response, total_duration?, eval_count?}`
- `package.json`: `yaml` v2.8.2 already installed. `googleapis` and `google-auth-library` NOT installed.
- `src/watchers/` directory does NOT exist (must create)
- `data/trust.yaml` does NOT exist (must create)
- ESM project: all imports use `import`, no `require()`. Tests use vitest with `vi.mock()` and `vi.mocked()`.
- `data/` directory is gitignored (trust.yaml is runtime config, not checked in — provide a `data/trust.yaml.example` instead)

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/classification-prompts.ts` | Ollama prompt templates per event type (email, calendar) |
| `src/classification-prompts.test.ts` | Tests for prompt generation |
| `src/event-router.ts` | Central event classification and routing via Ollama + trust matrix |
| `src/event-router.test.ts` | Tests for event router |
| `src/watchers/gmail-watcher.ts` | Gmail API polling watcher |
| `src/watchers/gmail-watcher.test.ts` | Tests for Gmail watcher |
| `src/watchers/calendar-watcher.ts` | Calendar icalbuddy polling watcher |
| `src/watchers/calendar-watcher.test.ts` | Tests for calendar watcher |
| `data/trust.yaml.example` | Example trust matrix (checked into git) |

### Modified Files

| File | Changes |
|------|---------|
| `src/config.ts` | Add Ollama, watcher, and trust matrix config constants |
| `src/health-monitor.ts` | Add Ollama latency tracking methods |
| `src/health-monitor.test.ts` | Add tests for Ollama latency methods |
| `src/context-assembler.ts` | Add classified events section to context packet |
| `src/index.ts` | Initialize event router and watchers in `main()` |
| `package.json` | Add `googleapis`, `google-auth-library` dependencies |

---

## Task 1: Config Constants and Dependencies

Add configuration constants and install npm packages. **This must be done first** because other tasks import from config.

**Files:**
- Modify: `src/config.ts` (add constants after line 110)
- Modify: `package.json` (add dependencies)

### Step 1.1: Add config constants

- [ ] **Add to end of `src/config.ts`:**

```typescript
// Ollama classification
export const OLLAMA_HOST =
  process.env.OLLAMA_HOST || 'http://localhost:11434';
export const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL || 'qwen3:8b';
export const OLLAMA_TIMEOUT = parseInt(
  process.env.OLLAMA_TIMEOUT || '30000',
  10,
);

// Event router
export const EVENT_ROUTER_ENABLED =
  (process.env.EVENT_ROUTER_ENABLED || 'true') === 'true';

// Gmail watcher
export const GMAIL_POLL_INTERVAL = parseInt(
  process.env.GMAIL_POLL_INTERVAL || '60000',
  10,
);
export const GMAIL_CREDENTIALS_PATH =
  process.env.GMAIL_CREDENTIALS_PATH ||
  path.join(HOME_DIR, '.gmail-mcp', 'credentials.json');
export const GMAIL_ACCOUNT =
  process.env.GMAIL_ACCOUNT || 'mgandal@gmail.com';

// Calendar watcher
export const CALENDAR_POLL_INTERVAL = parseInt(
  process.env.CALENDAR_POLL_INTERVAL || '60000',
  10,
);
export const CALENDAR_NAMES = (
  process.env.CALENDAR_NAMES || 'MJG,Outlook,Gandal_Lab_Meetings'
)
  .split(',')
  .map((s) => s.trim());
export const CALENDAR_LOOKAHEAD_DAYS = parseInt(
  process.env.CALENDAR_LOOKAHEAD_DAYS || '7',
  10,
);

// Trust matrix
export const TRUST_MATRIX_PATH = path.join(DATA_DIR, 'trust.yaml');
```

Note: `HOME_DIR` is already defined at line 25 of config.ts. `DATA_DIR` is at line 42.

- [ ] **Verify it compiles:** `npm run build`
- [ ] **Commit:** `feat: add Phase 2 config constants (Ollama, watchers, trust)`

### Step 1.2: Install dependencies

- [ ] **Install new packages:**

```bash
npm install googleapis google-auth-library
```

- [ ] **Commit:** `chore: add googleapis and google-auth-library dependencies`

---

## Task 2: Classification Prompts

Ollama prompt templates per event type. Pure functions, no side effects, easy to test.

**Files:**
- Create: `src/classification-prompts.ts`
- Create: `src/classification-prompts.test.ts`

### Step 2.1: Write failing tests

- [ ] **Create `src/classification-prompts.test.ts`:**

```typescript
import { describe, it, expect } from 'vitest';
import {
  getEmailClassificationPrompt,
  getCalendarClassificationPrompt,
  EmailPayload,
  CalendarPayload,
} from './classification-prompts.js';

describe('getEmailClassificationPrompt', () => {
  const email: EmailPayload = {
    messageId: 'msg_123',
    threadId: 'thread_456',
    from: 'alice@nih.gov',
    to: ['mgandal@gmail.com'],
    cc: [],
    subject: 'R01 resubmission timeline',
    snippet: 'Dear Dr. Gandal, I wanted to follow up on the resubmission deadline...',
    date: '2026-03-20T10:00:00Z',
    labels: ['INBOX', 'UNREAD'],
    hasAttachments: false,
  };

  it('returns system and prompt strings', () => {
    const result = getEmailClassificationPrompt(email);
    expect(result.system).toContain('JSON');
    expect(result.prompt).toContain('alice@nih.gov');
    expect(result.prompt).toContain('R01 resubmission');
  });

  it('system prompt specifies required JSON fields', () => {
    const result = getEmailClassificationPrompt(email);
    expect(result.system).toContain('importance');
    expect(result.system).toContain('urgency');
    expect(result.system).toContain('summary');
    expect(result.system).toContain('requiresClaude');
  });

  it('includes sender domain for routing hints', () => {
    const result = getEmailClassificationPrompt(email);
    expect(result.prompt).toContain('nih.gov');
  });
});

describe('getCalendarClassificationPrompt', () => {
  const calendarEvent: CalendarPayload = {
    changeType: 'conflict',
    event: {
      title: 'Lab Meeting',
      start: '2026-03-21T14:00:00',
      end: '2026-03-21T15:00:00',
      calendar: 'Gandal_Lab_Meetings',
    },
    conflictsWith: {
      title: 'NIH Study Section Call',
      start: '2026-03-21T14:30:00',
      end: '2026-03-21T15:30:00',
    },
  };

  it('returns system and prompt strings', () => {
    const result = getCalendarClassificationPrompt(calendarEvent);
    expect(result.system).toContain('JSON');
    expect(result.prompt).toContain('Lab Meeting');
  });

  it('includes conflict details when present', () => {
    const result = getCalendarClassificationPrompt(calendarEvent);
    expect(result.prompt).toContain('conflict');
    expect(result.prompt).toContain('NIH Study Section Call');
  });

  it('handles new event without conflict', () => {
    const newEvent: CalendarPayload = {
      changeType: 'new_event',
      event: {
        title: 'Seminar',
        start: '2026-03-22T10:00:00',
        end: '2026-03-22T11:00:00',
        calendar: 'MJG',
      },
    };
    const result = getCalendarClassificationPrompt(newEvent);
    expect(result.prompt).toContain('new_event');
    expect(result.prompt).not.toContain('conflict');
  });
});
```

- [ ] **Run to verify failure:** `npx vitest run src/classification-prompts.test.ts`
- [ ] **Commit:** `test: add classification prompt tests`

### Step 2.2: Implement classification prompts

- [ ] **Create `src/classification-prompts.ts`:**

```typescript
/**
 * Ollama classification prompt templates for NanoClaw event router.
 * Each function returns a system prompt and formatted user prompt
 * for a specific event type. Designed for qwen3:8b.
 */

export interface EmailPayload {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
  hasAttachments: boolean;
}

export interface CalendarPayload {
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

const EMAIL_SYSTEM_PROMPT = `You are an email classifier for an academic researcher (neuroscience, genetics, psychiatry). Analyze the email metadata and return a JSON object with these exact fields:

{
  "importance": <number 0-1>,
  "urgency": "<low|medium|high|critical>",
  "topic": "<brief topic>",
  "summary": "<1-2 sentence summary>",
  "suggestedRouting": "<main|user>",
  "requiresClaude": <true|false>,
  "confidence": <number 0-1>
}

Guidelines:
- importance: 0.9+ for NIH, funding agencies, department chairs, direct collaborators. 0.5-0.8 for known colleagues. 0.1-0.4 for newsletters, automated, unknown senders.
- urgency: "critical" only for deadlines within 48h or urgent requests from important senders.
- requiresClaude: true if the email needs a composed response, judgment call, or scheduling decision. false if it's informational only.
- Respond ONLY with the JSON object, no other text.`;

const CALENDAR_SYSTEM_PROMPT = `You are a calendar event classifier for an academic researcher. Analyze the calendar change and return a JSON object with these exact fields:

{
  "importance": <number 0-1>,
  "urgency": "<low|medium|high|critical>",
  "topic": "<brief description of the change>",
  "summary": "<1-2 sentence summary of what changed and implications>",
  "suggestedRouting": "<main|user>",
  "requiresClaude": <true|false>,
  "confidence": <number 0-1>
}

Guidelines:
- Conflicts are always high urgency and require Claude.
- New routine meetings are low importance unless they involve external collaborators or funding agencies.
- Deleted events may need follow-up if they were shared meetings.
- Respond ONLY with the JSON object, no other text.`;

export function getEmailClassificationPrompt(email: EmailPayload): {
  system: string;
  prompt: string;
} {
  const senderDomain = email.from.split('@')[1] || 'unknown';
  const prompt = `Classify this email:

From: ${email.from} (domain: ${senderDomain})
To: ${email.to.join(', ')}${email.cc.length > 0 ? `\nCC: ${email.cc.join(', ')}` : ''}
Subject: ${email.subject}
Date: ${email.date}
Labels: ${email.labels.join(', ')}
Has Attachments: ${email.hasAttachments}
Preview: ${email.snippet}`;

  return { system: EMAIL_SYSTEM_PROMPT, prompt };
}

export function getCalendarClassificationPrompt(calendarEvent: CalendarPayload): {
  system: string;
  prompt: string;
} {
  let prompt = `Classify this calendar change:

Change Type: ${calendarEvent.changeType}
Event: ${calendarEvent.event.title}
Calendar: ${calendarEvent.event.calendar}
Start: ${calendarEvent.event.start}
End: ${calendarEvent.event.end}`;

  if (calendarEvent.event.location) {
    prompt += `\nLocation: ${calendarEvent.event.location}`;
  }
  if (calendarEvent.event.attendees?.length) {
    prompt += `\nAttendees: ${calendarEvent.event.attendees.join(', ')}`;
  }
  if (calendarEvent.conflictsWith) {
    prompt += `\n\nCONFLICT DETECTED with:
Event: ${calendarEvent.conflictsWith.title}
Start: ${calendarEvent.conflictsWith.start}
End: ${calendarEvent.conflictsWith.end}`;
  }

  return { system: CALENDAR_SYSTEM_PROMPT, prompt };
}
```

- [ ] **Run tests:** `npx vitest run src/classification-prompts.test.ts` — all pass
- [ ] **Commit:** `feat: implement Ollama classification prompts for email and calendar`

---

## Task 3: Health Monitor Ollama Extensions

Add Ollama latency tracking to the existing HealthMonitor class.

**Files:**
- Modify: `src/health-monitor.ts` (add methods and private field)
- Modify: `src/health-monitor.test.ts` (add tests)

### Step 3.1: Write failing tests

- [ ] **Add to `src/health-monitor.test.ts` (after the existing describe block's closing `});`):**

```typescript
describe('HealthMonitor Ollama tracking', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 30,
      maxErrorsPerHour: 20,
      onAlert: vi.fn(),
    });
  });

  it('records Ollama latency', () => {
    monitor.recordOllamaLatency(500);
    monitor.recordOllamaLatency(1000);
    expect(monitor.getOllamaP95Latency(3600_000)).toBeGreaterThan(0);
  });

  it('reports not degraded when latency is low', () => {
    for (let i = 0; i < 10; i++) {
      monitor.recordOllamaLatency(200);
    }
    expect(monitor.isOllamaDegraded()).toBe(false);
  });

  it('reports degraded when p95 exceeds threshold', () => {
    // 19 fast + 1 slow = p95 should be the slow one
    for (let i = 0; i < 19; i++) {
      monitor.recordOllamaLatency(100);
    }
    monitor.recordOllamaLatency(15000);
    expect(monitor.isOllamaDegraded()).toBe(true);
  });

  it('only considers latency within time window', () => {
    // Inject old latency event directly
    monitor['ollamaLatencyLog'].push({
      latencyMs: 15000,
      timestamp: Date.now() - 7200_000,
    });
    for (let i = 0; i < 10; i++) {
      monitor.recordOllamaLatency(100);
    }
    expect(monitor.isOllamaDegraded()).toBe(false);
  });
});
```

- [ ] **Run to verify failure:** `npx vitest run src/health-monitor.test.ts`
- [ ] **Commit:** `test: add Ollama latency tracking tests`

### Step 3.2: Implement Ollama latency methods

- [ ] **Add private field to `src/health-monitor.ts` after line 42 (after `recentAlerts`):**

```typescript
  private ollamaLatencyLog: Array<{ latencyMs: number; timestamp: number }> = [];
```

- [ ] **Add three methods before `getStatus()` (before line 143):**

```typescript
  recordOllamaLatency(latencyMs: number): void {
    this.ollamaLatencyLog.push({ latencyMs, timestamp: Date.now() });
    // Prune entries older than 2 hours
    const cutoff = Date.now() - 2 * 3600_000;
    this.ollamaLatencyLog = this.ollamaLatencyLog.filter(
      (e) => e.timestamp > cutoff,
    );
  }

  getOllamaP95Latency(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    const recent = this.ollamaLatencyLog
      .filter((e) => e.timestamp > cutoff)
      .map((e) => e.latencyMs)
      .sort((a, b) => a - b);
    if (recent.length === 0) return 0;
    const idx = Math.floor(recent.length * 0.95);
    return recent[Math.min(idx, recent.length - 1)];
  }

  isOllamaDegraded(): boolean {
    return this.getOllamaP95Latency(3600_000) > 10_000;
  }
```

- [ ] **Run tests:** `npx vitest run src/health-monitor.test.ts` — all pass (existing + new)
- [ ] **Build:** `npm run build`
- [ ] **Commit:** `feat: add Ollama latency tracking to health monitor`

---

## Task 4: Event Router

Central module: receives raw events, classifies via Ollama, applies trust matrix, routes to message bus.

**Files:**
- Create: `src/event-router.ts`
- Create: `src/event-router.test.ts`
- Create: `data/trust.yaml.example`

### Step 4.1: Create trust matrix example

- [ ] **Create `data/trust.yaml.example`:**

```yaml
# NanoClaw Event Router Trust Matrix
# Rules evaluated top-to-bottom, first match wins.
# default_routing applies when no rule matches.

default_routing: notify

rules:
  # High-importance institutional email — always surface to user
  - event_type: email
    conditions:
      sender_domain:
        - ucla.edu
        - nih.gov
        - sfari.org
      importance_gte: 0.7
    routing: notify

  # Low-importance external email — log only
  - event_type: email
    conditions:
      importance_lt: 0.3
    routing: autonomous
    action: log_only

  # Calendar conflicts always need judgment
  - event_type: calendar
    conditions:
      change_type: conflict
    routing: escalate

  # New calendar events — surface in next session
  - event_type: calendar
    conditions:
      change_type: new_event
    routing: notify

  # Default for all other calendar changes
  - event_type: calendar
    routing: notify
```

- [ ] **Commit:** `docs: add trust matrix example`

### Step 4.2: Write failing tests

- [ ] **Create `src/event-router.test.ts`:**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventRouter, RawEvent, ClassifiedEvent } from './event-router.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ollamaResponse(data: Record<string, unknown>) {
  return {
    ok: true,
    json: () => Promise.resolve({
      response: JSON.stringify(data),
      total_duration: 500_000_000, // 500ms in nanoseconds
    }),
  };
}

describe('EventRouter', () => {
  let router: EventRouter;
  let mockBus: { publish: ReturnType<typeof vi.fn> };
  let mockHealthMonitor: {
    recordOllamaLatency: ReturnType<typeof vi.fn>;
    isOllamaDegraded: ReturnType<typeof vi.fn>;
  };
  let onEscalate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBus = { publish: vi.fn() };
    mockHealthMonitor = {
      recordOllamaLatency: vi.fn(),
      isOllamaDegraded: vi.fn(() => false),
    };
    onEscalate = vi.fn();

    router = new EventRouter({
      ollamaHost: 'http://localhost:11434',
      ollamaModel: 'qwen3:8b',
      trustRules: {
        default_routing: 'notify',
        rules: [],
      },
      messageBus: mockBus as any,
      healthMonitor: mockHealthMonitor as any,
      onEscalate,
    });
  });

  it('classifies an event via Ollama and publishes to bus', async () => {
    mockFetch.mockResolvedValueOnce(ollamaResponse({
      importance: 0.8,
      urgency: 'medium',
      topic: 'grant deadline',
      summary: 'NIH grant deadline approaching',
      suggestedRouting: 'main',
      requiresClaude: true,
      confidence: 0.9,
    }));

    const event: RawEvent = {
      type: 'email',
      source: 'gmail:mgandal@gmail.com',
      payload: { from: 'alice@nih.gov', subject: 'R01 deadline' },
      receivedAt: new Date().toISOString(),
    };

    const result = await router.route(event);
    expect(result.classification.importance).toBe(0.8);
    expect(result.routing).toBe('notify');
    expect(mockBus.publish).toHaveBeenCalled();
    expect(mockHealthMonitor.recordOllamaLatency).toHaveBeenCalled();
  });

  it('falls back to notify when Ollama times out', async () => {
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    const event: RawEvent = {
      type: 'email',
      source: 'gmail:mgandal@gmail.com',
      payload: { from: 'unknown@example.com', subject: 'test' },
      receivedAt: new Date().toISOString(),
    };

    const result = await router.route(event);
    expect(result.routing).toBe('notify');
    expect(result.classification.confidence).toBe(0);
  });

  it('skips Ollama when degraded', async () => {
    mockHealthMonitor.isOllamaDegraded.mockReturnValue(true);

    const event: RawEvent = {
      type: 'email',
      source: 'gmail:mgandal@gmail.com',
      payload: { from: 'test@example.com', subject: 'test' },
      receivedAt: new Date().toISOString(),
    };

    const result = await router.route(event);
    expect(result.routing).toBe('notify');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('applies trust rules for routing', async () => {
    const routerWithRules = new EventRouter({
      ollamaHost: 'http://localhost:11434',
      ollamaModel: 'qwen3:8b',
      trustRules: {
        default_routing: 'notify',
        rules: [
          {
            event_type: 'email',
            conditions: { importance_lt: 0.3 },
            routing: 'autonomous',
          },
        ],
      },
      messageBus: mockBus as any,
      healthMonitor: mockHealthMonitor as any,
      onEscalate,
    });

    mockFetch.mockResolvedValueOnce(ollamaResponse({
      importance: 0.1,
      urgency: 'low',
      topic: 'spam',
      summary: 'Newsletter',
      suggestedRouting: 'main',
      requiresClaude: false,
      confidence: 0.95,
    }));

    const event: RawEvent = {
      type: 'email',
      source: 'gmail:mgandal@gmail.com',
      payload: { from: 'news@example.com', subject: 'Weekly digest' },
      receivedAt: new Date().toISOString(),
    };

    const result = await routerWithRules.route(event);
    expect(result.routing).toBe('autonomous');
  });

  it('escalates critical events', async () => {
    const routerWithEscalate = new EventRouter({
      ollamaHost: 'http://localhost:11434',
      ollamaModel: 'qwen3:8b',
      trustRules: {
        default_routing: 'notify',
        rules: [
          {
            event_type: 'calendar',
            conditions: { change_type: 'conflict' },
            routing: 'escalate',
          },
        ],
      },
      messageBus: mockBus as any,
      healthMonitor: mockHealthMonitor as any,
      onEscalate,
    });

    mockFetch.mockResolvedValueOnce(ollamaResponse({
      importance: 0.9,
      urgency: 'critical',
      topic: 'calendar conflict',
      summary: 'Two meetings overlap',
      suggestedRouting: 'main',
      requiresClaude: true,
      confidence: 0.95,
    }));

    const event: RawEvent = {
      type: 'calendar',
      source: 'icalbuddy',
      payload: { changeType: 'conflict', title: 'Lab Meeting' },
      receivedAt: new Date().toISOString(),
    };

    const result = await routerWithEscalate.route(event);
    expect(result.routing).toBe('escalate');
    expect(onEscalate).toHaveBeenCalledWith(expect.objectContaining({ routing: 'escalate' }));
  });

  it('returns stats', async () => {
    mockFetch.mockResolvedValueOnce(ollamaResponse({
      importance: 0.5, urgency: 'low', topic: 'test', summary: 'test',
      suggestedRouting: 'main', requiresClaude: false, confidence: 0.8,
    }));

    await router.route({
      type: 'email', source: 'test', payload: {}, receivedAt: new Date().toISOString(),
    });

    const stats = router.getStats();
    expect(stats.processed).toBe(1);
    expect(stats.byRouting.notify).toBe(1);
  });
});
```

- [ ] **Run to verify failure:** `npx vitest run src/event-router.test.ts`
- [ ] **Commit:** `test: add event router tests`

### Step 4.3: Implement event router

- [ ] **Create `src/event-router.ts`:**

```typescript
/**
 * Event Router for NanoClaw
 *
 * Receives raw events from watchers, classifies via Ollama,
 * applies trust matrix, routes to message bus or escalates to Claude.
 *
 * Runs host-side (in the main NanoClaw process), not in containers.
 */
import { logger } from './logger.js';
import type { MessageBus } from './message-bus.js';
import type { HealthMonitor } from './health-monitor.js';
import {
  getEmailClassificationPrompt,
  getCalendarClassificationPrompt,
} from './classification-prompts.js';
import type { EmailPayload, CalendarPayload } from './classification-prompts.js';

export interface RawEvent {
  type: 'email' | 'calendar' | 'paper' | 'message';
  source: string;
  payload: Record<string, unknown>;
  receivedAt: string;
}

export interface Classification {
  importance: number;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  topic: string;
  summary: string;
  suggestedRouting: string;
  requiresClaude: boolean;
  confidence: number;
}

export interface ClassifiedEvent extends RawEvent {
  classification: Classification;
  routing: 'autonomous' | 'draft' | 'notify' | 'escalate';
  trustRule?: string;
}

export interface TrustRule {
  event_type?: string;
  conditions?: Record<string, unknown>;
  routing: string;
  action?: string;
}

export interface TrustConfig {
  default_routing: string;
  rules: TrustRule[];
}

export interface EventRouterConfig {
  ollamaHost: string;
  ollamaModel: string;
  trustRules: TrustConfig;
  messageBus: MessageBus;
  healthMonitor: HealthMonitor;
  onEscalate: (event: ClassifiedEvent) => Promise<void>;
}

const DEFAULT_CLASSIFICATION: Classification = {
  importance: 0.5,
  urgency: 'medium',
  topic: 'unclassified',
  summary: 'Could not classify event',
  suggestedRouting: 'main',
  requiresClaude: false,
  confidence: 0,
};

export class EventRouter {
  private config: EventRouterConfig;
  private stats = { processed: 0, byRouting: {} as Record<string, number>, totalLatencyMs: 0 };

  constructor(config: EventRouterConfig) {
    this.config = config;
  }

  async route(event: RawEvent): Promise<ClassifiedEvent> {
    const startTime = Date.now();
    let classification: Classification;

    // Skip Ollama if degraded
    if (this.config.healthMonitor.isOllamaDegraded()) {
      logger.warn('Ollama degraded, skipping classification');
      classification = { ...DEFAULT_CLASSIFICATION };
    } else {
      classification = await this.classify(event);
      const latencyMs = Date.now() - startTime;
      this.config.healthMonitor.recordOllamaLatency(latencyMs);
      this.stats.totalLatencyMs += latencyMs;
    }

    // Apply trust matrix
    const routing = this.applyTrustRules(event, classification);

    const classified: ClassifiedEvent = {
      ...event,
      classification,
      routing: routing as ClassifiedEvent['routing'],
    };

    // Route the event
    this.stats.processed++;
    this.stats.byRouting[routing] = (this.stats.byRouting[routing] || 0) + 1;

    if (routing === 'escalate') {
      await this.config.onEscalate(classified);
    }

    if (routing !== 'autonomous') {
      this.config.messageBus.publish({
        from: event.source,
        topic: 'classified_event',
        finding: classification.summary,
        priority: classification.urgency === 'critical' || classification.urgency === 'high'
          ? 'high'
          : classification.urgency === 'medium'
            ? 'medium'
            : 'low',
        payload: classified,
      });
    }

    logger.info(
      {
        eventType: event.type,
        source: event.source,
        routing,
        importance: classification.importance,
        urgency: classification.urgency,
        confidence: classification.confidence,
      },
      'Event routed',
    );

    return classified;
  }

  getStats(): { processed: number; byRouting: Record<string, number>; avgLatencyMs: number } {
    return {
      ...this.stats,
      avgLatencyMs: this.stats.processed > 0
        ? Math.round(this.stats.totalLatencyMs / this.stats.processed)
        : 0,
    };
  }

  private async classify(event: RawEvent): Promise<Classification> {
    try {
      const { system, prompt } = this.buildPrompt(event);

      const res = await fetch(`${this.config.ollamaHost}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.ollamaModel,
          prompt,
          system,
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        logger.error({ status: res.status }, 'Ollama classification failed');
        return { ...DEFAULT_CLASSIFICATION };
      }

      const data = (await res.json()) as { response: string };
      return this.parseClassification(data.response);
    } catch (err) {
      logger.error({ err }, 'Ollama classification error');
      return { ...DEFAULT_CLASSIFICATION };
    }
  }

  private buildPrompt(event: RawEvent): { system: string; prompt: string } {
    switch (event.type) {
      case 'email':
        return getEmailClassificationPrompt(event.payload as unknown as EmailPayload);
      case 'calendar':
        return getCalendarClassificationPrompt(event.payload as unknown as CalendarPayload);
      default:
        return {
          system: 'Classify this event as JSON with fields: importance (0-1), urgency (low/medium/high/critical), topic, summary, suggestedRouting, requiresClaude (boolean), confidence (0-1). Return ONLY JSON.',
          prompt: JSON.stringify(event.payload),
        };
    }
  }

  private parseClassification(response: string): Classification {
    try {
      // Try to extract JSON from the response (Ollama may wrap in markdown)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { ...DEFAULT_CLASSIFICATION };

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        importance: typeof parsed.importance === 'number' ? parsed.importance : 0.5,
        urgency: ['low', 'medium', 'high', 'critical'].includes(parsed.urgency)
          ? parsed.urgency
          : 'medium',
        topic: String(parsed.topic || 'unknown'),
        summary: String(parsed.summary || 'No summary'),
        suggestedRouting: String(parsed.suggestedRouting || 'main'),
        requiresClaude: Boolean(parsed.requiresClaude),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      };
    } catch {
      return { ...DEFAULT_CLASSIFICATION };
    }
  }

  private applyTrustRules(event: RawEvent, classification: Classification): string {
    for (const rule of this.config.trustRules.rules) {
      if (rule.event_type && rule.event_type !== event.type) continue;

      if (rule.conditions) {
        const cond = rule.conditions;
        if (cond.importance_lt !== undefined && !(classification.importance < (cond.importance_lt as number))) continue;
        if (cond.importance_gte !== undefined && !(classification.importance >= (cond.importance_gte as number))) continue;
        if (cond.change_type !== undefined && event.payload.changeType !== cond.change_type) continue;
        if (cond.sender_domain) {
          const senderDomain = String(event.payload.from || '').split('@')[1] || '';
          if (!(cond.sender_domain as string[]).includes(senderDomain)) continue;
        }
      }

      return rule.routing;
    }

    return this.config.trustRules.default_routing;
  }
}
```

- [ ] **Run tests:** `npx vitest run src/event-router.test.ts` — all pass
- [ ] **Build:** `npm run build`
- [ ] **Commit:** `feat: implement event router with Ollama classification and trust matrix`

---

## Task 5: Gmail Watcher

Polls Gmail API for new messages and feeds them to the event router.

**Files:**
- Create: `src/watchers/gmail-watcher.ts`
- Create: `src/watchers/gmail-watcher.test.ts`

### Step 5.1: Write failing tests

- [ ] **Create `src/watchers/gmail-watcher.test.ts`:**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { GmailWatcher } from './gmail-watcher.js';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock googleapis
vi.mock('googleapis', () => ({
  google: {
    gmail: vi.fn(() => ({
      users: {
        messages: {
          list: vi.fn(),
          get: vi.fn(),
        },
      },
    })),
  },
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    setCredentials: vi.fn(),
    getAccessToken: vi.fn().mockResolvedValue({ token: 'test-token' }),
    on: vi.fn(),
  })),
}));

describe('GmailWatcher', () => {
  let stateDir: string;
  let mockRouter: { route: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-test-'));
    mockRouter = { route: vi.fn().mockResolvedValue({}) };
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('creates watcher with config', () => {
    const watcher = new GmailWatcher({
      credentialsPath: '/fake/creds.json',
      account: 'test@gmail.com',
      eventRouter: mockRouter as any,
      pollIntervalMs: 60000,
      stateDir,
    });
    expect(watcher).toBeDefined();
  });

  it('reports status', () => {
    const watcher = new GmailWatcher({
      credentialsPath: '/fake/creds.json',
      account: 'test@gmail.com',
      eventRouter: mockRouter as any,
      pollIntervalMs: 60000,
      stateDir,
    });
    const status = watcher.getStatus();
    expect(status.mode).toBe('polling');
    expect(status.messagesProcessed).toBe(0);
  });

  it('parses email message into EmailPayload', () => {
    const gmailMsg = {
      id: 'msg_123',
      threadId: 'thread_456',
      snippet: 'Hello world preview...',
      labelIds: ['INBOX', 'UNREAD'],
      payload: {
        headers: [
          { name: 'From', value: 'alice@nih.gov' },
          { name: 'To', value: 'mgandal@gmail.com' },
          { name: 'Cc', value: 'bob@ucla.edu' },
          { name: 'Subject', value: 'Grant update' },
          { name: 'Date', value: 'Thu, 20 Mar 2026 10:00:00 -0700' },
        ],
        parts: [{ body: { attachmentId: 'att_1' } }],
      },
    };

    const payload = GmailWatcher.parseMessage(gmailMsg);
    expect(payload.from).toBe('alice@nih.gov');
    expect(payload.subject).toBe('Grant update');
    expect(payload.to).toContain('mgandal@gmail.com');
    expect(payload.cc).toContain('bob@ucla.edu');
    expect(payload.hasAttachments).toBe(true);
  });
});
```

- [ ] **Run to verify failure:** `npx vitest run src/watchers/gmail-watcher.test.ts`
- [ ] **Commit:** `test: add Gmail watcher tests`

### Step 5.2: Implement Gmail watcher

- [ ] **Create `src/watchers/gmail-watcher.ts`:**

```typescript
/**
 * Gmail Watcher for NanoClaw
 *
 * Polls Gmail API for new messages and feeds them to the event router.
 * Uses OAuth2 credentials from ~/.gmail-mcp/credentials.json.
 */
import fs from 'fs';
import path from 'path';

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { logger } from '../logger.js';
import type { EventRouter } from '../event-router.js';
import type { EmailPayload } from '../classification-prompts.js';

interface GmailWatcherConfig {
  credentialsPath: string;
  account: string;
  eventRouter: EventRouter;
  pollIntervalMs: number;
  stateDir: string;
}

interface GmailState {
  lastHistoryId?: string;
  lastCheckEpoch?: number;
  processedIds: string[];
}

export class GmailWatcher {
  private config: GmailWatcherConfig;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: GmailState = { processedIds: [] };
  private messagesProcessed = 0;
  private lastCheck = '';
  private auth: OAuth2Client | null = null;

  constructor(config: GmailWatcherConfig) {
    this.config = config;
    this.loadState();
  }

  async start(): Promise<void> {
    try {
      this.auth = await this.authenticate();
      logger.info(
        { account: this.config.account },
        'Gmail watcher started (polling mode)',
      );
      await this.poll();
    } catch (err) {
      logger.error({ err }, 'Failed to start Gmail watcher');
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('Gmail watcher stopped');
  }

  getStatus(): {
    mode: 'polling';
    lastCheck: string;
    messagesProcessed: number;
  } {
    return {
      mode: 'polling',
      lastCheck: this.lastCheck,
      messagesProcessed: this.messagesProcessed,
    };
  }

  static parseMessage(msg: Record<string, any>): EmailPayload {
    const headers = msg.payload?.headers || [];
    const getHeader = (name: string): string =>
      headers.find((h: { name: string }) =>
        h.name.toLowerCase() === name.toLowerCase(),
      )?.value || '';

    const hasAttachments = (msg.payload?.parts || []).some(
      (p: { body?: { attachmentId?: string } }) => p.body?.attachmentId,
    );

    return {
      messageId: msg.id || '',
      threadId: msg.threadId || '',
      from: getHeader('From'),
      to: getHeader('To').split(',').map((s: string) => s.trim()).filter(Boolean),
      cc: getHeader('Cc').split(',').map((s: string) => s.trim()).filter(Boolean),
      subject: getHeader('Subject'),
      snippet: msg.snippet || '',
      date: getHeader('Date'),
      labels: msg.labelIds || [],
      hasAttachments,
    };
  }

  private async authenticate(): Promise<OAuth2Client> {
    const credsRaw = fs.readFileSync(this.config.credentialsPath, 'utf-8');
    const creds = JSON.parse(credsRaw);

    const auth = new OAuth2Client(creds.client_id, creds.client_secret);
    auth.setCredentials({
      access_token: creds.token,
      refresh_token: creds.refresh_token,
    });

    return auth;
  }

  private async poll(): Promise<void> {
    try {
      if (!this.auth) return;

      const gmail = google.gmail({ version: 'v1', auth: this.auth });

      // Build query: messages after last check
      const afterEpoch = this.state.lastCheckEpoch
        ? Math.floor(this.state.lastCheckEpoch / 1000)
        : Math.floor((Date.now() - 3600_000) / 1000); // default: last hour

      const query = `after:${afterEpoch}`;
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 20,
      });

      const messages = listRes.data.messages || [];
      let newCount = 0;

      for (const msgRef of messages) {
        if (!msgRef.id || this.state.processedIds.includes(msgRef.id)) continue;

        const msgRes = await gmail.users.messages.get({
          userId: 'me',
          id: msgRef.id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
        });

        const payload = GmailWatcher.parseMessage(msgRes.data as Record<string, any>);

        await this.config.eventRouter.route({
          type: 'email',
          source: `gmail:${this.config.account}`,
          payload: payload as unknown as Record<string, unknown>,
          receivedAt: new Date().toISOString(),
        });

        this.state.processedIds.push(msgRef.id);
        newCount++;
        this.messagesProcessed++;
      }

      // Keep only last 500 processed IDs
      if (this.state.processedIds.length > 500) {
        this.state.processedIds = this.state.processedIds.slice(-500);
      }

      this.state.lastCheckEpoch = Date.now();
      this.lastCheck = new Date().toISOString();
      this.saveState();

      if (newCount > 0) {
        logger.info({ newCount, account: this.config.account }, 'Gmail poll: new messages');
      }
    } catch (err) {
      logger.error({ err }, 'Gmail poll error');
    }

    // Schedule next poll
    this.timer = setTimeout(() => this.poll(), this.config.pollIntervalMs);
  }

  private loadState(): void {
    const statePath = path.join(this.config.stateDir, 'gmail-state.json');
    if (fs.existsSync(statePath)) {
      try {
        this.state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      } catch {
        this.state = { processedIds: [] };
      }
    }
  }

  private saveState(): void {
    fs.mkdirSync(this.config.stateDir, { recursive: true });
    const statePath = path.join(this.config.stateDir, 'gmail-state.json');
    fs.writeFileSync(statePath, JSON.stringify(this.state, null, 2));
  }
}
```

- [ ] **Run tests:** `npx vitest run src/watchers/gmail-watcher.test.ts` — all pass
- [ ] **Build:** `npm run build`
- [ ] **Commit:** `feat: implement Gmail polling watcher`

---

## Task 6: Calendar Watcher

Polls icalbuddy for calendar changes and feeds them to the event router. Uses `execFileSync` (not `execSync`) to avoid shell injection.

**Files:**
- Create: `src/watchers/calendar-watcher.ts`
- Create: `src/watchers/calendar-watcher.test.ts`

### Step 6.1: Write failing tests

- [ ] **Create `src/watchers/calendar-watcher.test.ts`:**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CalendarWatcher } from './calendar-watcher.js';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => ''),
}));

describe('CalendarWatcher', () => {
  let stateDir: string;
  let mockRouter: { route: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-test-'));
    mockRouter = { route: vi.fn().mockResolvedValue({}) };
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('creates watcher with config', () => {
    const watcher = new CalendarWatcher({
      calendars: ['MJG', 'Outlook'],
      eventRouter: mockRouter as any,
      pollIntervalMs: 60000,
      lookAheadDays: 7,
      stateDir,
    });
    expect(watcher).toBeDefined();
  });

  it('reports status', () => {
    const watcher = new CalendarWatcher({
      calendars: ['MJG'],
      eventRouter: mockRouter as any,
      pollIntervalMs: 60000,
      lookAheadDays: 7,
      stateDir,
    });
    const status = watcher.getStatus();
    expect(status.eventsTracked).toBe(0);
    expect(status.changesDetected).toBe(0);
  });

  it('parses icalbuddy output into events', () => {
    const output = `Lab Meeting
    2026-03-21 at 14:00 - 15:00
    Location: Zoom
    Calendar: Gandal_Lab_Meetings
Seminar: Genetics of Autism
    2026-03-22 at 10:00 - 11:00
    Calendar: MJG`;

    const events = CalendarWatcher.parseIcalbuddyOutput(output);
    expect(events).toHaveLength(2);
    expect(events[0].title).toBe('Lab Meeting');
    expect(events[0].calendar).toBe('Gandal_Lab_Meetings');
    expect(events[0].location).toBe('Zoom');
    expect(events[1].title).toBe('Seminar: Genetics of Autism');
  });

  it('detects new events by diffing snapshots', () => {
    const prev = [
      { title: 'Existing', start: '2026-03-21 14:00', end: '2026-03-21 15:00', calendar: 'MJG' },
    ];
    const curr = [
      { title: 'Existing', start: '2026-03-21 14:00', end: '2026-03-21 15:00', calendar: 'MJG' },
      { title: 'New Meeting', start: '2026-03-22 10:00', end: '2026-03-22 11:00', calendar: 'MJG' },
    ];

    const changes = CalendarWatcher.diffSnapshots(prev, curr);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe('new_event');
    expect(changes[0].event.title).toBe('New Meeting');
  });

  it('detects deleted events', () => {
    const prev = [
      { title: 'Meeting A', start: '2026-03-21 14:00', end: '2026-03-21 15:00', calendar: 'MJG' },
      { title: 'Meeting B', start: '2026-03-22 10:00', end: '2026-03-22 11:00', calendar: 'MJG' },
    ];
    const curr = [
      { title: 'Meeting A', start: '2026-03-21 14:00', end: '2026-03-21 15:00', calendar: 'MJG' },
    ];

    const changes = CalendarWatcher.diffSnapshots(prev, curr);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe('deleted');
  });

  it('detects time conflicts', () => {
    const events = [
      { title: 'Meeting A', start: '2026-03-21 14:00', end: '2026-03-21 15:00', calendar: 'MJG' },
      { title: 'Meeting B', start: '2026-03-21 14:30', end: '2026-03-21 15:30', calendar: 'Outlook' },
    ];

    const conflicts = CalendarWatcher.detectConflicts(events);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].changeType).toBe('conflict');
    expect(conflicts[0].conflictsWith?.title).toBe('Meeting A');
  });
});
```

- [ ] **Run to verify failure:** `npx vitest run src/watchers/calendar-watcher.test.ts`
- [ ] **Commit:** `test: add calendar watcher tests`

### Step 6.2: Implement calendar watcher

- [ ] **Create `src/watchers/calendar-watcher.ts`:**

```typescript
/**
 * Calendar Watcher for NanoClaw
 *
 * Polls icalbuddy for calendar events, diffs against previous
 * snapshot to detect changes, feeds events to the event router.
 *
 * Uses execFileSync (not exec/execSync) to avoid shell injection.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import type { EventRouter } from '../event-router.js';
import type { CalendarPayload } from '../classification-prompts.js';

interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  location?: string;
  calendar: string;
  attendees?: string[];
}

interface CalendarWatcherConfig {
  calendars: string[];
  eventRouter: EventRouter;
  pollIntervalMs: number;
  lookAheadDays: number;
  stateDir: string;
}

export class CalendarWatcher {
  private config: CalendarWatcherConfig;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private previousSnapshot: CalendarEvent[] = [];
  private eventsTracked = 0;
  private changesDetected = 0;
  private lastCheck = '';

  constructor(config: CalendarWatcherConfig) {
    this.config = config;
    this.loadSnapshot();
  }

  async start(): Promise<void> {
    // Check if icalbuddy exists
    try {
      execFileSync('which', ['icalbuddy'], { stdio: 'pipe' });
    } catch {
      logger.warn('icalbuddy not found, calendar watcher disabled');
      return;
    }

    logger.info(
      { calendars: this.config.calendars },
      'Calendar watcher started',
    );
    await this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('Calendar watcher stopped');
  }

  getStatus(): {
    lastCheck: string;
    eventsTracked: number;
    changesDetected: number;
  } {
    return {
      lastCheck: this.lastCheck,
      eventsTracked: this.eventsTracked,
      changesDetected: this.changesDetected,
    };
  }

  static parseIcalbuddyOutput(output: string): CalendarEvent[] {
    const events: CalendarEvent[] = [];
    const lines = output.split('\n');
    let current: Partial<CalendarEvent> | null = null;

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;

      // Non-indented line = event title
      if (!line.startsWith(' ') && !line.startsWith('\t')) {
        if (current?.title) {
          events.push(current as CalendarEvent);
        }
        current = { title: trimmed };
        continue;
      }

      if (!current) continue;
      const content = trimmed.trim();

      // Parse date line: "2026-03-21 at 14:00 - 15:00"
      const dateMatch = content.match(
        /^(\d{4}-\d{2}-\d{2})\s+at\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/,
      );
      if (dateMatch) {
        current.start = `${dateMatch[1]} ${dateMatch[2]}`;
        current.end = `${dateMatch[1]} ${dateMatch[3]}`;
        continue;
      }

      // Parse location
      const locMatch = content.match(/^Location:\s*(.+)/);
      if (locMatch) {
        current.location = locMatch[1];
        continue;
      }

      // Parse calendar
      const calMatch = content.match(/^Calendar:\s*(.+)/);
      if (calMatch) {
        current.calendar = calMatch[1];
        continue;
      }

      // Parse attendees
      const attMatch = content.match(/^Attendees:\s*(.+)/);
      if (attMatch) {
        current.attendees = attMatch[1].split(',').map((s) => s.trim());
      }
    }

    // Push last event
    if (current?.title) {
      events.push(current as CalendarEvent);
    }

    return events;
  }

  static diffSnapshots(
    prev: CalendarEvent[],
    curr: CalendarEvent[],
  ): CalendarPayload[] {
    const changes: CalendarPayload[] = [];
    const eventKey = (e: CalendarEvent) =>
      `${e.title}|${e.start}|${e.end}|${e.calendar}`;

    const prevKeys = new Set(prev.map(eventKey));
    const currKeys = new Set(curr.map(eventKey));

    // New events
    for (const event of curr) {
      if (!prevKeys.has(eventKey(event))) {
        changes.push({ changeType: 'new_event', event });
      }
    }

    // Deleted events
    for (const event of prev) {
      if (!currKeys.has(eventKey(event))) {
        changes.push({ changeType: 'deleted', event });
      }
    }

    return changes;
  }

  static detectConflicts(events: CalendarEvent[]): CalendarPayload[] {
    const conflicts: CalendarPayload[] = [];
    const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      // Conflict if curr starts before prev ends
      if (curr.start < prev.end) {
        conflicts.push({
          changeType: 'conflict',
          event: curr,
          conflictsWith: {
            title: prev.title,
            start: prev.start,
            end: prev.end,
          },
        });
      }
    }

    return conflicts;
  }

  private async poll(): Promise<void> {
    try {
      const calendarsArg = this.config.calendars.join(',');
      const output = execFileSync(
        '/opt/homebrew/bin/icalbuddy',
        [
          '-ic', calendarsArg,
          '-df', '%Y-%m-%d',
          '-tf', '%H:%M',
          '-b', '',
          '-nc',
          '-nrd',
          `eventsFrom:today`,
          `to:+${this.config.lookAheadDays}d`,
        ],
        { encoding: 'utf-8', timeout: 10_000 },
      );

      const currentEvents = CalendarWatcher.parseIcalbuddyOutput(output);
      this.eventsTracked = currentEvents.length;

      // Diff against previous snapshot
      const changes = CalendarWatcher.diffSnapshots(
        this.previousSnapshot,
        currentEvents,
      );

      // Detect conflicts in current events
      const conflicts = CalendarWatcher.detectConflicts(currentEvents);

      // Route changes
      for (const change of [...changes, ...conflicts]) {
        this.changesDetected++;
        await this.config.eventRouter.route({
          type: 'calendar',
          source: 'icalbuddy',
          payload: change as unknown as Record<string, unknown>,
          receivedAt: new Date().toISOString(),
        });
      }

      this.previousSnapshot = currentEvents;
      this.lastCheck = new Date().toISOString();
      this.saveSnapshot();

      if (changes.length > 0 || conflicts.length > 0) {
        logger.info(
          { changes: changes.length, conflicts: conflicts.length },
          'Calendar poll: changes detected',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Calendar poll error');
    }

    this.timer = setTimeout(() => this.poll(), this.config.pollIntervalMs);
  }

  private loadSnapshot(): void {
    const snapshotPath = path.join(
      this.config.stateDir,
      'calendar-snapshot.json',
    );
    if (fs.existsSync(snapshotPath)) {
      try {
        this.previousSnapshot = JSON.parse(
          fs.readFileSync(snapshotPath, 'utf-8'),
        );
      } catch {
        this.previousSnapshot = [];
      }
    }
  }

  private saveSnapshot(): void {
    fs.mkdirSync(this.config.stateDir, { recursive: true });
    const snapshotPath = path.join(
      this.config.stateDir,
      'calendar-snapshot.json',
    );
    fs.writeFileSync(
      snapshotPath,
      JSON.stringify(this.previousSnapshot, null, 2),
    );
  }
}
```

- [ ] **Run tests:** `npx vitest run src/watchers/calendar-watcher.test.ts` — all pass
- [ ] **Build:** `npm run build`
- [ ] **Commit:** `feat: implement calendar icalbuddy polling watcher`

---

## Task 7: Integration Wiring

Wire everything into `src/index.ts` and extend the context assembler.

**Files:**
- Modify: `src/index.ts` (initialize router and watchers in `main()`)
- Modify: `src/context-assembler.ts` (add classified events section)

### Step 7.1: Extend context assembler

- [ ] **In `src/context-assembler.ts`, add a new section after the existing "6. Message bus items" section (after line ~119). Insert before the "Assemble and truncate" comment:**

```typescript
  // 7. Classified events (from message bus)
  if (fs.existsSync(busQueuePath)) {
    try {
      const queue = JSON.parse(fs.readFileSync(busQueuePath, 'utf-8'));
      const classified = queue.filter(
        (m: { topic: string }) => m.topic === 'classified_event',
      );
      if (classified.length > 0) {
        const formatted = classified
          .slice(0, 10)
          .map(
            (e: { payload?: { classification?: { urgency?: string; summary?: string } }; from?: string; finding?: string }) =>
              `[${e.payload?.classification?.urgency || 'medium'}] ${e.payload?.classification?.summary || e.finding || 'No summary'} (from: ${e.from || 'unknown'})`,
          )
          .join('\n');
        sections.push(
          `\n--- Recent Events (classified) ---\n${formatted}`,
        );
      }
    } catch {
      // Already read above or malformed, skip
    }
  }
```

Note: `busQueuePath` is already defined earlier in the function (section 6). Reuse it.

- [ ] **Build:** `npm run build`
- [ ] **Run tests:** `npm test` — all pass
- [ ] **Commit:** `feat: add classified events to context assembler`

### Step 7.2: Wire event router and watchers into index.ts

- [ ] **Add imports at top of `src/index.ts`.** Merge these into the existing config import block (lines 4-16) and add new imports after existing ones:

Add to existing config import:
```typescript
  EVENT_ROUTER_ENABLED,
  GMAIL_ACCOUNT,
  GMAIL_CREDENTIALS_PATH,
  GMAIL_POLL_INTERVAL,
  CALENDAR_NAMES,
  CALENDAR_POLL_INTERVAL,
  CALENDAR_LOOKAHEAD_DAYS,
  OLLAMA_HOST,
  OLLAMA_MODEL,
  TRUST_MATRIX_PATH,
```

Add new imports (after existing import block):
```typescript
import { EventRouter, TrustConfig } from './event-router.js';
import { GmailWatcher } from './watchers/gmail-watcher.js';
import { CalendarWatcher } from './watchers/calendar-watcher.js';
import YAML from 'yaml';
```

Note: `DATA_DIR` is already imported from config. `fs` and `path` are already imported.

- [ ] **In `main()`, after the messageBus initialization and before the credential proxy, add:**

```typescript
  // Event router and watchers (Phase 2)
  if (EVENT_ROUTER_ENABLED) {
    // Load trust matrix
    let trustRules: TrustConfig = { default_routing: 'notify', rules: [] };
    if (fs.existsSync(TRUST_MATRIX_PATH)) {
      try {
        trustRules = YAML.parse(
          fs.readFileSync(TRUST_MATRIX_PATH, 'utf-8'),
        ) as TrustConfig;
        logger.info('Trust matrix loaded');
      } catch (err) {
        logger.warn({ err }, 'Failed to parse trust matrix, using defaults');
      }
    } else {
      logger.info('No trust matrix found, using default routing (notify)');
    }

    const eventRouter = new EventRouter({
      ollamaHost: OLLAMA_HOST,
      ollamaModel: OLLAMA_MODEL,
      trustRules,
      messageBus,
      healthMonitor,
      onEscalate: async (event) => {
        // Trigger notification for critical events
        const mainJid = Object.keys(registeredGroups).find(
          (jid) => registeredGroups[jid]?.isMain,
        );
        if (mainJid) {
          const channel = findChannel(channels, mainJid);
          await channel?.sendMessage(
            mainJid,
            `Escalated event: ${event.classification.summary}`,
          );
        }
      },
    });

    const watcherStateDir = path.join(DATA_DIR, 'watchers');

    // Gmail watcher
    if (fs.existsSync(GMAIL_CREDENTIALS_PATH)) {
      const gmailWatcher = new GmailWatcher({
        credentialsPath: GMAIL_CREDENTIALS_PATH,
        account: GMAIL_ACCOUNT,
        eventRouter,
        pollIntervalMs: GMAIL_POLL_INTERVAL,
        stateDir: watcherStateDir,
      });
      gmailWatcher.start().catch((err) =>
        logger.error({ err }, 'Gmail watcher failed to start'),
      );
    } else {
      logger.info('Gmail credentials not found, Gmail watcher disabled');
    }

    // Calendar watcher
    const calendarWatcher = new CalendarWatcher({
      calendars: CALENDAR_NAMES,
      eventRouter,
      pollIntervalMs: CALENDAR_POLL_INTERVAL,
      lookAheadDays: CALENDAR_LOOKAHEAD_DAYS,
      stateDir: watcherStateDir,
    });
    calendarWatcher.start().catch((err) =>
      logger.error({ err }, 'Calendar watcher failed to start'),
    );

    logger.info('Event router and watchers initialized');
  }
```

- [ ] **Build:** `npm run build`
- [ ] **Run ALL tests:** `npm test` — all tests pass
- [ ] **Commit:** `feat: wire event router and watchers into main loop`

---

## Task 8: Integration Validation

### Step 8.1: Full build and test

- [ ] **Full build and test:**

```bash
npm run build && npm test
```

Expected: All tests pass (353+ existing + new tests).

### Step 8.2: Copy trust matrix example to data/

- [ ] **Set up runtime trust config:**

```bash
mkdir -p data
cp data/trust.yaml.example data/trust.yaml
```

### Step 8.3: Restart and verify

- [ ] **Clear agent-runner cache and restart:**

```bash
rm -rf data/sessions/*/agent-runner-src/
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 8.4: Verify logs

- [ ] **Check for event router initialization:**

```bash
tail -100 logs/nanoclaw.log | grep -i "event\|router\|watcher\|ollama\|trust"
```

Expected: "Event router and watchers initialized", "Gmail watcher started" or "Gmail credentials not found", "Calendar watcher started" or "icalbuddy not found".

### Step 8.5: Final commit

- [ ] **Commit any remaining changes**

---

## Known Limitations (Acceptable for Phase 2)

1. **Gmail uses polling, not push.** Pub/Sub push requires GCP project setup. 60-second polling is the fallback and sufficient for most use cases.

2. **Calendar uses icalbuddy polling.** EventKit callbacks would give instant detection but require a Swift bridge. 60-second polling is sufficient.

3. **Single Ollama model (qwen3:8b).** If classification quality is poor for specific event types, per-prompt model override can be added later.

4. **Trust matrix is static YAML.** No automatic promotion. Phase 3 adds approval tracking and automatic trust level adjustment.

5. **Only email metadata classified.** Full body is NOT sent to Ollama — keeps inference fast and avoids sending sensitive content through local models.
