# Agentic UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform NanoClaw's Telegram interface from a flat text narrator into an agentic operations panel with categorized messages, inline action buttons, live status bar, Telegram Mini App, email preview, auto-question buttons, and post-action archive flow.

**Architecture:** Hybrid A+C — Message renderer pipeline in `router.ts` for individual message formatting (classifier → formatter → action attacher), plus event-driven consumers on the existing `EventBus` for aggregate views (status bar, Mini App state, auto-approval timers). All new components follow existing patterns: typed events in `events.ts`, `EventBus.on()` subscriptions, SQLite tables in `db.ts`, grammy-based Telegram channel.

**Tech Stack:** TypeScript, grammy (Telegram Bot API), Express (Mini App server), better-sqlite3 (existing), existing EventBus

**Spec:** `docs/superpowers/specs/2026-04-16-agentic-ux-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/message-classifier.ts` | Rule-based classifier: pattern match on content/sender to assign category, urgency, batchable, actions |
| `src/message-formatter.ts` | Takes `MessageMeta` + raw text → channel-formatted output (HTML for Telegram) |
| `src/question-detector.ts` | Detects question patterns in outbound text, returns button configs |
| `src/message-batcher.ts` | Holds `auto-handled` + `info` items in buffer, flushes on count/time/priority triggers |
| `src/status-bar.ts` | `StatusBarManager` event consumer — maintains pinned status message via edit-in-place |
| `src/auto-approval.ts` | `AutoApprovalTimer` — countdown timers for silence-means-approval on urgent plans |
| `src/failure-escalator.ts` | `FailureEscalator` — sends loud failure messages with retry/escalate buttons |
| `src/email-preview.ts` | Gmail API fetch + cache for email body preview/expansion |
| `src/archive-tracker.ts` | Post-action archive flow: tracks acted emails, batch sweep for morning digest |
| `src/draft-enrichment.ts` | `DraftEnrichmentWatcher` — detects SuperPilot drafts, evaluates enrichment, modifies via Gmail API |
| `src/mini-app/server.ts` | Express server serving task detail HTML pages + API endpoints |
| `src/mini-app/templates/task-detail.ts` | HTML template function for task detail page |
| `src/mini-app/templates/email-full.ts` | HTML template function for full email view |

### Modified Files

| File | Changes |
|------|---------|
| `src/types.ts` | Add `MessageMeta`, `MessageCategory`, `MessageUrgency`, `ActionStyle` types; extend `Action` with `style` and `confirmRequired` |
| `src/events.ts` | Add 7 new event types + `EventMap` entries |
| `src/event-bus.ts` | No changes — existing API is sufficient |
| `src/db.ts` | Add `task_detail_state` and `acted_emails` tables |
| `src/router.ts` | Wire classifier + formatter into `formatOutbound()` pipeline; add `routeOutboundWithMeta()` |
| `src/channels/telegram.ts` | Add `editMessageButtons()`, `sendMessageWithWebApp()`, Mini App `web_app` button support |
| `src/index.ts` | Initialize new consumers (StatusBarManager, AutoApprovalTimer, FailureEscalator, etc.) at startup |
| `src/daily-digest.ts` or `src/digest-engine.ts` | Add inbox cleanup section to morning digest |

---

### Task 1: Types & Event Definitions

**Files:**
- Modify: `src/types.ts`
- Modify: `src/events.ts`
- Test: `src/__tests__/agentic-ux-types.test.ts`

- [ ] **Step 1: Write type tests**

```typescript
// src/__tests__/agentic-ux-types.test.ts
import { describe, it, expect } from 'vitest';
import type {
  MessageMeta,
  MessageCategory,
  MessageUrgency,
  ActionStyle,
  Action,
} from '../types.js';

describe('Agentic UX types', () => {
  it('MessageMeta has required fields', () => {
    const meta: MessageMeta = {
      category: 'financial',
      urgency: 'action-required',
      actions: [
        {
          label: 'Confirm',
          callbackData: 'confirm:123',
          style: 'primary',
          confirmRequired: true,
        },
      ],
      batchable: false,
    };
    expect(meta.category).toBe('financial');
    expect(meta.urgency).toBe('action-required');
    expect(meta.actions[0].style).toBe('primary');
    expect(meta.actions[0].confirmRequired).toBe(true);
    expect(meta.batchable).toBe(false);
  });

  it('MessageMeta optional fields', () => {
    const meta: MessageMeta = {
      category: 'auto-handled',
      urgency: 'info',
      actions: [],
      batchable: true,
      miniAppUrl: '/task/abc123',
      emailId: 'msg_123',
      threadId: 'thread_456',
      account: 'personal',
    };
    expect(meta.miniAppUrl).toBe('/task/abc123');
    expect(meta.emailId).toBe('msg_123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/agentic-ux-types.test.ts`
Expected: FAIL — types don't exist yet

- [ ] **Step 3: Add types to `src/types.ts`**

Add at the end of `src/types.ts`:

```typescript
// --- Agentic UX types ---

export type MessageCategory =
  | 'financial'
  | 'security'
  | 'email'
  | 'team'
  | 'account'
  | 'auto-handled';

export type MessageUrgency = 'info' | 'attention' | 'action-required' | 'urgent';

export type ActionStyle = 'primary' | 'destructive-safe' | 'plan-execution' | 'secondary' | 'timed-auto';

export interface Action {
  label: string;
  callbackData: string;
  style?: ActionStyle;
  confirmRequired?: boolean;
  webAppUrl?: string; // If set, opens Telegram Mini App instead of callback
}

export interface MessageMeta {
  category: MessageCategory;
  urgency: MessageUrgency;
  actions: Action[];
  batchable: boolean;
  miniAppUrl?: string;
  emailId?: string;
  threadId?: string;
  account?: string;
  questionType?: 'yes-no' | 'financial-confirm' | 'multi-option';
  questionId?: string;
}
```

Note: The existing `Action` interface (line 96-99) must be replaced — the new one is a superset with backward-compatible required fields (`label`, `callbackData`).

- [ ] **Step 4: Add new event types to `src/events.ts`**

Add before the `EventMap` interface:

```typescript
// --- Plan events ---

export interface PlanProposedEvent extends NanoClawEvent {
  type: 'plan.proposed';
  source: 'agent';
  payload: {
    taskId: string;
    plan: string;
    urgency: 'normal' | 'urgent';
    domain: string;
  };
}

export interface PlanAutoApprovedEvent extends NanoClawEvent {
  type: 'plan.auto_approved';
  source: 'auto-approval';
  payload: {
    taskId: string;
  };
}

export interface PlanCancelledEvent extends NanoClawEvent {
  type: 'plan.cancelled';
  source: 'auto-approval';
  payload: {
    taskId: string;
  };
}

// --- Draft events ---

export interface EmailDraftCreatedEvent extends NanoClawEvent {
  type: 'email.draft.created';
  source: 'draft-watcher';
  payload: {
    draftId: string;
    threadId: string;
    account: string;
  };
}

export interface EmailDraftEnrichedEvent extends NanoClawEvent {
  type: 'email.draft.enriched';
  source: 'draft-enrichment';
  payload: {
    draftId: string;
    changes: string;
  };
}

// --- Email action events ---

export interface EmailActionCompletedEvent extends NanoClawEvent {
  type: 'email.action.completed';
  source: 'archive-tracker';
  payload: {
    emailId: string;
    threadId: string;
    account: string;
    action: string;
  };
}
```

Add to the `EventMap` interface:

```typescript
  'plan.proposed': PlanProposedEvent;
  'plan.auto_approved': PlanAutoApprovedEvent;
  'plan.cancelled': PlanCancelledEvent;
  'email.draft.created': EmailDraftCreatedEvent;
  'email.draft.enriched': EmailDraftEnrichedEvent;
  'email.action.completed': EmailActionCompletedEvent;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/__tests__/agentic-ux-types.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/events.ts src/__tests__/agentic-ux-types.test.ts
git commit -m "feat(ux): add MessageMeta types and agentic UX event definitions"
```

---

### Task 2: Message Classifier

**Files:**
- Create: `src/message-classifier.ts`
- Test: `src/__tests__/message-classifier.test.ts`

- [ ] **Step 1: Write classifier tests**

```typescript
// src/__tests__/message-classifier.test.ts
import { describe, it, expect } from 'vitest';
import { classifyMessage } from '../message-classifier.js';

describe('classifyMessage', () => {
  it('classifies Chase wire notification as financial + action-required', () => {
    const meta = classifyMessage(
      'Chase — 2 incoming wires to account ····7958. Total: $54,900. Were both expected?',
    );
    expect(meta.category).toBe('financial');
    expect(meta.urgency).toBe('action-required');
    expect(meta.batchable).toBe(false);
  });

  it('classifies Spamhaus alert as security + urgent', () => {
    const meta = classifyMessage(
      'Hetzner IP Spamhaus listed — 178.104.205.217 has been listed by Spamhaus for abuse',
    );
    expect(meta.category).toBe('security');
    expect(meta.urgency).toBe('urgent');
    expect(meta.batchable).toBe(false);
  });

  it('classifies marketing email as auto-handled + info', () => {
    const meta = classifyMessage(
      'Asoview birthday promo (Japanese marketing email) — AUTO, no action needed.',
    );
    expect(meta.category).toBe('auto-handled');
    expect(meta.urgency).toBe('info');
    expect(meta.batchable).toBe(true);
  });

  it('classifies receipt as auto-handled + info', () => {
    const meta = classifyMessage(
      'Clerk.com receipt — $25.00 Pro Plan, Apr 15. AUTO, no action.',
    );
    expect(meta.category).toBe('auto-handled');
    expect(meta.urgency).toBe('info');
    expect(meta.batchable).toBe(true);
  });

  it('classifies team update as team + info', () => {
    const meta = classifyMessage(
      'Dmitrii (Attaxion/WhoisXML) — acknowledged staging request with ticket #WANF-864. No action needed.',
    );
    expect(meta.category).toBe('team');
    expect(meta.urgency).toBe('info');
    expect(meta.batchable).toBe(true);
  });

  it('classifies Nstproxy verification as account + info', () => {
    const meta = classifyMessage(
      'Nstproxy (proxy signup #12 for Philip Ye) — account activation email received.',
    );
    expect(meta.category).toBe('account');
    expect(meta.urgency).toBe('info');
    expect(meta.batchable).toBe(false);
  });

  it('classifies draft enrichment notification as email + attention', () => {
    const meta = classifyMessage(
      'Enriched SuperPilot draft → David Hagberg — added invoice ref #INV-031',
    );
    expect(meta.category).toBe('email');
    expect(meta.urgency).toBe('attention');
    expect(meta.batchable).toBe(false);
  });

  it('defaults unrecognized messages to email + info', () => {
    const meta = classifyMessage('Something completely new and unknown');
    expect(meta.category).toBe('email');
    expect(meta.urgency).toBe('info');
    expect(meta.batchable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/message-classifier.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement classifier**

```typescript
// src/message-classifier.ts
import type { MessageMeta, MessageCategory, MessageUrgency } from './types.js';

interface ClassificationRule {
  patterns: RegExp[];
  category: MessageCategory;
  urgency: MessageUrgency;
  batchable: boolean;
}

const RULES: ClassificationRule[] = [
  // Financial — wires, deposits, payments, billing
  {
    patterns: [
      /incoming wire/i,
      /direct deposit/i,
      /wire transfer/i,
      /chase.*activity/i,
      /billing statement/i,
      /payment.*received/i,
      /were.*expected\??/i,
      /all expected\??/i,
    ],
    category: 'financial',
    urgency: 'action-required',
    batchable: false,
  },
  // Security — Spamhaus, abuse, compromise, vulnerability
  {
    patterns: [
      /spamhaus/i,
      /listed.*abuse/i,
      /compromis/i,
      /security.*alert/i,
      /vulnerability/i,
      /unauthorized.*access/i,
    ],
    category: 'security',
    urgency: 'urgent',
    batchable: false,
  },
  // Auto-handled — AUTO, no action, marketing, receipts
  {
    patterns: [
      /AUTO[,.]?\s*no action/i,
      /\bAUTO\b.*handled/i,
      /marketing email/i,
      /newsletter.*AUTO/i,
      /receipt\s*—.*AUTO/i,
      /already processed/i,
      /promo.*AUTO/i,
    ],
    category: 'auto-handled',
    urgency: 'info',
    batchable: true,
  },
  // Team — acknowledged, team update, no action needed (not AUTO)
  {
    patterns: [
      /acknowledged.*request/i,
      /team is aligned/i,
      /no action needed(?!.*AUTO)/i,
      /FYI\b/i,
    ],
    category: 'team',
    urgency: 'info',
    batchable: true,
  },
  // Account management — signup, verification, activation
  {
    patterns: [
      /signup\s*#?\d/i,
      /verification.*link/i,
      /account.*activation/i,
      /proxy.*signup/i,
      /welcome.*email/i,
    ],
    category: 'account',
    urgency: 'info',
    batchable: false,
  },
  // Email — draft enrichment, SuperPilot
  {
    patterns: [
      /enriched.*draft/i,
      /SuperPilot.*draft/i,
      /draft.*enriched/i,
    ],
    category: 'email',
    urgency: 'attention',
    batchable: false,
  },
];

export function classifyMessage(text: string): MessageMeta {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      return {
        category: rule.category,
        urgency: rule.urgency,
        actions: [],
        batchable: rule.batchable,
      };
    }
  }

  // Default: email + info
  return {
    category: 'email',
    urgency: 'info',
    actions: [],
    batchable: false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/message-classifier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/message-classifier.ts src/__tests__/message-classifier.test.ts
git commit -m "feat(ux): add rule-based message classifier"
```

---

### Task 3: Question Detector

**Files:**
- Create: `src/question-detector.ts`
- Test: `src/__tests__/question-detector.test.ts`

- [ ] **Step 1: Write question detector tests**

```typescript
// src/__tests__/question-detector.test.ts
import { describe, it, expect } from 'vitest';
import { detectQuestion } from '../question-detector.js';

describe('detectQuestion', () => {
  it('detects yes/no question with "Want me to"', () => {
    const result = detectQuestion(
      'Want me to reply yes to Florian\'s exception?',
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('yes-no');
    expect(result!.actions).toHaveLength(3); // Yes, No, Let me think...
    expect(result!.actions[0].label).toBe('Yes');
    expect(result!.actions[1].label).toBe('No');
    expect(result!.actions[2].label).toBe('Let me think...');
  });

  it('detects yes/no question with "Should I"', () => {
    const result = detectQuestion('Should I file this as a ticket?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('yes-no');
  });

  it('detects financial confirmation with "expected"', () => {
    const result = detectQuestion(
      'Total: $54,900.00. Were both expected?',
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('financial-confirm');
    expect(result!.actions[0].label).toBe('Yes, all expected');
    expect(result!.actions[1].label).toBe('Not all \u2014 review');
  });

  it('detects financial confirmation with "All expected"', () => {
    const result = detectQuestion(
      'Total new: $59,558.45 in. All expected?',
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('financial-confirm');
  });

  it('returns null for statements (no question)', () => {
    const result = detectQuestion(
      'Clerk.com receipt — $25.00 Pro Plan. AUTO, no action.',
    );
    expect(result).toBeNull();
  });

  it('returns null for rhetorical/informational text', () => {
    const result = detectQuestion(
      'Dmitrii acknowledged the staging request. No action needed.',
    );
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/question-detector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement question detector**

```typescript
// src/question-detector.ts
import type { Action } from './types.js';

export interface DetectedQuestion {
  type: 'yes-no' | 'financial-confirm' | 'multi-option';
  questionId: string;
  actions: Action[];
}

let questionCounter = 0;

function nextQuestionId(): string {
  return `q_${Date.now()}_${++questionCounter}`;
}

const YES_NO_PATTERNS = [
  /want me to\b.*\?$/im,
  /should I\b.*\?$/im,
  /shall I\b.*\?$/im,
  /do you want\b.*\?$/im,
  /would you like\b.*\?$/im,
  /can I\b.*\?$/im,
  /okay to\b.*\?$/im,
  /approve this\??$/im,
  /is this correct\??$/im,
  /handle this\??$/im,
];

const FINANCIAL_CONFIRM_PATTERNS = [
  /(?:were|was).*expected\?$/im,
  /all expected\?$/im,
  /confirm.*(?:wire|deposit|payment|transfer)/im,
  /expected.*\?$/im,
];

/**
 * Detect if outbound text contains a question and return appropriate button config.
 * Returns null if no question is detected.
 */
export function detectQuestion(text: string): DetectedQuestion | null {
  // Only look at the last 200 characters for the question
  const tail = text.slice(-200);

  // Check financial first (more specific)
  if (FINANCIAL_CONFIRM_PATTERNS.some((p) => p.test(tail))) {
    const qid = nextQuestionId();
    return {
      type: 'financial-confirm',
      questionId: qid,
      actions: [
        { label: 'Yes, all expected', callbackData: `answer:${qid}:yes`, style: 'primary' },
        { label: 'Not all \u2014 review', callbackData: `answer:${qid}:review`, style: 'destructive-safe' },
        { label: 'Details \u2197', callbackData: `answer:${qid}:details`, style: 'secondary' },
      ],
    };
  }

  // Check yes/no
  if (YES_NO_PATTERNS.some((p) => p.test(tail))) {
    const qid = nextQuestionId();
    return {
      type: 'yes-no',
      questionId: qid,
      actions: [
        { label: 'Yes', callbackData: `answer:${qid}:yes`, style: 'primary' },
        { label: 'No', callbackData: `answer:${qid}:no`, style: 'destructive-safe' },
        { label: 'Let me think...', callbackData: `answer:${qid}:defer`, style: 'secondary' },
      ],
    };
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/question-detector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/question-detector.ts src/__tests__/question-detector.test.ts
git commit -m "feat(ux): add question detector for auto-attaching yes/no buttons"
```

---

### Task 4: Message Formatter

**Files:**
- Create: `src/message-formatter.ts`
- Test: `src/__tests__/message-formatter.test.ts`

- [ ] **Step 1: Write formatter tests**

```typescript
// src/__tests__/message-formatter.test.ts
import { describe, it, expect } from 'vitest';
import { formatWithMeta } from '../message-formatter.js';
import type { MessageMeta } from '../types.js';

describe('formatWithMeta', () => {
  it('formats financial message with green prefix', () => {
    const meta: MessageMeta = {
      category: 'financial',
      urgency: 'action-required',
      actions: [],
      batchable: false,
    };
    const result = formatWithMeta('2 incoming wires. Total: $54,900.', meta);
    expect(result).toContain('💰');
    expect(result).toContain('Financial');
    expect(result).toContain('2 incoming wires');
  });

  it('formats security message with shield prefix', () => {
    const meta: MessageMeta = {
      category: 'security',
      urgency: 'urgent',
      actions: [],
      batchable: false,
    };
    const result = formatWithMeta('Spamhaus listing detected', meta);
    expect(result).toContain('🛡');
    expect(result).toContain('Security');
  });

  it('formats auto-handled message dimmed', () => {
    const meta: MessageMeta = {
      category: 'auto-handled',
      urgency: 'info',
      actions: [],
      batchable: true,
    };
    const result = formatWithMeta('Newsletter dismissed', meta);
    expect(result).toContain('✓');
    expect(result).toContain('Auto-handled');
  });

  it('formats team message with team prefix', () => {
    const meta: MessageMeta = {
      category: 'team',
      urgency: 'info',
      actions: [],
      batchable: true,
    };
    const result = formatWithMeta('Dmitrii acknowledged request', meta);
    expect(result).toContain('👥');
    expect(result).toContain('Team');
  });

  it('formats email message with envelope prefix', () => {
    const meta: MessageMeta = {
      category: 'email',
      urgency: 'attention',
      actions: [],
      batchable: false,
    };
    const result = formatWithMeta('Draft enriched for David', meta);
    expect(result).toContain('📧');
    expect(result).toContain('Email');
  });

  it('formats batch of auto-handled items', () => {
    const items = ['Newsletter A dismissed', 'Receipt B processed', 'Promo C ignored'];
    const result = formatWithMeta(items.join('\n'), {
      category: 'auto-handled',
      urgency: 'info',
      actions: [],
      batchable: true,
    });
    expect(result).toContain('Auto-handled');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/message-formatter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement formatter**

```typescript
// src/message-formatter.ts
import type { MessageMeta, MessageCategory } from './types.js';

interface CategoryFormat {
  icon: string;
  label: string;
}

const CATEGORY_FORMATS: Record<MessageCategory, CategoryFormat> = {
  financial: { icon: '💰', label: 'Financial' },
  security: { icon: '🛡', label: 'Security' },
  email: { icon: '📧', label: 'Email' },
  team: { icon: '👥', label: 'Team' },
  account: { icon: '⚙', label: 'Background' },
  'auto-handled': { icon: '✓', label: 'Auto-handled' },
};

const URGENCY_LABELS: Record<string, string> = {
  info: 'FYI',
  attention: 'needs attention',
  'action-required': 'needs confirmation',
  urgent: 'action plan ready',
};

/**
 * Format a message with categorical prefix for Telegram HTML.
 * Returns the formatted text — buttons are attached separately via sendMessageWithActions.
 */
export function formatWithMeta(text: string, meta: MessageMeta): string {
  const fmt = CATEGORY_FORMATS[meta.category];
  const urgencyLabel = URGENCY_LABELS[meta.urgency] || '';

  const header = `${fmt.icon} <b>${fmt.label}</b>${urgencyLabel ? ` · ${urgencyLabel}` : ''}`;

  // Auto-handled items get dimmed treatment
  if (meta.category === 'auto-handled') {
    return `${header}\n${text}`;
  }

  return `${header}\n\n${text}`;
}

/**
 * Format a batch of auto-handled items into a single collapsed message.
 */
export function formatBatch(items: string[]): string {
  const header = `✓ <b>Auto-handled</b> · ${items.length} items`;
  const body = items.map((item) => `• ${item}`).join('\n');
  return `${header}\n${body}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/message-formatter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/message-formatter.ts src/__tests__/message-formatter.test.ts
git commit -m "feat(ux): add message formatter with categorical icons and HTML output"
```

---

### Task 5: Message Batcher

**Files:**
- Create: `src/message-batcher.ts`
- Test: `src/__tests__/message-batcher.test.ts`

- [ ] **Step 1: Write batcher tests**

```typescript
// src/__tests__/message-batcher.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageBatcher } from '../message-batcher.js';

describe('MessageBatcher', () => {
  let batcher: MessageBatcher;
  let flushed: string[][];

  beforeEach(() => {
    vi.useFakeTimers();
    flushed = [];
    batcher = new MessageBatcher({
      maxItems: 5,
      maxWaitMs: 10_000,
      onFlush: (items) => { flushed.push([...items]); },
    });
  });

  afterEach(() => {
    batcher.destroy();
    vi.useRealTimers();
  });

  it('flushes after maxItems reached', () => {
    for (let i = 0; i < 5; i++) {
      batcher.add(`item ${i}`);
    }
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(5);
  });

  it('flushes after maxWaitMs elapsed', () => {
    batcher.add('item 1');
    batcher.add('item 2');
    expect(flushed).toHaveLength(0);

    vi.advanceTimersByTime(10_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(2);
  });

  it('flushes on priority interrupt', () => {
    batcher.add('item 1');
    batcher.add('item 2');
    expect(flushed).toHaveLength(0);

    batcher.flushNow();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(2);
  });

  it('does not flush when empty', () => {
    batcher.flushNow();
    expect(flushed).toHaveLength(0);
  });

  it('resets timer after flush', () => {
    batcher.add('item 1');
    vi.advanceTimersByTime(10_000);
    expect(flushed).toHaveLength(1);

    batcher.add('item 2');
    vi.advanceTimersByTime(5_000);
    expect(flushed).toHaveLength(1); // not yet

    vi.advanceTimersByTime(5_000);
    expect(flushed).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/message-batcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement batcher**

```typescript
// src/message-batcher.ts

export interface MessageBatcherOpts {
  maxItems: number;       // Flush after this many items (default: 5)
  maxWaitMs: number;      // Flush after this many ms since first buffered item (default: 10000)
  onFlush: (items: string[]) => void;
}

export class MessageBatcher {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private opts: MessageBatcherOpts;

  constructor(opts: MessageBatcherOpts) {
    this.opts = opts;
  }

  add(item: string): void {
    this.buffer.push(item);

    if (this.buffer.length >= this.opts.maxItems) {
      this.flush();
      return;
    }

    // Start timer on first item
    if (this.buffer.length === 1) {
      this.timer = setTimeout(() => this.flush(), this.opts.maxWaitMs);
    }
  }

  /** Force flush — call before sending a higher-priority message */
  flushNow(): void {
    if (this.buffer.length > 0) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.buffer.length === 0) return;

    const items = this.buffer.splice(0);
    this.opts.onFlush(items);
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/message-batcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/message-batcher.ts src/__tests__/message-batcher.test.ts
git commit -m "feat(ux): add message batcher with count/time/priority flush triggers"
```

---

### Task 6: Database Tables

**Files:**
- Modify: `src/db.ts`
- Test: `src/__tests__/agentic-ux-db.test.ts`

- [ ] **Step 1: Write DB table tests**

```typescript
// src/__tests__/agentic-ux-db.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

describe('Agentic UX DB tables', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');

    db.exec(`
      CREATE TABLE IF NOT EXISTS task_detail_state (
        task_id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        title TEXT NOT NULL,
        steps_json TEXT NOT NULL DEFAULT '[]',
        log_json TEXT NOT NULL DEFAULT '[]',
        findings_json TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS acted_emails (
        email_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        account TEXT NOT NULL,
        action_taken TEXT NOT NULL,
        acted_at TEXT NOT NULL,
        archived_at TEXT,
        PRIMARY KEY (email_id, action_taken)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS draft_originals (
        draft_id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        original_body TEXT NOT NULL,
        enriched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `);
  });

  it('inserts and queries task_detail_state', () => {
    db.prepare(
      'INSERT INTO task_detail_state (task_id, group_jid, title, steps_json, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('t1', 'tg:123', 'Spamhaus Investigation', '[]', new Date().toISOString(), new Date().toISOString());

    const row = db.prepare('SELECT * FROM task_detail_state WHERE task_id = ?').get('t1') as Record<string, unknown>;
    expect(row.title).toBe('Spamhaus Investigation');
    expect(row.status).toBe('active');
  });

  it('inserts and queries acted_emails', () => {
    db.prepare(
      'INSERT INTO acted_emails (email_id, thread_id, account, action_taken, acted_at) VALUES (?, ?, ?, ?, ?)',
    ).run('msg_1', 'thread_1', 'personal', 'confirmed', new Date().toISOString());

    const rows = db.prepare('SELECT * FROM acted_emails WHERE archived_at IS NULL').all();
    expect(rows).toHaveLength(1);
  });

  it('inserts and queries draft_originals', () => {
    const now = new Date();
    const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    db.prepare(
      'INSERT INTO draft_originals (draft_id, account, original_body, enriched_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run('d1', 'dev', 'original text', now.toISOString(), expires.toISOString());

    const row = db.prepare('SELECT * FROM draft_originals WHERE draft_id = ?').get('d1') as Record<string, unknown>;
    expect(row.original_body).toBe('original text');
  });
});
```

- [ ] **Step 2: Run test to verify it passes (standalone in-memory)**

Run: `npx vitest run src/__tests__/agentic-ux-db.test.ts`
Expected: PASS (tests use in-memory DB with inline schema)

- [ ] **Step 3: Add tables to `src/db.ts`**

Find the `initDb` function (or equivalent schema initialization section) and add these three `CREATE TABLE IF NOT EXISTS` statements after the existing table definitions:

```sql
    CREATE TABLE IF NOT EXISTS task_detail_state (
      task_id TEXT PRIMARY KEY,
      group_jid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      title TEXT NOT NULL,
      steps_json TEXT NOT NULL DEFAULT '[]',
      log_json TEXT NOT NULL DEFAULT '[]',
      findings_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
```

```sql
    CREATE TABLE IF NOT EXISTS acted_emails (
      email_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      account TEXT NOT NULL,
      action_taken TEXT NOT NULL,
      acted_at TEXT NOT NULL,
      archived_at TEXT,
      PRIMARY KEY (email_id, action_taken)
    )
```

```sql
    CREATE TABLE IF NOT EXISTS draft_originals (
      draft_id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      original_body TEXT NOT NULL,
      enriched_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
```

- [ ] **Step 4: Run existing DB tests to verify no regression**

Run: `npx vitest run src/__tests__/db.test.ts src/db.test.ts`
Expected: PASS — existing tests unaffected

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/__tests__/agentic-ux-db.test.ts
git commit -m "feat(ux): add task_detail_state, acted_emails, draft_originals DB tables"
```

---

### Task 7: Telegram Channel Extensions

**Files:**
- Modify: `src/channels/telegram.ts`
- Test: `src/channels/telegram.test.ts` (add new tests)

- [ ] **Step 1: Write tests for new Telegram methods**

Add to `src/channels/telegram.test.ts` (or create a new file `src/__tests__/telegram-agentic.test.ts`):

```typescript
// src/__tests__/telegram-agentic.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('Telegram agentic UX extensions', () => {
  it('editMessageButtons replaces inline keyboard on existing message', async () => {
    // Test that editMessageReplyMarkup is called with correct args
    const mockApi = {
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    };

    const chatId = '123456';
    const messageId = 789;
    const newActions = [
      { label: '✓ Archived', callbackData: 'noop' },
    ];

    const keyboard = {
      inline_keyboard: [
        newActions.map((a) => ({ text: a.label, callback_data: a.callbackData })),
      ],
    };

    await mockApi.editMessageReplyMarkup(chatId, messageId, { reply_markup: keyboard });
    expect(mockApi.editMessageReplyMarkup).toHaveBeenCalledWith(
      chatId, messageId, { reply_markup: keyboard },
    );
  });

  it('builds web_app keyboard with Mini App URL', () => {
    const webAppUrl = 'https://nanoclaw.example.com/task/abc123';
    const keyboard = {
      inline_keyboard: [
        [{ text: 'View Details ↗', web_app: { url: webAppUrl } }],
      ],
    };
    expect(keyboard.inline_keyboard[0][0].web_app.url).toBe(webAppUrl);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (mocked)**

Run: `npx vitest run src/__tests__/telegram-agentic.test.ts`
Expected: PASS

- [ ] **Step 3: Add `editMessageButtons` and `sendMessageWithWebApp` to TelegramChannel**

Add these methods to the `TelegramChannel` class in `src/channels/telegram.ts`:

```typescript
  /**
   * Replace the inline keyboard on an existing message.
   * Used for two-step confirm flow and post-action button replacement.
   */
  async editMessageButtons(
    jid: string,
    messageId: number,
    actions: Action[],
  ): Promise<void> {
    if (!this.bot) return;
    const chatId = jid.replace(/^tg:/, '');
    const keyboard = {
      inline_keyboard: [
        actions.map((a) => ({
          text: a.label,
          ...(a.webAppUrl
            ? { web_app: { url: a.webAppUrl } }
            : { callback_data: a.callbackData }),
        })),
      ],
    };
    try {
      await this.bot.api.editMessageReplyMarkup(chatId, messageId, {
        reply_markup: keyboard,
      });
    } catch (err) {
      logger.debug({ jid, messageId, err }, 'Failed to edit message buttons');
    }
  }

  /**
   * Edit an existing message's text and optionally its buttons.
   * Used for post-action state transitions (e.g., "✓ Archived").
   */
  async editMessageTextAndButtons(
    jid: string,
    messageId: number,
    text: string,
    actions?: Action[],
  ): Promise<void> {
    if (!this.bot) return;
    const chatId = jid.replace(/^tg:/, '');
    const opts: Record<string, unknown> = { parse_mode: 'HTML' };
    if (actions) {
      opts.reply_markup = {
        inline_keyboard: [
          actions.map((a) => ({
            text: a.label,
            ...(a.webAppUrl
              ? { web_app: { url: a.webAppUrl } }
              : { callback_data: a.callbackData }),
          })),
        ],
      };
    }
    try {
      await this.bot.api.editMessageText(chatId, messageId, text, opts);
    } catch (err) {
      logger.debug({ jid, messageId, err }, 'Failed to edit message text and buttons');
    }
  }
```

- [ ] **Step 4: Run existing Telegram tests to verify no regression**

Run: `npx vitest run src/channels/telegram.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/telegram.ts src/__tests__/telegram-agentic.test.ts
git commit -m "feat(ux): add editMessageButtons and editMessageTextAndButtons to Telegram channel"
```

---

### Task 8: Router Pipeline Integration

**Files:**
- Modify: `src/router.ts`
- Test: `src/router.test.ts` (add new tests)

- [ ] **Step 1: Write pipeline integration tests**

Add to `src/router.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyAndFormat } from '../router.js';

describe('classifyAndFormat', () => {
  it('classifies and formats a financial message', () => {
    const result = classifyAndFormat(
      'Chase — 2 incoming wires. Total: $54,900. Were both expected?',
    );
    expect(result.meta.category).toBe('financial');
    expect(result.text).toContain('💰');
    expect(result.meta.actions.length).toBeGreaterThan(0); // question detected
    expect(result.meta.questionType).toBe('financial-confirm');
  });

  it('classifies and formats an auto-handled message', () => {
    const result = classifyAndFormat(
      'Motley Fool newsletter — AUTO, no action.',
    );
    expect(result.meta.category).toBe('auto-handled');
    expect(result.meta.batchable).toBe(true);
    expect(result.text).toContain('Auto-handled');
  });

  it('attaches yes/no buttons to questions', () => {
    const result = classifyAndFormat(
      'Want me to reply yes to Florian\'s exception?',
    );
    expect(result.meta.questionType).toBe('yes-no');
    expect(result.meta.actions).toHaveLength(3);
  });

  it('passes through non-question messages without buttons', () => {
    const result = classifyAndFormat(
      'Dmitrii acknowledged request #WANF-864. No action needed.',
    );
    expect(result.meta.questionType).toBeUndefined();
    expect(result.meta.actions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/router.test.ts`
Expected: FAIL — `classifyAndFormat` not exported

- [ ] **Step 3: Add `classifyAndFormat` to `src/router.ts`**

Add imports and the new function:

```typescript
import { classifyMessage } from './message-classifier.js';
import { formatWithMeta } from './message-formatter.js';
import { detectQuestion } from './question-detector.js';
import type { MessageMeta } from './types.js';

export interface ClassifiedMessage {
  text: string;
  meta: MessageMeta;
}

/**
 * Full classification + formatting pipeline.
 * Classifies the message, detects questions, formats with category prefix.
 */
export function classifyAndFormat(rawText: string): ClassifiedMessage {
  const text = stripInternalTags(rawText);
  if (!text) return { text: '', meta: { category: 'auto-handled', urgency: 'info', actions: [], batchable: true } };

  const meta = classifyMessage(text);

  // Detect questions and attach buttons
  const question = detectQuestion(text);
  if (question) {
    meta.questionType = question.type;
    meta.questionId = question.questionId;
    meta.actions = [...meta.actions, ...question.actions];
  }

  const formatted = formatWithMeta(text, meta);
  return { text: formatted, meta };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/router.test.ts
git commit -m "feat(ux): wire classifier + formatter + question detector into router pipeline"
```

---

### Task 9: Status Bar Manager

**Files:**
- Create: `src/status-bar.ts`
- Test: `src/__tests__/status-bar.test.ts`

- [ ] **Step 1: Write status bar tests**

```typescript
// src/__tests__/status-bar.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StatusBarManager } from '../status-bar.js';
import { EventBus } from '../event-bus.js';
import type { TaskStartedEvent, TaskCompleteEvent } from '../events.js';

describe('StatusBarManager', () => {
  let bus: EventBus;
  let manager: StatusBarManager;
  let lastUpdate: string | null;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus();
    lastUpdate = null;
    manager = new StatusBarManager(bus, {
      onUpdate: (text) => { lastUpdate = text; },
    });
  });

  afterEach(() => {
    manager.destroy();
    bus.removeAllListeners();
    vi.useRealTimers();
  });

  it('updates when a task starts', () => {
    bus.emit('task.started', {
      type: 'task.started',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        taskId: 't1',
        groupJid: 'tg:123',
        containerName: 'c1',
        slotIndex: 0,
      },
    } as TaskStartedEvent);

    // Debounce
    vi.advanceTimersByTime(2000);
    expect(lastUpdate).not.toBeNull();
    expect(lastUpdate).toContain('ACTIVE');
  });

  it('removes task on completion', () => {
    bus.emit('task.started', {
      type: 'task.started',
      source: 'executor',
      timestamp: Date.now(),
      payload: { taskId: 't1', groupJid: 'tg:123', containerName: 'c1', slotIndex: 0 },
    } as TaskStartedEvent);

    bus.emit('task.complete', {
      type: 'task.complete',
      source: 'executor',
      timestamp: Date.now(),
      payload: { taskId: 't1', groupJid: 'tg:123', status: 'success', durationMs: 5000 },
    } as TaskCompleteEvent);

    vi.advanceTimersByTime(2000);
    expect(lastUpdate).not.toContain('t1');
  });

  it('tracks daily auto-handled count', () => {
    manager.incrementAutoHandled();
    manager.incrementAutoHandled();
    manager.incrementAutoHandled();

    vi.advanceTimersByTime(2000);
    expect(lastUpdate).toContain('3');
  });

  it('debounces rapid updates', () => {
    const onUpdate = vi.fn();
    manager.destroy();
    manager = new StatusBarManager(bus, { onUpdate });

    for (let i = 0; i < 10; i++) {
      manager.incrementAutoHandled();
    }

    vi.advanceTimersByTime(2000);
    // Should have called onUpdate only once despite 10 increments
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/status-bar.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement StatusBarManager**

```typescript
// src/status-bar.ts
import type { EventBus } from './event-bus.js';

interface ActiveTask {
  taskId: string;
  groupJid: string;
  label: string;
  startedAt: number;
}

interface PendingItem {
  id: string;
  label: string;
  addedAt: number;
}

interface StatusBarOpts {
  onUpdate: (text: string) => void;
  debounceMs?: number;
}

export class StatusBarManager {
  private activeTasks = new Map<string, ActiveTask>();
  private pendingItems = new Map<string, PendingItem>();
  private autoHandledCount = 0;
  private draftsEnrichedCount = 0;
  private blockedCount = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private opts: Required<StatusBarOpts>;
  private unsubscribers: Array<() => void> = [];

  constructor(bus: EventBus, opts: StatusBarOpts) {
    this.opts = { debounceMs: 2000, ...opts };

    this.unsubscribers.push(
      bus.on('task.started', (e) => {
        this.activeTasks.set(e.payload.taskId, {
          taskId: e.payload.taskId,
          groupJid: e.payload.groupJid,
          label: e.payload.containerName,
          startedAt: e.timestamp,
        });
        this.scheduleUpdate();
      }),
    );

    this.unsubscribers.push(
      bus.on('task.progress', (e) => {
        const task = this.activeTasks.get(e.payload.taskId);
        if (task) {
          task.label = e.payload.label;
          this.scheduleUpdate();
        }
      }),
    );

    this.unsubscribers.push(
      bus.on('task.complete', (e) => {
        this.activeTasks.delete(e.payload.taskId);
        if (e.payload.status === 'error') {
          this.blockedCount++;
        }
        this.scheduleUpdate();
      }),
    );
  }

  addPendingItem(id: string, label: string): void {
    this.pendingItems.set(id, { id, label, addedAt: Date.now() });
    this.scheduleUpdate();
  }

  removePendingItem(id: string): void {
    this.pendingItems.delete(id);
    this.scheduleUpdate();
  }

  incrementAutoHandled(): void {
    this.autoHandledCount++;
    this.scheduleUpdate();
  }

  incrementDraftsEnriched(): void {
    this.draftsEnrichedCount++;
    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.render(), this.opts.debounceMs);
  }

  private render(): void {
    const lines: string[] = [];
    lines.push(`<b>NANOCLAW STATUS</b>`);
    lines.push('─'.repeat(20));

    // Active tasks
    if (this.activeTasks.size > 0) {
      lines.push(`<b>ACTIVE (${this.activeTasks.size})</b>`);
      for (const task of this.activeTasks.values()) {
        lines.push(`● ${task.label}`);
      }
    }

    // Pending items
    if (this.pendingItems.size > 0) {
      lines.push('');
      lines.push(`<b>NEEDS YOU (${this.pendingItems.size})</b>`);
      for (const item of this.pendingItems.values()) {
        lines.push(item.label);
      }
    }

    // Daily stats
    const stats: string[] = [];
    if (this.autoHandledCount > 0) stats.push(`${this.autoHandledCount} auto-handled`);
    if (this.draftsEnrichedCount > 0) stats.push(`${this.draftsEnrichedCount} drafts enriched`);
    if (this.pendingItems.size > 0) stats.push(`${this.pendingItems.size} needs you`);
    if (this.blockedCount > 0) stats.push(`${this.blockedCount} blocked`);

    if (stats.length > 0) {
      lines.push('');
      lines.push(`TODAY: ${stats.join(' · ')}`);
    }

    this.opts.onUpdate(lines.join('\n'));
  }

  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/status-bar.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/status-bar.ts src/__tests__/status-bar.test.ts
git commit -m "feat(ux): add StatusBarManager with debounced event-driven updates"
```

---

### Task 10: Auto-Approval Timer

**Files:**
- Create: `src/auto-approval.ts`
- Test: `src/__tests__/auto-approval.test.ts`

- [ ] **Step 1: Write auto-approval tests**

```typescript
// src/__tests__/auto-approval.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutoApprovalTimer } from '../auto-approval.js';
import { EventBus } from '../event-bus.js';

describe('AutoApprovalTimer', () => {
  let bus: EventBus;
  let timer: AutoApprovalTimer;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus();
    timer = new AutoApprovalTimer(bus);
  });

  afterEach(() => {
    timer.destroy();
    bus.removeAllListeners();
    vi.useRealTimers();
  });

  it('emits plan.auto_approved after timeout', () => {
    const handler = vi.fn();
    bus.on('plan.auto_approved', handler);

    timer.start('task-1', 15 * 60 * 1000); // 15 min

    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plan.auto_approved',
        payload: { taskId: 'task-1' },
      }),
    );
  });

  it('emits plan.cancelled when cancelled', () => {
    const approvedHandler = vi.fn();
    const cancelledHandler = vi.fn();
    bus.on('plan.auto_approved', approvedHandler);
    bus.on('plan.cancelled', cancelledHandler);

    timer.start('task-1', 15 * 60 * 1000);
    timer.cancel('task-1');

    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(approvedHandler).not.toHaveBeenCalled();
    expect(cancelledHandler).toHaveBeenCalledTimes(1);
  });

  it('reports remaining time', () => {
    timer.start('task-1', 15 * 60 * 1000);

    vi.advanceTimersByTime(5 * 60 * 1000);
    const remaining = timer.getRemainingMs('task-1');
    expect(remaining).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(remaining).toBeGreaterThan(9 * 60 * 1000);
  });

  it('returns null for unknown task', () => {
    expect(timer.getRemainingMs('nonexistent')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/auto-approval.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AutoApprovalTimer**

```typescript
// src/auto-approval.ts
import type { EventBus } from './event-bus.js';
import type { PlanAutoApprovedEvent, PlanCancelledEvent } from './events.js';

interface TimerEntry {
  taskId: string;
  handle: ReturnType<typeof setTimeout>;
  expiresAt: number;
}

export class AutoApprovalTimer {
  private timers = new Map<string, TimerEntry>();
  private bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  start(taskId: string, durationMs: number): void {
    // Cancel existing timer for this task if any
    this.cancel(taskId);

    const expiresAt = Date.now() + durationMs;
    const handle = setTimeout(() => {
      this.timers.delete(taskId);
      this.bus.emit('plan.auto_approved', {
        type: 'plan.auto_approved',
        source: 'auto-approval',
        timestamp: Date.now(),
        payload: { taskId },
      } as PlanAutoApprovedEvent);
    }, durationMs);

    this.timers.set(taskId, { taskId, handle, expiresAt });
  }

  cancel(taskId: string): void {
    const entry = this.timers.get(taskId);
    if (entry) {
      clearTimeout(entry.handle);
      this.timers.delete(taskId);
      this.bus.emit('plan.cancelled', {
        type: 'plan.cancelled',
        source: 'auto-approval',
        timestamp: Date.now(),
        payload: { taskId },
      } as PlanCancelledEvent);
    }
  }

  getRemainingMs(taskId: string): number | null {
    const entry = this.timers.get(taskId);
    if (!entry) return null;
    return Math.max(0, entry.expiresAt - Date.now());
  }

  destroy(): void {
    for (const entry of this.timers.values()) {
      clearTimeout(entry.handle);
    }
    this.timers.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/auto-approval.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auto-approval.ts src/__tests__/auto-approval.test.ts
git commit -m "feat(ux): add AutoApprovalTimer with silence-means-approval countdown"
```

---

### Task 11: Failure Escalator

**Files:**
- Create: `src/failure-escalator.ts`
- Test: `src/__tests__/failure-escalator.test.ts`

- [ ] **Step 1: Write failure escalator tests**

```typescript
// src/__tests__/failure-escalator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FailureEscalator } from '../failure-escalator.js';
import { EventBus } from '../event-bus.js';
import type { TaskCompleteEvent } from '../events.js';

describe('FailureEscalator', () => {
  let bus: EventBus;
  let escalator: FailureEscalator;
  let lastEscalation: { text: string; actions: Array<{ label: string }> } | null;

  beforeEach(() => {
    bus = new EventBus();
    lastEscalation = null;
    escalator = new FailureEscalator(bus, {
      onEscalate: (text, actions) => { lastEscalation = { text, actions }; },
    });
  });

  afterEach(() => {
    escalator.destroy();
    bus.removeAllListeners();
  });

  it('escalates on task error', () => {
    bus.emit('task.complete', {
      type: 'task.complete',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        taskId: 't1',
        groupJid: 'tg:123',
        status: 'error',
        durationMs: 3000,
      },
    } as TaskCompleteEvent);

    expect(lastEscalation).not.toBeNull();
    expect(lastEscalation!.text).toContain('🚨');
    expect(lastEscalation!.text).toContain('failed');
    expect(lastEscalation!.actions.length).toBeGreaterThan(0);
  });

  it('does not escalate on success', () => {
    bus.emit('task.complete', {
      type: 'task.complete',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        taskId: 't1',
        groupJid: 'tg:123',
        status: 'success',
        durationMs: 3000,
      },
    } as TaskCompleteEvent);

    expect(lastEscalation).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/failure-escalator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement FailureEscalator**

```typescript
// src/failure-escalator.ts
import type { EventBus } from './event-bus.js';
import type { Action } from './types.js';

interface FailureEscalatorOpts {
  onEscalate: (text: string, actions: Action[]) => void;
}

export class FailureEscalator {
  private unsubscribers: Array<() => void> = [];

  constructor(bus: EventBus, opts: FailureEscalatorOpts) {
    this.unsubscribers.push(
      bus.on('task.complete', (e) => {
        if (e.payload.status !== 'error') return;

        const text = [
          '🚨 <b>Background · failed</b>',
          '',
          `Task <b>${e.payload.taskId}</b> failed after ${Math.round(e.payload.durationMs / 1000)}s.`,
        ].join('\n');

        const actions: Action[] = [
          { label: 'Retry', callbackData: `retry:${e.payload.taskId}`, style: 'primary' },
          { label: 'View Details ↗', callbackData: `details:${e.payload.taskId}`, style: 'secondary' },
          { label: 'Dismiss', callbackData: `dismiss:${e.payload.taskId}`, style: 'secondary' },
        ];

        opts.onEscalate(text, actions);
      }),
    );
  }

  destroy(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/failure-escalator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/failure-escalator.ts src/__tests__/failure-escalator.test.ts
git commit -m "feat(ux): add FailureEscalator for loud failure notifications with retry buttons"
```

---

### Task 12: Archive Tracker

**Files:**
- Create: `src/archive-tracker.ts`
- Test: `src/__tests__/archive-tracker.test.ts`

- [ ] **Step 1: Write archive tracker tests**

```typescript
// src/__tests__/archive-tracker.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ArchiveTracker } from '../archive-tracker.js';

describe('ArchiveTracker', () => {
  let db: Database.Database;
  let tracker: ArchiveTracker;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS acted_emails (
        email_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        account TEXT NOT NULL,
        action_taken TEXT NOT NULL,
        acted_at TEXT NOT NULL,
        archived_at TEXT,
        PRIMARY KEY (email_id, action_taken)
      )
    `);
    tracker = new ArchiveTracker(db);
  });

  it('records an acted email', () => {
    tracker.recordAction('msg_1', 'thread_1', 'personal', 'confirmed');
    const pending = tracker.getUnarchived();
    expect(pending).toHaveLength(1);
    expect(pending[0].email_id).toBe('msg_1');
  });

  it('marks email as archived', () => {
    tracker.recordAction('msg_1', 'thread_1', 'personal', 'confirmed');
    tracker.markArchived('msg_1', 'confirmed');
    const pending = tracker.getUnarchived();
    expect(pending).toHaveLength(0);
  });

  it('returns only unarchived emails', () => {
    tracker.recordAction('msg_1', 'thread_1', 'personal', 'confirmed');
    tracker.recordAction('msg_2', 'thread_2', 'dev', 'replied');
    tracker.markArchived('msg_1', 'confirmed');

    const pending = tracker.getUnarchived();
    expect(pending).toHaveLength(1);
    expect(pending[0].email_id).toBe('msg_2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/archive-tracker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ArchiveTracker**

```typescript
// src/archive-tracker.ts
import type Database from 'better-sqlite3';

export interface ActedEmail {
  email_id: string;
  thread_id: string;
  account: string;
  action_taken: string;
  acted_at: string;
  archived_at: string | null;
}

export class ArchiveTracker {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  recordAction(
    emailId: string,
    threadId: string,
    account: string,
    actionTaken: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO acted_emails
         (email_id, thread_id, account, action_taken, acted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(emailId, threadId, account, actionTaken, new Date().toISOString());
  }

  markArchived(emailId: string, actionTaken: string): void {
    this.db
      .prepare(
        `UPDATE acted_emails SET archived_at = ? WHERE email_id = ? AND action_taken = ?`,
      )
      .run(new Date().toISOString(), emailId, actionTaken);
  }

  getUnarchived(): ActedEmail[] {
    return this.db
      .prepare(`SELECT * FROM acted_emails WHERE archived_at IS NULL ORDER BY acted_at DESC`)
      .all() as ActedEmail[];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/archive-tracker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/archive-tracker.ts src/__tests__/archive-tracker.test.ts
git commit -m "feat(ux): add ArchiveTracker for post-action email archive flow"
```

---

### Task 13: Mini App Server

**Files:**
- Create: `src/mini-app/server.ts`
- Create: `src/mini-app/templates/task-detail.ts`
- Create: `src/mini-app/templates/email-full.ts`
- Test: `src/__tests__/mini-app-server.test.ts`

- [ ] **Step 1: Write Mini App server tests**

```typescript
// src/__tests__/mini-app-server.test.ts
import { describe, it, expect } from 'vitest';
import { renderTaskDetail } from '../mini-app/templates/task-detail.js';
import { renderEmailFull } from '../mini-app/templates/email-full.js';

describe('Mini App templates', () => {
  it('renders task detail HTML', () => {
    const html = renderTaskDetail({
      taskId: 't1',
      title: 'Spamhaus Investigation',
      status: 'active',
      steps: [
        { label: 'Check listing', status: 'done', output: 'CBL confirmed' },
        { label: 'Port scan', status: 'active', output: 'Scanning...' },
        { label: 'Request delisting', status: 'pending', output: null },
      ],
      logs: [
        { time: '12:03:41', level: 'success', text: 'Spamhaus lookup complete' },
        { time: '12:03:42', level: 'info', text: 'Starting port scan' },
      ],
      startedAt: new Date().toISOString(),
    });

    expect(html).toContain('Spamhaus Investigation');
    expect(html).toContain('Check listing');
    expect(html).toContain('Port scan');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('renders full email HTML', () => {
    const html = renderEmailFull({
      from: 'Alexandre <alexandre@whoisxmlapi.com>',
      to: 'jonathan@example.com',
      subject: 'AdWords update',
      date: '2026-04-16 5:25 AM PT',
      body: '<p>Hi Jonathan, quick update on AdWords...</p>',
      attachments: [],
    });

    expect(html).toContain('AdWords update');
    expect(html).toContain('Alexandre');
    expect(html).toContain('<!DOCTYPE html>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/mini-app-server.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Create task detail template**

```typescript
// src/mini-app/templates/task-detail.ts

export interface TaskStep {
  label: string;
  status: 'done' | 'active' | 'pending';
  output: string | null;
}

export interface TaskLog {
  time: string;
  level: 'success' | 'error' | 'info' | 'warn';
  text: string;
}

export interface TaskDetailData {
  taskId: string;
  title: string;
  status: 'active' | 'blocked' | 'complete';
  steps: TaskStep[];
  logs: TaskLog[];
  startedAt: string;
  findings?: string[];
}

const LEVEL_COLORS: Record<string, string> = {
  success: '#3fb950',
  error: '#f85149',
  info: '#58a6ff',
  warn: '#f0883e',
};

const STATUS_ICONS: Record<string, string> = {
  done: '✓',
  active: '●',
  pending: '○',
};

export function renderTaskDetail(data: TaskDetailData): string {
  const stepsHtml = data.steps
    .map((s) => {
      const icon = STATUS_ICONS[s.status] || '○';
      const outputBlock = s.output
        ? `<div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:8px;margin-top:4px;font-family:monospace;font-size:11px;color:#8b949e;">${escapeHtml(s.output)}</div>`
        : '';
      return `<div style="display:flex;gap:12px;margin-bottom:14px;"><div style="flex-shrink:0;font-size:14px;">${icon}</div><div><div style="font-size:14px;color:#c9d1d9;">${escapeHtml(s.label)}</div>${outputBlock}</div></div>`;
    })
    .join('');

  const logsHtml = data.logs
    .map((l) => {
      const color = LEVEL_COLORS[l.level] || '#8b949e';
      return `<div><span style="color:#484f58;">${escapeHtml(l.time)}</span> <span style="color:${color};">●</span> ${escapeHtml(l.text)}</div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(data.title)}</title>
  <style>
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 16px; }
    .header { border-bottom: 1px solid #21262d; padding-bottom: 12px; margin-bottom: 16px; }
    .title { font-size: 18px; font-weight: 600; }
    .status { font-size: 12px; color: #f0883e; text-transform: uppercase; margin-bottom: 4px; }
    .logs { background: #0d1117; border: 1px solid #21262d; border-radius: 8px; padding: 12px; font-family: monospace; font-size: 11px; line-height: 1.6; max-height: 200px; overflow-y: auto; }
    .actions { border-top: 1px solid #21262d; padding-top: 12px; margin-top: 16px; display: flex; gap: 8px; }
    .btn { background: #21262d; color: #c9d1d9; padding: 8px 16px; border-radius: 6px; border: none; font-size: 13px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="header">
    <div class="status">${data.status.toUpperCase()}</div>
    <div class="title">${escapeHtml(data.title)}</div>
  </div>
  <div style="margin-bottom:16px;">${stepsHtml}</div>
  <div class="logs">${logsHtml}</div>
  <div class="actions">
    <button class="btn">Pause</button>
    <button class="btn" style="color:#f85149;">Abort</button>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

- [ ] **Step 4: Create email full template**

```typescript
// src/mini-app/templates/email-full.ts

export interface EmailFullData {
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  attachments: Array<{ name: string; size: string }>;
  cc?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderEmailFull(data: EmailFullData): string {
  const attachmentsHtml = data.attachments.length > 0
    ? `<div style="border-top:1px solid #21262d;padding-top:12px;margin-top:12px;"><div style="font-size:11px;color:#484f58;margin-bottom:8px;">ATTACHMENTS</div>${data.attachments.map((a) => `<div style="font-size:13px;color:#58a6ff;">📎 ${escapeHtml(a.name)} (${escapeHtml(a.size)})</div>`).join('')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(data.subject)}</title>
  <style>
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 16px; }
    .header { border-bottom: 1px solid #21262d; padding-bottom: 12px; margin-bottom: 16px; }
    .subject { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    .meta { font-size: 12px; color: #8b949e; line-height: 1.6; }
    .body { font-size: 14px; line-height: 1.6; }
    .actions { border-top: 1px solid #21262d; padding-top: 12px; margin-top: 16px; display: flex; gap: 8px; }
    .btn { background: #21262d; color: #c9d1d9; padding: 8px 16px; border-radius: 6px; border: none; font-size: 13px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="header">
    <div class="subject">${escapeHtml(data.subject)}</div>
    <div class="meta">
      <div><b>From:</b> ${escapeHtml(data.from)}</div>
      <div><b>To:</b> ${escapeHtml(data.to)}</div>
      ${data.cc ? `<div><b>CC:</b> ${escapeHtml(data.cc)}</div>` : ''}
      <div><b>Date:</b> ${escapeHtml(data.date)}</div>
    </div>
  </div>
  <div class="body">${data.body}</div>
  ${attachmentsHtml}
  <div class="actions">
    <button class="btn" style="background:#276749;color:#c6f6d5;">Archive</button>
    <button class="btn">Open in Gmail</button>
  </div>
</body>
</html>`;
}
```

- [ ] **Step 5: Create Express server**

```typescript
// src/mini-app/server.ts
import express from 'express';
import type Database from 'better-sqlite3';
import { renderTaskDetail } from './templates/task-detail.js';
import { logger } from '../logger.js';
import type { TaskStep, TaskLog } from './templates/task-detail.js';

export interface MiniAppServerOpts {
  port: number;
  db: Database.Database;
}

export function createMiniAppServer(opts: MiniAppServerOpts): express.Express {
  const app = express();

  app.get('/task/:taskId', (req, res) => {
    const { taskId } = req.params;
    const row = opts.db
      .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
      .get(taskId) as Record<string, string> | undefined;

    if (!row) {
      res.status(404).send('Task not found');
      return;
    }

    const html = renderTaskDetail({
      taskId: row.task_id,
      title: row.title,
      status: row.status as 'active' | 'blocked' | 'complete',
      steps: JSON.parse(row.steps_json) as TaskStep[],
      logs: JSON.parse(row.log_json) as TaskLog[],
      startedAt: row.started_at,
    });

    res.type('html').send(html);
  });

  app.get('/api/task/:taskId/state', (req, res) => {
    const { taskId } = req.params;
    const row = opts.db
      .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
      .get(taskId);

    if (!row) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    res.json(row);
  });

  return app;
}

export function startMiniAppServer(opts: MiniAppServerOpts): void {
  const app = createMiniAppServer(opts);
  app.listen(opts.port, () => {
    logger.info({ port: opts.port }, 'Mini App server started');
  });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/mini-app-server.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/mini-app/server.ts src/mini-app/templates/task-detail.ts src/mini-app/templates/email-full.ts src/__tests__/mini-app-server.test.ts
git commit -m "feat(ux): add Mini App Express server with task detail and email templates"
```

---

### Task 14: Email Preview (Gmail Fetch + Cache)

**Files:**
- Create: `src/email-preview.ts`
- Test: `src/__tests__/email-preview.test.ts`

- [ ] **Step 1: Write email preview tests**

```typescript
// src/__tests__/email-preview.test.ts
import { describe, it, expect } from 'vitest';
import { truncatePreview } from '../email-preview.js';

describe('truncatePreview', () => {
  it('returns full text if under limit', () => {
    const text = 'Short email body.';
    expect(truncatePreview(text, 500)).toBe(text);
  });

  it('truncates at word boundary', () => {
    const text = 'word '.repeat(200); // 1000 chars
    const preview = truncatePreview(text, 500);
    expect(preview.length).toBeLessThanOrEqual(550); // some slack for suffix
    expect(preview).toContain('— truncated');
    expect(preview).not.toMatch(/\s— truncated/); // no trailing space before truncation marker
  });

  it('handles text with no spaces', () => {
    const text = 'a'.repeat(600);
    const preview = truncatePreview(text, 500);
    expect(preview.length).toBeLessThanOrEqual(550);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/email-preview.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement email preview**

```typescript
// src/email-preview.ts

/**
 * In-memory cache for fetched email bodies.
 * Key: emailId, Value: { body, fetchedAt }
 */
const emailCache = new Map<string, { body: string; fetchedAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Truncate email body for inline preview.
 * Breaks at word boundary, appends truncation marker.
 */
export function truncatePreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  let cutoff = text.lastIndexOf(' ', maxChars);
  if (cutoff === -1) cutoff = maxChars;

  return text.slice(0, cutoff).trimEnd() + '\n\n— truncated, tap "Full Email" for complete message —';
}

/**
 * Get email body from cache, or return null if not cached / expired.
 */
export function getCachedEmailBody(emailId: string): string | null {
  const entry = emailCache.get(emailId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    emailCache.delete(emailId);
    return null;
  }
  return entry.body;
}

/**
 * Store email body in cache.
 */
export function cacheEmailBody(emailId: string, body: string): void {
  emailCache.set(emailId, { body, fetchedAt: Date.now() });
}

/**
 * Clear expired entries from cache.
 */
export function cleanupCache(): void {
  const now = Date.now();
  for (const [id, entry] of emailCache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS) {
      emailCache.delete(id);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/email-preview.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/email-preview.ts src/__tests__/email-preview.test.ts
git commit -m "feat(ux): add email preview with truncation and in-memory body cache"
```

---

### Task 15: Callback Handler & Wiring

**Files:**
- Modify: `src/index.ts` — initialize all new components at startup
- Create: `src/callback-router.ts` — routes callback queries to appropriate handlers

- [ ] **Step 1: Create callback router**

```typescript
// src/callback-router.ts
import type { CallbackQuery, Channel, Action } from './types.js';
import type { ArchiveTracker } from './archive-tracker.js';
import type { AutoApprovalTimer } from './auto-approval.js';
import type { StatusBarManager } from './status-bar.js';
import { logger } from './logger.js';

export interface CallbackRouterDeps {
  archiveTracker: ArchiveTracker;
  autoApproval: AutoApprovalTimer;
  statusBar: StatusBarManager;
  findChannel: (jid: string) => Channel | undefined;
}

/**
 * Route callback queries from inline buttons to the appropriate handler.
 * Callback data format: "action:entityId" or "action:entityId:extra"
 */
export function handleCallback(
  query: CallbackQuery,
  deps: CallbackRouterDeps,
): void {
  const parts = query.data.split(':');
  const action = parts[0];
  const entityId = parts[1] || '';

  logger.debug({ action, entityId, chatJid: query.chatJid }, 'Callback query received');

  switch (action) {
    case 'archive':
      // Two-step: first tap shows confirm, second tap archives
      // The confirm step is handled by editMessageButtons in the Telegram channel
      break;

    case 'confirm_archive':
      deps.archiveTracker.markArchived(entityId, 'archived');
      break;

    case 'answer': {
      const questionId = entityId;
      const answer = parts[2] || '';
      if (answer === 'defer') {
        // Snooze — keep in pending items
        logger.info({ questionId }, 'Answer deferred');
      } else {
        // Remove from pending
        deps.statusBar.removePendingItem(questionId);
      }
      break;
    }

    case 'stop':
      deps.autoApproval.cancel(entityId);
      break;

    case 'dismiss':
      deps.statusBar.removePendingItem(entityId);
      break;

    default:
      logger.warn({ action, data: query.data }, 'Unknown callback action');
  }
}
```

- [ ] **Step 2: Write integration test**

```typescript
// src/__tests__/callback-router.test.ts
import { describe, it, expect, vi } from 'vitest';
import { handleCallback } from '../callback-router.js';

describe('handleCallback', () => {
  const mockDeps = {
    archiveTracker: { markArchived: vi.fn(), recordAction: vi.fn(), getUnarchived: vi.fn() },
    autoApproval: { cancel: vi.fn(), start: vi.fn(), getRemainingMs: vi.fn(), destroy: vi.fn() },
    statusBar: { removePendingItem: vi.fn(), addPendingItem: vi.fn(), incrementAutoHandled: vi.fn(), incrementDraftsEnriched: vi.fn(), destroy: vi.fn() },
    findChannel: vi.fn(),
  };

  it('routes stop to autoApproval.cancel', () => {
    handleCallback(
      { id: '1', chatJid: 'tg:123', messageId: 1, data: 'stop:task-1', senderName: 'Jon' },
      mockDeps as any,
    );
    expect(mockDeps.autoApproval.cancel).toHaveBeenCalledWith('task-1');
  });

  it('routes confirm_archive to archiveTracker', () => {
    handleCallback(
      { id: '2', chatJid: 'tg:123', messageId: 2, data: 'confirm_archive:msg_1', senderName: 'Jon' },
      mockDeps as any,
    );
    expect(mockDeps.archiveTracker.markArchived).toHaveBeenCalledWith('msg_1', 'archived');
  });

  it('routes answer:defer to keep pending', () => {
    handleCallback(
      { id: '3', chatJid: 'tg:123', messageId: 3, data: 'answer:q_1:defer', senderName: 'Jon' },
      mockDeps as any,
    );
    expect(mockDeps.statusBar.removePendingItem).not.toHaveBeenCalled();
  });

  it('routes answer:yes to remove pending', () => {
    handleCallback(
      { id: '4', chatJid: 'tg:123', messageId: 4, data: 'answer:q_1:yes', senderName: 'Jon' },
      mockDeps as any,
    );
    expect(mockDeps.statusBar.removePendingItem).toHaveBeenCalledWith('q_1');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/__tests__/callback-router.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/callback-router.ts src/__tests__/callback-router.test.ts
git commit -m "feat(ux): add callback router for inline button dispatch"
```

---

### Task 16: Startup Wiring in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports and initialization**

Add to the imports section of `src/index.ts`:

```typescript
import { StatusBarManager } from './status-bar.js';
import { AutoApprovalTimer } from './auto-approval.js';
import { FailureEscalator } from './failure-escalator.js';
import { ArchiveTracker } from './archive-tracker.js';
import { MessageBatcher } from './message-batcher.js';
import { handleCallback } from './callback-router.js';
import { classifyAndFormat } from './router.js';
import { formatBatch } from './message-formatter.js';
import { startMiniAppServer } from './mini-app/server.js';
```

Add to the startup function, after the DB is initialized and channels are connected:

```typescript
// --- Agentic UX initialization ---

const archiveTracker = new ArchiveTracker(db);
const autoApproval = new AutoApprovalTimer(eventBus);

// Status bar — sends/edits a pinned message in the main group
const mainGroup = Object.values(registeredGroups).find((g) => g.isMain);
const statusBar = new StatusBarManager(eventBus, {
  onUpdate: (text) => {
    if (mainGroup) {
      const mainJid = mainGroup.folder; // or derive JID from group
      const channel = channels.find((c) => c.ownsJid(mainJid));
      // Use sendProgress for edit-in-place, or sendMessage for new
      channel?.sendMessage(mainJid, text).catch(() => {});
    }
  },
});

// Failure escalator
const _failureEscalator = new FailureEscalator(eventBus, {
  onEscalate: (text, actions) => {
    if (mainGroup) {
      const mainJid = mainGroup.folder;
      const channel = channels.find((c) => c.ownsJid(mainJid));
      channel?.sendMessageWithActions?.(mainJid, text, actions).catch(() => {});
    }
  },
});

// Message batcher for auto-handled items
const batcher = new MessageBatcher({
  maxItems: 5,
  maxWaitMs: 10_000,
  onFlush: (items) => {
    if (mainGroup) {
      const mainJid = mainGroup.folder;
      const channel = channels.find((c) => c.ownsJid(mainJid));
      channel?.sendMessage(mainJid, formatBatch(items)).catch(() => {});
    }
  },
});

// Register callback handler on Telegram channel
const telegramChannel = channels.find((c) => c.name === 'telegram');
if (telegramChannel?.onCallbackQuery) {
  telegramChannel.onCallbackQuery((query) => {
    handleCallback(query, {
      archiveTracker,
      autoApproval,
      statusBar,
      findChannel: (jid) => channels.find((c) => c.ownsJid(jid)),
    });
  });
}

// Start Mini App server
startMiniAppServer({ port: Number(process.env.MINI_APP_PORT) || 3847, db });
```

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`
Expected: No compilation errors

- [ ] **Step 3: Run existing tests to verify no regression**

Run: `npx vitest run src/index.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(ux): wire agentic UX components into startup initialization"
```

---

### Task 17: End-to-End Integration Test

**Files:**
- Create: `src/__tests__/agentic-ux-integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// src/__tests__/agentic-ux-integration.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../event-bus.js';
import { classifyAndFormat } from '../router.js';
import { MessageBatcher } from '../message-batcher.js';
import { StatusBarManager } from '../status-bar.js';
import { AutoApprovalTimer } from '../auto-approval.js';
import { FailureEscalator } from '../failure-escalator.js';

describe('Agentic UX Integration', () => {
  let bus: EventBus;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus();
  });

  afterEach(() => {
    bus.removeAllListeners();
    vi.useRealTimers();
  });

  it('full pipeline: financial message → classify → format → buttons', () => {
    const result = classifyAndFormat(
      'Chase — 2 incoming wires to account ····7958. Total: $54,900. Were both expected?',
    );

    expect(result.meta.category).toBe('financial');
    expect(result.meta.urgency).toBe('action-required');
    expect(result.meta.questionType).toBe('financial-confirm');
    expect(result.text).toContain('💰');
    expect(result.meta.actions).toHaveLength(3);
    expect(result.meta.actions[0].label).toBe('Yes, all expected');
  });

  it('batcher collects auto-handled items and flushes', () => {
    const flushed: string[][] = [];
    const batcher = new MessageBatcher({
      maxItems: 3,
      maxWaitMs: 10_000,
      onFlush: (items) => flushed.push([...items]),
    });

    const items = [
      'Newsletter dismissed — AUTO, no action.',
      'Receipt — $25. AUTO, no action.',
      'Promo email — AUTO, no action.',
    ];

    for (const item of items) {
      const result = classifyAndFormat(item);
      if (result.meta.batchable) {
        batcher.add(item);
      }
    }

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(3);
    batcher.destroy();
  });

  it('status bar + failure escalator work together', () => {
    let statusText = '';
    let escalation: string | null = null;

    const statusBar = new StatusBarManager(bus, {
      onUpdate: (text) => { statusText = text; },
    });

    const _escalator = new FailureEscalator(bus, {
      onEscalate: (text) => { escalation = text; },
    });

    // Task starts
    bus.emit('task.started', {
      type: 'task.started',
      source: 'executor',
      timestamp: Date.now(),
      payload: { taskId: 't1', groupJid: 'tg:123', containerName: 'Spamhaus investigation', slotIndex: 0 },
    });

    vi.advanceTimersByTime(2000);
    expect(statusText).toContain('ACTIVE');
    expect(statusText).toContain('Spamhaus investigation');

    // Task fails
    bus.emit('task.complete', {
      type: 'task.complete',
      source: 'executor',
      timestamp: Date.now(),
      payload: { taskId: 't1', groupJid: 'tg:123', status: 'error', durationMs: 5000 },
    });

    vi.advanceTimersByTime(2000);
    expect(escalation).toContain('🚨');
    expect(escalation).toContain('failed');

    statusBar.destroy();
  });

  it('auto-approval timer fires and emits event', () => {
    const handler = vi.fn();
    bus.on('plan.auto_approved', handler);

    const timer = new AutoApprovalTimer(bus);
    timer.start('task-1', 5000);

    vi.advanceTimersByTime(5000);
    expect(handler).toHaveBeenCalledTimes(1);

    timer.destroy();
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx vitest run src/__tests__/agentic-ux-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass, no regressions

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/agentic-ux-integration.test.ts
git commit -m "test(ux): add agentic UX end-to-end integration tests"
```

---

## Summary

| Task | Component | New Files | Tests |
|------|-----------|-----------|-------|
| 1 | Types & Events | — | agentic-ux-types.test.ts |
| 2 | Message Classifier | message-classifier.ts | message-classifier.test.ts |
| 3 | Question Detector | question-detector.ts | question-detector.test.ts |
| 4 | Message Formatter | message-formatter.ts | message-formatter.test.ts |
| 5 | Message Batcher | message-batcher.ts | message-batcher.test.ts |
| 6 | Database Tables | — (modify db.ts) | agentic-ux-db.test.ts |
| 7 | Telegram Extensions | — (modify telegram.ts) | telegram-agentic.test.ts |
| 8 | Router Pipeline | — (modify router.ts) | router.test.ts (extended) |
| 9 | Status Bar Manager | status-bar.ts | status-bar.test.ts |
| 10 | Auto-Approval Timer | auto-approval.ts | auto-approval.test.ts |
| 11 | Failure Escalator | failure-escalator.ts | failure-escalator.test.ts |
| 12 | Archive Tracker | archive-tracker.ts | archive-tracker.test.ts |
| 13 | Mini App Server | mini-app/server.ts, templates/ | mini-app-server.test.ts |
| 14 | Email Preview | email-preview.ts | email-preview.test.ts |
| 15 | Callback Router | callback-router.ts | callback-router.test.ts |
| 16 | Startup Wiring | — (modify index.ts) | — (build check) |
| 17 | Integration Tests | — | agentic-ux-integration.test.ts |

**Not included (separate follow-up):**
- Draft enrichment watcher (requires SuperPilot integration design)
- Morning digest inbox cleanup section (requires modifying existing digest-engine.ts)
- Mini App SSE/polling for live updates (optimization after basic flow works)
- Pinned message management (Telegram pin/unpin API — wiring detail)
