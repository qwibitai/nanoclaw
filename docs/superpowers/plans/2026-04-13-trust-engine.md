# Trust Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Trust & Autonomy Engine that starts in cold-start (approval-required) mode and gradually grants the agent autonomous execution rights as the user approves actions, with a host-side HTTP gateway containers call before executing write/transact operations.

**Architecture:** A host-side HTTP trust gateway (Node.js `http` module, port 10255) intercepts action requests from containers via Docker bridge, classifies them into domain×operation classes (e.g. `health.write`), evaluates per-class confidence against thresholds, and either auto-approves or creates a pending approval that routes an approval prompt to the originating channel. The host trust engine stores all decisions in SQLite and updates confidence scores using the formula `approvals / (approvals + denials + 1)` with time decay.

**Tech Stack:** Node.js/TypeScript, `better-sqlite3` (existing), Node.js `http` module (no new HTTP lib), `EventBus` (Plan 1 foundation), existing IPC/channel architecture.

**Spec:** docs/superpowers/specs/2026-04-13-nanoclaw-scope-expansion-design.md (Layer 3)

**Depends on:** Plan 1 (Event-Driven Foundation) — completed

---

## Task 1: Add trust event types to `src/events.ts`

Extend the event type definitions with four new trust events. Insert after the `TaskProgressEvent` block and before the `SystemErrorEvent` block. Also update `EventMap` and `EventType`.

**File:** `src/events.ts`

Add these interfaces after `TaskProgressEvent`:

```typescript
// --- Trust events ---

export interface TrustRequestEvent extends NanoClawEvent {
  type: 'trust.request';
  source: 'trust-gateway';
  payload: {
    approvalId: string;
    actionClass: string;
    toolName: string;
    description: string;
    groupId: string;
    chatJid: string;
    confidence: number;
    threshold: number;
  };
}

export interface TrustApprovedEvent extends NanoClawEvent {
  type: 'trust.approved';
  source: 'trust-gateway';
  payload: {
    approvalId: string;
    actionClass: string;
    toolName: string;
    groupId: string;
    auto: boolean; // true = auto-approved by confidence, false = user approved
  };
}

export interface TrustDeniedEvent extends NanoClawEvent {
  type: 'trust.denied';
  source: 'trust-gateway';
  payload: {
    approvalId: string;
    actionClass: string;
    toolName: string;
    groupId: string;
    reason: 'user_denied' | 'timeout';
  };
}

export interface TrustGraduatedEvent extends NanoClawEvent {
  type: 'trust.graduated';
  source: 'trust-engine';
  payload: {
    actionClass: string;
    confidence: number;
    threshold: number;
    groupId: string;
  };
}
```

Update `EventMap`:

```typescript
export interface EventMap {
  // ... existing entries ...
  'trust.request': TrustRequestEvent;
  'trust.approved': TrustApprovedEvent;
  'trust.denied': TrustDeniedEvent;
  'trust.graduated': TrustGraduatedEvent;
}
```

**Verification:** `npm run build` — zero TypeScript errors.

---

## Task 2: Add trust database tables and prepared statement functions to `src/db.ts`

### 2a. Schema additions

In the `createSchema` function, after the `event_log` table creation and before the closing backtick of the `database.exec(...)` call, add:

```sql
CREATE TABLE IF NOT EXISTS trust_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_class TEXT NOT NULL,
  domain TEXT NOT NULL,
  operation TEXT NOT NULL,
  description TEXT,
  decision TEXT NOT NULL,
  outcome TEXT,
  group_id TEXT NOT NULL,
  timestamp DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trust_actions_class ON trust_actions(action_class, group_id);
CREATE INDEX IF NOT EXISTS idx_trust_actions_time ON trust_actions(timestamp);

CREATE TABLE IF NOT EXISTS trust_levels (
  action_class TEXT NOT NULL,
  group_id TEXT NOT NULL,
  approvals INTEGER NOT NULL DEFAULT 0,
  denials INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0.0,
  threshold REAL NOT NULL DEFAULT 0.8,
  auto_execute INTEGER NOT NULL DEFAULT 1,
  last_updated DATETIME NOT NULL,
  PRIMARY KEY (action_class, group_id)
);

CREATE TABLE IF NOT EXISTS trust_approvals (
  id TEXT PRIMARY KEY,
  action_class TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  description TEXT,
  group_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL,
  resolved_at DATETIME,
  expires_at DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trust_approvals_status ON trust_approvals(status, expires_at);
```

### 2b. Prepared statement functions

Add these exported functions at the end of `src/db.ts` (before any existing trailing exports, after the last existing function):

```typescript
// --- Trust engine DB functions ---

export interface TrustAction {
  id?: number;
  action_class: string;
  domain: string;
  operation: string;
  description?: string;
  decision: string;
  outcome?: string;
  group_id: string;
  timestamp: string;
}

export interface TrustLevel {
  action_class: string;
  group_id: string;
  approvals: number;
  denials: number;
  confidence: number;
  threshold: number;
  auto_execute: boolean;
  last_updated: string;
}

export interface TrustApproval {
  id: string;
  action_class: string;
  tool_name: string;
  description?: string;
  group_id: string;
  chat_jid: string;
  status: 'pending' | 'approved' | 'denied' | 'timeout';
  created_at: string;
  resolved_at?: string;
  expires_at: string;
}

export function insertTrustAction(action: Omit<TrustAction, 'id'>): void {
  db.prepare(
    `INSERT INTO trust_actions (action_class, domain, operation, description, decision, outcome, group_id, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    action.action_class,
    action.domain,
    action.operation,
    action.description ?? null,
    action.decision,
    action.outcome ?? null,
    action.group_id,
    action.timestamp,
  );
}

export function getTrustLevel(
  actionClass: string,
  groupId: string,
): TrustLevel | undefined {
  const row = db
    .prepare(
      `SELECT action_class, group_id, approvals, denials, confidence, threshold, auto_execute, last_updated
       FROM trust_levels WHERE action_class = ? AND group_id = ?`,
    )
    .get(actionClass, groupId) as
    | (Omit<TrustLevel, 'auto_execute'> & { auto_execute: number })
    | undefined;
  if (!row) return undefined;
  return { ...row, auto_execute: row.auto_execute === 1 };
}

export function upsertTrustLevel(level: TrustLevel): void {
  db.prepare(
    `INSERT INTO trust_levels (action_class, group_id, approvals, denials, confidence, threshold, auto_execute, last_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(action_class, group_id) DO UPDATE SET
       approvals = excluded.approvals,
       denials = excluded.denials,
       confidence = excluded.confidence,
       threshold = excluded.threshold,
       auto_execute = excluded.auto_execute,
       last_updated = excluded.last_updated`,
  ).run(
    level.action_class,
    level.group_id,
    level.approvals,
    level.denials,
    level.confidence,
    level.threshold,
    level.auto_execute ? 1 : 0,
    level.last_updated,
  );
}

export function getAllTrustLevels(groupId: string): TrustLevel[] {
  const rows = db
    .prepare(
      `SELECT action_class, group_id, approvals, denials, confidence, threshold, auto_execute, last_updated
       FROM trust_levels WHERE group_id = ? ORDER BY action_class`,
    )
    .all(groupId) as Array<Omit<TrustLevel, 'auto_execute'> & { auto_execute: number }>;
  return rows.map((r) => ({ ...r, auto_execute: r.auto_execute === 1 }));
}

export function resetTrustLevels(groupId: string): void {
  db.prepare(`DELETE FROM trust_levels WHERE group_id = ?`).run(groupId);
  db.prepare(
    `UPDATE trust_approvals SET status = 'timeout', resolved_at = ? WHERE group_id = ? AND status = 'pending'`,
  ).run(new Date().toISOString(), groupId);
}

export function setTrustAutoExecute(
  actionClass: string,
  groupId: string,
  autoExecute: boolean,
  threshold: number,
): void {
  db.prepare(
    `INSERT INTO trust_levels (action_class, group_id, approvals, denials, confidence, threshold, auto_execute, last_updated)
     VALUES (?, ?, 0, 0, 0.0, ?, ?, ?)
     ON CONFLICT(action_class, group_id) DO UPDATE SET
       auto_execute = excluded.auto_execute,
       threshold = excluded.threshold,
       last_updated = excluded.last_updated`,
  ).run(
    actionClass,
    groupId,
    threshold,
    autoExecute ? 1 : 0,
    new Date().toISOString(),
  );
}

export function insertTrustApproval(approval: TrustApproval): void {
  db.prepare(
    `INSERT INTO trust_approvals (id, action_class, tool_name, description, group_id, chat_jid, status, created_at, resolved_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    approval.id,
    approval.action_class,
    approval.tool_name,
    approval.description ?? null,
    approval.group_id,
    approval.chat_jid,
    approval.status,
    approval.created_at,
    approval.resolved_at ?? null,
    approval.expires_at,
  );
}

export function getTrustApproval(id: string): TrustApproval | undefined {
  return db
    .prepare(`SELECT * FROM trust_approvals WHERE id = ?`)
    .get(id) as TrustApproval | undefined;
}

export function resolveTrustApproval(
  id: string,
  status: 'approved' | 'denied' | 'timeout',
): void {
  db.prepare(
    `UPDATE trust_approvals SET status = ?, resolved_at = ? WHERE id = ?`,
  ).run(status, new Date().toISOString(), id);
}

export function getExpiredTrustApprovals(): TrustApproval[] {
  return db
    .prepare(
      `SELECT * FROM trust_approvals WHERE status = 'pending' AND expires_at < ?`,
    )
    .all(new Date().toISOString()) as TrustApproval[];
}
```

### 2c. Tests

Create `src/__tests__/trust-db.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  _initTestDatabase,
  _closeDatabase,
  insertTrustAction,
  getTrustLevel,
  upsertTrustLevel,
  getAllTrustLevels,
  resetTrustLevels,
  insertTrustApproval,
  getTrustApproval,
  resolveTrustApproval,
  getExpiredTrustApprovals,
} from '../db.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

describe('insertTrustAction', () => {
  it('inserts and retrieves action log', () => {
    insertTrustAction({
      action_class: 'health.write',
      domain: 'health',
      operation: 'write',
      description: 'Request refill',
      decision: 'approved',
      group_id: 'group1',
      timestamp: new Date().toISOString(),
    });
    // No direct read function needed — just verify no throw
  });
});

describe('trust levels', () => {
  it('returns undefined for unknown class', () => {
    expect(getTrustLevel('health.write', 'group1')).toBeUndefined();
  });

  it('upserts and retrieves trust level', () => {
    const level = {
      action_class: 'health.write',
      group_id: 'group1',
      approvals: 3,
      denials: 1,
      confidence: 0.6,
      threshold: 0.8,
      auto_execute: true,
      last_updated: new Date().toISOString(),
    };
    upsertTrustLevel(level);
    const retrieved = getTrustLevel('health.write', 'group1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.approvals).toBe(3);
    expect(retrieved!.confidence).toBeCloseTo(0.6);
  });

  it('updates on conflict', () => {
    const base = {
      action_class: 'code.write',
      group_id: 'group1',
      approvals: 1,
      denials: 0,
      confidence: 0.5,
      threshold: 0.8,
      auto_execute: true,
      last_updated: new Date().toISOString(),
    };
    upsertTrustLevel(base);
    upsertTrustLevel({ ...base, approvals: 5, confidence: 0.85 });
    expect(getTrustLevel('code.write', 'group1')!.approvals).toBe(5);
  });

  it('getAllTrustLevels returns levels for group', () => {
    for (const cls of ['health.read', 'health.write']) {
      upsertTrustLevel({
        action_class: cls,
        group_id: 'group1',
        approvals: 0,
        denials: 0,
        confidence: 0,
        threshold: 0.8,
        auto_execute: true,
        last_updated: new Date().toISOString(),
      });
    }
    const levels = getAllTrustLevels('group1');
    expect(levels).toHaveLength(2);
  });

  it('resetTrustLevels clears group', () => {
    upsertTrustLevel({
      action_class: 'health.write',
      group_id: 'group1',
      approvals: 5,
      denials: 0,
      confidence: 0.9,
      threshold: 0.8,
      auto_execute: true,
      last_updated: new Date().toISOString(),
    });
    resetTrustLevels('group1');
    expect(getAllTrustLevels('group1')).toHaveLength(0);
  });
});

describe('trust approvals', () => {
  it('inserts and retrieves approval', () => {
    const now = new Date();
    const expires = new Date(now.getTime() + 1800000);
    insertTrustApproval({
      id: 'abc123',
      action_class: 'health.write',
      tool_name: 'request_refill',
      description: 'Request a prescription refill',
      group_id: 'group1',
      chat_jid: 'tg:123',
      status: 'pending',
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
    });
    const retrieved = getTrustApproval('abc123');
    expect(retrieved).toBeDefined();
    expect(retrieved!.status).toBe('pending');
  });

  it('resolves approval to approved', () => {
    const now = new Date();
    const expires = new Date(now.getTime() + 1800000);
    insertTrustApproval({
      id: 'xyz456',
      action_class: 'code.write',
      tool_name: 'write_file',
      group_id: 'group1',
      chat_jid: 'tg:123',
      status: 'pending',
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
    });
    resolveTrustApproval('xyz456', 'approved');
    expect(getTrustApproval('xyz456')!.status).toBe('approved');
  });

  it('getExpiredTrustApprovals returns only expired pending', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 1800000).toISOString();
    const now = new Date().toISOString();
    insertTrustApproval({
      id: 'exp1',
      action_class: 'health.write',
      tool_name: 'request_refill',
      group_id: 'group1',
      chat_jid: 'tg:123',
      status: 'pending',
      created_at: now,
      expires_at: past,
    });
    insertTrustApproval({
      id: 'notexp',
      action_class: 'health.write',
      tool_name: 'request_refill',
      group_id: 'group1',
      chat_jid: 'tg:123',
      status: 'pending',
      created_at: now,
      expires_at: future,
    });
    const expired = getExpiredTrustApprovals();
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe('exp1');
  });
});
```

**Run test:** `npx vitest run src/__tests__/trust-db.test.ts`

**Verification:** All tests pass. `npm run build` — zero errors.

---

## Task 3: Implement trust engine core (`src/trust-engine.ts`)

Create `src/trust-engine.ts`:

```typescript
/**
 * Trust Engine Core
 *
 * Classifies actions into domain×operation classes, evaluates confidence
 * against thresholds, and determines whether actions need user approval
 * or can execute autonomously.
 *
 * Formula: confidence = approvals / (approvals + denials + 1)
 * Decay: -0.01 per day without activity (floor 0.0)
 */

import {
  getTrustLevel,
  upsertTrustLevel,
  insertTrustAction,
  TrustLevel,
} from './db.js';
import { eventBus } from './event-bus.js';
import type { TrustGraduatedEvent } from './events.js';

// --- Action taxonomy ---

export type TrustDomain =
  | 'info'
  | 'comms'
  | 'health'
  | 'finance'
  | 'code'
  | 'services';
export type TrustOperation = 'read' | 'write' | 'transact';
export type ActionClass = `${TrustDomain}.${TrustOperation}`;

/** Default thresholds by operation type */
const DEFAULT_THRESHOLDS: Record<TrustOperation, number> = {
  read: 0.7,
  write: 0.8,
  transact: 0.95,
};

/** Static mapping: known tool names → action class */
const TOOL_CLASS_MAP: Record<string, ActionClass> = {
  // Info domain — reads
  web_search: 'info.read',
  search_contacts: 'info.read',
  read_file: 'info.read',
  list_files: 'info.read',
  // Comms domain
  send_message: 'comms.write',
  send_email: 'comms.transact',
  reply_email: 'comms.write',
  draft_email: 'comms.write',
  // Health domain
  request_refill: 'health.transact',
  book_appointment: 'health.transact',
  cancel_appointment: 'health.transact',
  check_symptoms: 'health.read',
  // Finance domain
  check_balance: 'finance.read',
  transfer_funds: 'finance.transact',
  pay_bill: 'finance.transact',
  // Code domain
  bash: 'code.write',
  write_file: 'code.write',
  edit_file: 'code.write',
  delete_file: 'code.transact',
  run_tests: 'code.write',
  // Services domain
  schedule_task: 'services.write',
  cancel_task: 'services.write',
  create_calendar_event: 'services.write',
  delete_calendar_event: 'services.transact',
};

/** Parse an ActionClass string into domain and operation. */
export function parseActionClass(actionClass: ActionClass): {
  domain: TrustDomain;
  operation: TrustOperation;
} {
  const [domain, operation] = actionClass.split('.') as [
    TrustDomain,
    TrustOperation,
  ];
  return { domain, operation };
}

/** Classify a tool call. Fallback to highest risk (transact) for unknowns. */
export function classifyTool(
  toolName: string,
  selfReportedClass?: string,
): ActionClass {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (TOOL_CLASS_MAP[normalized]) return TOOL_CLASS_MAP[normalized];

  // Try self-reported class from container agent
  if (selfReportedClass && isValidActionClass(selfReportedClass)) {
    return selfReportedClass as ActionClass;
  }

  // Default: highest risk
  return 'services.transact';
}

function isValidActionClass(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 2) return false;
  const domains: string[] = [
    'info',
    'comms',
    'health',
    'finance',
    'code',
    'services',
  ];
  const ops: string[] = ['read', 'write', 'transact'];
  return domains.includes(parts[0]) && ops.includes(parts[1]);
}

/** Calculate confidence with time decay. */
export function calculateConfidence(
  approvals: number,
  denials: number,
  lastUpdated: string,
): number {
  const rawConfidence = approvals / (approvals + denials + 1);

  // Apply time decay: -0.01 per day since last activity
  const daysSinceActivity =
    (Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60 * 24);
  const decayed = rawConfidence - 0.01 * daysSinceActivity;

  return Math.max(0.0, decayed);
}

export interface TrustDecision {
  decision: 'approved' | 'needs_approval';
  reason: string;
  confidence: number;
  threshold: number;
}

/**
 * Evaluate whether an action can auto-execute or needs user approval.
 * Updates the trust level record with decayed confidence.
 */
export function evaluateTrust(
  toolName: string,
  groupId: string,
  selfReportedClass?: string,
): TrustDecision {
  const actionClass = classifyTool(toolName, selfReportedClass);
  const { operation } = parseActionClass(actionClass);

  const stored = getTrustLevel(actionClass, groupId);
  const defaultThreshold = DEFAULT_THRESHOLDS[operation];

  if (!stored) {
    // Cold start: no trust data
    return {
      decision: 'needs_approval',
      reason: 'cold start — no trust data for this action class',
      confidence: 0,
      threshold: defaultThreshold,
    };
  }

  // auto_execute = false means permanently gated
  if (!stored.auto_execute) {
    return {
      decision: 'needs_approval',
      reason: 'manually configured to always require approval',
      confidence: stored.confidence,
      threshold: stored.threshold,
    };
  }

  // Apply time decay
  const confidence = calculateConfidence(
    stored.approvals,
    stored.denials,
    stored.last_updated,
  );

  // Persist decayed confidence back
  if (Math.abs(confidence - stored.confidence) > 0.001) {
    upsertTrustLevel({
      ...stored,
      confidence,
      last_updated: new Date().toISOString(),
    });
  }

  if (confidence >= stored.threshold) {
    return {
      decision: 'approved',
      reason: `confidence ${confidence.toFixed(2)} >= threshold ${stored.threshold}`,
      confidence,
      threshold: stored.threshold,
    };
  }

  return {
    decision: 'needs_approval',
    reason: `confidence ${confidence.toFixed(2)} < threshold ${stored.threshold}`,
    confidence,
    threshold: stored.threshold,
  };
}

/**
 * Record a trust decision (approval or denial) and update trust level.
 * Emits trust.graduated when confidence crosses the threshold for the first time.
 */
export function recordTrustDecision(
  toolName: string,
  groupId: string,
  decision: 'approved' | 'denied',
  description?: string,
  selfReportedClass?: string,
): void {
  const actionClass = classifyTool(toolName, selfReportedClass);
  const { domain, operation } = parseActionClass(actionClass);
  const now = new Date().toISOString();

  insertTrustAction({
    action_class: actionClass,
    domain,
    operation,
    description,
    decision,
    group_id: groupId,
    timestamp: now,
  });

  const stored = getTrustLevel(actionClass, groupId);
  const defaultThreshold = DEFAULT_THRESHOLDS[operation];

  const prevApprovals = stored?.approvals ?? 0;
  const prevDenials = stored?.denials ?? 0;
  const prevConfidence = stored?.confidence ?? 0;
  const threshold = stored?.threshold ?? defaultThreshold;
  const autoExecute = stored?.auto_execute ?? true;

  const newApprovals = decision === 'approved' ? prevApprovals + 1 : prevApprovals;
  const newDenials = decision === 'denied' ? prevDenials + 1 : prevDenials;

  // Denial resets confidence significantly (hard to rebuild)
  const newConfidence =
    decision === 'denied'
      ? calculateConfidence(newApprovals, newDenials, now)
      : calculateConfidence(newApprovals, newDenials, now);

  const wasBelow = prevConfidence < threshold;
  const nowAbove = newConfidence >= threshold;

  upsertTrustLevel({
    action_class: actionClass,
    group_id: groupId,
    approvals: newApprovals,
    denials: newDenials,
    confidence: newConfidence,
    threshold,
    auto_execute: autoExecute,
    last_updated: now,
  });

  // Emit graduation event when threshold is first crossed
  if (wasBelow && nowAbove && autoExecute) {
    const graduatedEvent: TrustGraduatedEvent = {
      type: 'trust.graduated',
      source: 'trust-engine',
      groupId,
      timestamp: Date.now(),
      payload: {
        actionClass,
        confidence: newConfidence,
        threshold,
        groupId,
      },
    };
    eventBus.emit('trust.graduated', graduatedEvent);
  }
}
```

### 3a. Tests

Create `src/__tests__/trust-engine.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';
import {
  classifyTool,
  calculateConfidence,
  evaluateTrust,
  recordTrustDecision,
} from '../trust-engine.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

describe('classifyTool', () => {
  it('maps known tools', () => {
    expect(classifyTool('send_message')).toBe('comms.write');
    expect(classifyTool('web_search')).toBe('info.read');
    expect(classifyTool('transfer_funds')).toBe('finance.transact');
  });

  it('uses self-reported class for unknown tools', () => {
    expect(classifyTool('my_custom_tool', 'health.write')).toBe('health.write');
  });

  it('defaults to services.transact for unknown tools', () => {
    expect(classifyTool('totally_unknown_tool')).toBe('services.transact');
  });

  it('rejects invalid self-reported class', () => {
    expect(classifyTool('my_tool', 'invalid.class')).toBe('services.transact');
    expect(classifyTool('my_tool', 'health.hack')).toBe('services.transact');
  });
});

describe('calculateConfidence', () => {
  it('returns 0 for zero approvals', () => {
    const now = new Date().toISOString();
    expect(calculateConfidence(0, 0, now)).toBe(0);
  });

  it('formula: 3 approvals 0 denials = 0.75', () => {
    const now = new Date().toISOString();
    // 3/(3+0+1) = 0.75
    expect(calculateConfidence(3, 0, now)).toBeCloseTo(0.75);
  });

  it('denials lower confidence', () => {
    const now = new Date().toISOString();
    // 5/(5+5+1) = 0.4545
    expect(calculateConfidence(5, 5, now)).toBeCloseTo(0.4545, 3);
  });

  it('applies time decay', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    // 5/(5+0+1) = 0.833 - 0.01*10 = 0.733
    const conf = calculateConfidence(5, 0, tenDaysAgo);
    expect(conf).toBeCloseTo(0.733, 2);
  });

  it('never goes below 0', () => {
    const veryOld = new Date(Date.now() - 1000 * 86400000).toISOString();
    expect(calculateConfidence(5, 0, veryOld)).toBe(0);
  });
});

describe('evaluateTrust', () => {
  it('cold start → needs_approval', () => {
    const result = evaluateTrust('send_message', 'group1');
    expect(result.decision).toBe('needs_approval');
    expect(result.reason).toMatch(/cold start/);
  });

  it('sufficient approvals → approved', () => {
    // Record enough approvals to cross write threshold (0.8)
    // Need 4 approvals: 4/(4+0+1)=0.8 exactly, need >0.8 so use 5: 5/6=0.833
    for (let i = 0; i < 5; i++) {
      recordTrustDecision('send_message', 'group1', 'approved');
    }
    const result = evaluateTrust('send_message', 'group1');
    expect(result.decision).toBe('approved');
  });

  it('denial lowers confidence below threshold', () => {
    for (let i = 0; i < 5; i++) {
      recordTrustDecision('send_message', 'group1', 'approved');
    }
    recordTrustDecision('send_message', 'group1', 'denied');
    recordTrustDecision('send_message', 'group1', 'denied');
    const result = evaluateTrust('send_message', 'group1');
    expect(result.decision).toBe('needs_approval');
  });

  it('auto_execute=false always requires approval', () => {
    import { setTrustAutoExecute } from '../db.js';
    // This is tested in the gateway integration test
  });
});

describe('recordTrustDecision', () => {
  it('graduation: emits trust.graduated when threshold crossed', () => {
    const { eventBus } = await import('../event-bus.js');
    let graduated = false;
    eventBus.on('trust.graduated', () => { graduated = true; });
    // write threshold = 0.8; need 5 approvals
    for (let i = 0; i < 4; i++) {
      recordTrustDecision('send_message', 'group1', 'approved');
    }
    expect(graduated).toBe(false);
    recordTrustDecision('send_message', 'group1', 'approved');
    expect(graduated).toBe(true);
  });
});
```

Note: The `auto_execute=false` test at the end of the `evaluateTrust` block should be removed (the inner import pattern won't work in Vitest). Replace with a separate test:

```typescript
  it('auto_execute=false always requires approval even with high confidence', async () => {
    const { setTrustAutoExecute } = await import('../db.js');
    setTrustAutoExecute('comms.write', 'group1', false, 1.0);
    for (let i = 0; i < 20; i++) {
      recordTrustDecision('send_message', 'group1', 'approved');
    }
    const result = evaluateTrust('send_message', 'group1');
    expect(result.decision).toBe('needs_approval');
    expect(result.reason).toMatch(/manually configured/);
  });
```

**Run test:** `npx vitest run src/__tests__/trust-engine.test.ts`

**Verification:** All tests pass. `npm run build` — zero errors.

---

## Task 4: Implement trust gateway HTTP server (`src/trust-gateway.ts`)

The trust gateway is an HTTP server on port 10255 (configurable via `TRUST_GATEWAY_PORT`). Containers reach it via `http://host.docker.internal:10255` — same pattern as OneCLI.

### 4a. Add config constant

In `src/config.ts`, add after `ONECLI_URL`:

```typescript
export const TRUST_GATEWAY_PORT = parseInt(
  process.env.TRUST_GATEWAY_PORT || '10255',
  10,
);
export const TRUST_GATEWAY_URL =
  process.env.TRUST_GATEWAY_URL ||
  `http://host.docker.internal:${TRUST_GATEWAY_PORT}`;
export const TRUST_APPROVAL_TIMEOUT_MS = parseInt(
  process.env.TRUST_APPROVAL_TIMEOUT_MS || '1800000',
  10,
); // 30 min default
```

### 4b. Create `src/trust-gateway.ts`

```typescript
/**
 * Trust Gateway — HTTP server for container → host trust decisions.
 *
 * Containers call this before executing write/transact operations.
 * The gateway classifies the action, checks confidence, and either:
 * - Auto-approves (confidence >= threshold)
 * - Creates a pending approval and sends a prompt to the user channel
 *
 * Endpoints:
 *   POST /trust/evaluate   — evaluate and approve/pend an action
 *   GET  /trust/approval/:id — poll for approval status
 *   POST /trust/resolve/:id  — internal: resolve from channel handler
 */

import http from 'http';
import { randomUUID } from 'crypto';

import { TRUST_APPROVAL_TIMEOUT_MS, TRUST_GATEWAY_PORT } from './config.js';
import {
  getExpiredTrustApprovals,
  getTrustApproval,
  insertTrustApproval,
  resolveTrustApproval,
} from './db.js';
import { eventBus } from './event-bus.js';
import type { TrustApprovedEvent, TrustDeniedEvent, TrustRequestEvent } from './events.js';
import { classifyTool, evaluateTrust, recordTrustDecision } from './trust-engine.js';
import { logger } from './logger.js';

export interface TrustGatewayDeps {
  /** Send an approval prompt to the user's channel. */
  sendApprovalPrompt: (
    chatJid: string,
    approvalId: string,
    actionClass: string,
    toolName: string,
    description: string | undefined,
  ) => Promise<void>;
  /** Send a timeout notification. */
  sendTimeoutNotification: (chatJid: string, toolName: string) => Promise<void>;
}

let server: http.Server | null = null;
let deps: TrustGatewayDeps | null = null;
let expiryInterval: ReturnType<typeof setInterval> | null = null;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseRoute(
  method: string,
  url: string,
): { route: string; param?: string } | null {
  if (method === 'POST' && url === '/trust/evaluate') {
    return { route: 'evaluate' };
  }
  const pollMatch = url.match(/^\/trust\/approval\/([^/]+)$/);
  if (method === 'GET' && pollMatch) {
    return { route: 'poll', param: pollMatch[1] };
  }
  const resolveMatch = url.match(/^\/trust\/resolve\/([^/]+)$/);
  if (method === 'POST' && resolveMatch) {
    return { route: 'resolve', param: resolveMatch[1] };
  }
  return null;
}

async function handleEvaluate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: {
    action_class?: string;
    tool_name: string;
    description?: string;
    group_id: string;
    chat_jid: string;
  };

  try {
    body = JSON.parse(await readBody(req));
  } catch {
    jsonResponse(res, 400, { error: 'invalid JSON body' });
    return;
  }

  if (!body.tool_name || !body.group_id || !body.chat_jid) {
    jsonResponse(res, 400, { error: 'missing required fields: tool_name, group_id, chat_jid' });
    return;
  }

  const actionClass = classifyTool(body.tool_name, body.action_class);
  const trustDecision = evaluateTrust(body.tool_name, body.group_id, body.action_class);

  if (trustDecision.decision === 'approved') {
    // Auto-approve: record and return immediately
    recordTrustDecision(
      body.tool_name,
      body.group_id,
      'approved',
      body.description,
      body.action_class,
    );

    const approvedEvent: TrustApprovedEvent = {
      type: 'trust.approved',
      source: 'trust-gateway',
      groupId: body.group_id,
      timestamp: Date.now(),
      payload: {
        approvalId: '',
        actionClass,
        toolName: body.tool_name,
        groupId: body.group_id,
        auto: true,
      },
    };
    eventBus.emit('trust.approved', approvedEvent);

    jsonResponse(res, 200, {
      decision: 'approved',
      reason: trustDecision.reason,
    });
    return;
  }

  // Create pending approval
  const approvalId = randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + TRUST_APPROVAL_TIMEOUT_MS);

  insertTrustApproval({
    id: approvalId,
    action_class: actionClass,
    tool_name: body.tool_name,
    description: body.description,
    group_id: body.group_id,
    chat_jid: body.chat_jid,
    status: 'pending',
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
  });

  const requestEvent: TrustRequestEvent = {
    type: 'trust.request',
    source: 'trust-gateway',
    groupId: body.group_id,
    timestamp: Date.now(),
    payload: {
      approvalId,
      actionClass,
      toolName: body.tool_name,
      description: body.description ?? '',
      groupId: body.group_id,
      chatJid: body.chat_jid,
      confidence: trustDecision.confidence,
      threshold: trustDecision.threshold,
    },
  };
  eventBus.emit('trust.request', requestEvent);

  // Send approval prompt to user channel
  if (deps) {
    deps.sendApprovalPrompt(
      body.chat_jid,
      approvalId,
      actionClass,
      body.tool_name,
      body.description,
    ).catch((err) => {
      logger.error({ err, approvalId }, 'Failed to send approval prompt');
    });
  }

  jsonResponse(res, 202, {
    decision: 'pending',
    approval_id: approvalId,
    timeout_s: Math.floor(TRUST_APPROVAL_TIMEOUT_MS / 1000),
  });
}

async function handlePoll(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  approvalId: string,
): Promise<void> {
  const approval = getTrustApproval(approvalId);
  if (!approval) {
    jsonResponse(res, 404, { error: 'approval not found' });
    return;
  }

  if (approval.status === 'pending') {
    // Check if expired
    if (new Date(approval.expires_at) < new Date()) {
      resolveTrustApproval(approvalId, 'timeout');
      jsonResponse(res, 200, { decision: 'timeout' });
      return;
    }
    jsonResponse(res, 200, { decision: 'pending' });
    return;
  }

  jsonResponse(res, 200, { decision: approval.status });
}

async function handleResolve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  approvalId: string,
): Promise<void> {
  let body: { decision: 'approved' | 'denied' };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    jsonResponse(res, 400, { error: 'invalid JSON body' });
    return;
  }

  if (body.decision !== 'approved' && body.decision !== 'denied') {
    jsonResponse(res, 400, { error: 'decision must be "approved" or "denied"' });
    return;
  }

  const approval = getTrustApproval(approvalId);
  if (!approval) {
    jsonResponse(res, 404, { error: 'approval not found' });
    return;
  }
  if (approval.status !== 'pending') {
    jsonResponse(res, 409, { error: `approval already ${approval.status}` });
    return;
  }

  resolveTrustApproval(approvalId, body.decision);
  recordTrustDecision(
    approval.tool_name,
    approval.group_id,
    body.decision,
    approval.description,
  );

  if (body.decision === 'approved') {
    const event: TrustApprovedEvent = {
      type: 'trust.approved',
      source: 'trust-gateway',
      groupId: approval.group_id,
      timestamp: Date.now(),
      payload: {
        approvalId,
        actionClass: approval.action_class,
        toolName: approval.tool_name,
        groupId: approval.group_id,
        auto: false,
      },
    };
    eventBus.emit('trust.approved', event);
  } else {
    const event: TrustDeniedEvent = {
      type: 'trust.denied',
      source: 'trust-gateway',
      groupId: approval.group_id,
      timestamp: Date.now(),
      payload: {
        approvalId,
        actionClass: approval.action_class,
        toolName: approval.tool_name,
        groupId: approval.group_id,
        reason: 'user_denied',
      },
    };
    eventBus.emit('trust.denied', event);
  }

  jsonResponse(res, 200, { ok: true });
}

function startExpiryChecker(): void {
  expiryInterval = setInterval(() => {
    const expired = getExpiredTrustApprovals();
    for (const approval of expired) {
      resolveTrustApproval(approval.id, 'timeout');

      const event: TrustDeniedEvent = {
        type: 'trust.denied',
        source: 'trust-gateway',
        groupId: approval.group_id,
        timestamp: Date.now(),
        payload: {
          approvalId: approval.id,
          actionClass: approval.action_class,
          toolName: approval.tool_name,
          groupId: approval.group_id,
          reason: 'timeout',
        },
      };
      eventBus.emit('trust.denied', event);

      if (deps) {
        deps.sendTimeoutNotification(approval.chat_jid, approval.tool_name).catch((err) => {
          logger.error({ err, approvalId: approval.id }, 'Failed to send timeout notification');
        });
      }

      logger.info({ approvalId: approval.id, toolName: approval.tool_name }, 'Trust approval expired');
    }
  }, 60000); // check every minute
}

export function startTrustGateway(gatewayDeps: TrustGatewayDeps): void {
  deps = gatewayDeps;

  server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const route = parseRoute(method, url);

    if (!route) {
      jsonResponse(res, 404, { error: 'not found' });
      return;
    }

    try {
      if (route.route === 'evaluate') {
        await handleEvaluate(req, res);
      } else if (route.route === 'poll' && route.param) {
        await handlePoll(req, res, route.param);
      } else if (route.route === 'resolve' && route.param) {
        await handleResolve(req, res, route.param);
      } else {
        jsonResponse(res, 404, { error: 'not found' });
      }
    } catch (err) {
      logger.error({ err, route: route.route }, 'Trust gateway error');
      jsonResponse(res, 500, { error: 'internal error' });
    }
  });

  server.listen(TRUST_GATEWAY_PORT, '0.0.0.0', () => {
    logger.info({ port: TRUST_GATEWAY_PORT }, 'Trust gateway started');
  });

  startExpiryChecker();
}

export function stopTrustGateway(): Promise<void> {
  if (expiryInterval) {
    clearInterval(expiryInterval);
    expiryInterval = null;
  }
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => {
      server = null;
      resolve();
    });
  });
}

/** Resolve a pending approval by ID (called from channel message handler). */
export function resolveApproval(
  approvalId: string,
  decision: 'approved' | 'denied',
): boolean {
  const approval = getTrustApproval(approvalId);
  if (!approval || approval.status !== 'pending') return false;

  // Delegate to the internal HTTP endpoint logic inline
  resolveTrustApproval(approvalId, decision);
  recordTrustDecision(
    approval.tool_name,
    approval.group_id,
    decision,
    approval.description,
  );

  if (decision === 'approved') {
    eventBus.emit('trust.approved', {
      type: 'trust.approved',
      source: 'trust-gateway',
      groupId: approval.group_id,
      timestamp: Date.now(),
      payload: {
        approvalId,
        actionClass: approval.action_class,
        toolName: approval.tool_name,
        groupId: approval.group_id,
        auto: false,
      },
    });
  } else {
    eventBus.emit('trust.denied', {
      type: 'trust.denied',
      source: 'trust-gateway',
      groupId: approval.group_id,
      timestamp: Date.now(),
      payload: {
        approvalId,
        actionClass: approval.action_class,
        toolName: approval.tool_name,
        groupId: approval.group_id,
        reason: 'user_denied',
      },
    });
  }

  return true;
}
```

### 4c. Tests

Create `src/__tests__/trust-gateway.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { _initTestDatabase, _closeDatabase } from '../db.js';
import {
  startTrustGateway,
  stopTrustGateway,
} from '../trust-gateway.js';

const TEST_PORT = 19255;
process.env.TRUST_GATEWAY_PORT = String(TEST_PORT);

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const mockDeps = {
  sendApprovalPrompt: async () => {},
  sendTimeoutNotification: async () => {},
};

beforeEach(async () => {
  _initTestDatabase();
  startTrustGateway(mockDeps);
  // Brief wait for server to bind
  await new Promise((r) => setTimeout(r, 50));
});

afterEach(async () => {
  await stopTrustGateway();
  _closeDatabase();
});

describe('POST /trust/evaluate', () => {
  it('cold start → pending with approval_id', async () => {
    const { status, data } = await request('POST', '/trust/evaluate', {
      tool_name: 'send_message',
      group_id: 'group1',
      chat_jid: 'tg:123',
      description: 'Send a status update',
    });
    expect(status).toBe(202);
    expect((data as any).decision).toBe('pending');
    expect((data as any).approval_id).toBeDefined();
  });

  it('missing required fields → 400', async () => {
    const { status } = await request('POST', '/trust/evaluate', {
      tool_name: 'send_message',
    });
    expect(status).toBe(400);
  });

  it('after enough approvals → auto-approved', async () => {
    const { recordTrustDecision } = await import('../trust-engine.js');
    for (let i = 0; i < 5; i++) {
      recordTrustDecision('send_message', 'group1', 'approved');
    }
    const { status, data } = await request('POST', '/trust/evaluate', {
      tool_name: 'send_message',
      group_id: 'group1',
      chat_jid: 'tg:123',
    });
    expect(status).toBe(200);
    expect((data as any).decision).toBe('approved');
  });
});

describe('GET /trust/approval/:id', () => {
  it('pending → polls as pending', async () => {
    const evalRes = await request('POST', '/trust/evaluate', {
      tool_name: 'send_message',
      group_id: 'group1',
      chat_jid: 'tg:123',
    });
    const approvalId = (evalRes.data as any).approval_id;
    const { status, data } = await request('GET', `/trust/approval/${approvalId}`);
    expect(status).toBe(200);
    expect((data as any).decision).toBe('pending');
  });

  it('unknown id → 404', async () => {
    const { status } = await request('GET', '/trust/approval/nonexistent');
    expect(status).toBe(404);
  });
});

describe('POST /trust/resolve/:id', () => {
  it('resolves to approved', async () => {
    const evalRes = await request('POST', '/trust/evaluate', {
      tool_name: 'send_message',
      group_id: 'group1',
      chat_jid: 'tg:123',
    });
    const approvalId = (evalRes.data as any).approval_id;
    await request('POST', `/trust/resolve/${approvalId}`, { decision: 'approved' });
    const { data } = await request('GET', `/trust/approval/${approvalId}`);
    expect((data as any).decision).toBe('approved');
  });

  it('resolves to denied', async () => {
    const evalRes = await request('POST', '/trust/evaluate', {
      tool_name: 'send_message',
      group_id: 'group1',
      chat_jid: 'tg:123',
    });
    const approvalId = (evalRes.data as any).approval_id;
    await request('POST', `/trust/resolve/${approvalId}`, { decision: 'denied' });
    const { data } = await request('GET', `/trust/approval/${approvalId}`);
    expect((data as any).decision).toBe('denied');
  });

  it('double-resolve → 409', async () => {
    const evalRes = await request('POST', '/trust/evaluate', {
      tool_name: 'send_message',
      group_id: 'group1',
      chat_jid: 'tg:123',
    });
    const approvalId = (evalRes.data as any).approval_id;
    await request('POST', `/trust/resolve/${approvalId}`, { decision: 'approved' });
    const { status } = await request('POST', `/trust/resolve/${approvalId}`, { decision: 'denied' });
    expect(status).toBe(409);
  });
});
```

**Run test:** `npx vitest run src/__tests__/trust-gateway.test.ts`

**Verification:** All tests pass. `npm run build` — zero errors.

---

## Task 5: Wire approval prompts to channels (`src/trust-approval-handler.ts`)

When the trust gateway creates a pending approval, it needs to send an approval message to the user's channel. When the user replies "yes"/"approve"/"no"/"deny", the reply must resolve the approval.

### 5a. Create `src/trust-approval-handler.ts`

```typescript
/**
 * Trust Approval Handler
 *
 * Bridges the trust gateway with the channel layer:
 * - Sends approval prompts to users via channel sendMessage
 * - Parses user replies to resolve pending approvals
 *
 * The host polls for pending approvals on each inbound message check.
 * Replies matching "yes/approve/no/deny" + an active approval_id are routed here.
 */

import { getTrustApproval } from './db.js';
import { resolveApproval } from './trust-gateway.js';
import { logger } from './logger.js';

const APPROVE_PATTERN = /^(yes|approve|ok|allow|go ahead|do it|confirmed?)\b/i;
const DENY_PATTERN = /^(no|deny|reject|stop|cancel|don't|do not)\b/i;

export interface PendingApprovalContext {
  approvalId: string;
  toolName: string;
  actionClass: string;
  description?: string;
}

/**
 * Format an approval prompt message to send to the user.
 */
export function formatApprovalPrompt(
  approvalId: string,
  actionClass: string,
  toolName: string,
  description: string | undefined,
  timeoutMinutes: number,
): string {
  const [domain, operation] = actionClass.split('.');
  const emoji = getOperationEmoji(operation);
  const lines = [
    `${emoji} *Action approval needed*`,
    '',
    `**Action:** ${toolName}`,
    `**Class:** ${domain} / ${operation}`,
  ];
  if (description) {
    lines.push(`**Details:** ${description}`);
  }
  lines.push(
    '',
    `Reply *yes* to approve or *no* to deny.`,
    `_(Approval ID: \`${approvalId}\`, expires in ${timeoutMinutes} min)_`,
  );
  return lines.join('\n');
}

function getOperationEmoji(operation: string): string {
  switch (operation) {
    case 'read': return '🔍';
    case 'write': return '✏️';
    case 'transact': return '⚡';
    default: return '❓';
  }
}

/**
 * Check if an inbound message text resolves a pending approval.
 * Returns the resolution decision, or null if not an approval reply.
 *
 * The user may reply with just "yes"/"no", or reference an approval ID explicitly.
 * When a group has exactly one pending approval, we match it implicitly.
 */
export function parseApprovalReply(
  text: string,
  pendingApprovals: PendingApprovalContext[],
): { approvalId: string; decision: 'approved' | 'denied' } | null {
  if (pendingApprovals.length === 0) return null;

  const trimmed = text.trim();

  // Check for explicit approval ID in the message
  for (const pending of pendingApprovals) {
    if (trimmed.includes(pending.approvalId)) {
      if (APPROVE_PATTERN.test(trimmed)) {
        return { approvalId: pending.approvalId, decision: 'approved' };
      }
      if (DENY_PATTERN.test(trimmed)) {
        return { approvalId: pending.approvalId, decision: 'denied' };
      }
    }
  }

  // Implicit match when exactly one pending approval exists
  if (pendingApprovals.length === 1) {
    if (APPROVE_PATTERN.test(trimmed)) {
      return { approvalId: pendingApprovals[0].approvalId, decision: 'approved' };
    }
    if (DENY_PATTERN.test(trimmed)) {
      return { approvalId: pendingApprovals[0].approvalId, decision: 'denied' };
    }
  }

  return null;
}

/**
 * Process an inbound message — resolve pending approvals if the message matches.
 * Returns true if the message was consumed as an approval reply.
 */
export function handlePotentialApprovalReply(
  text: string,
  chatJid: string,
  pendingApprovalIds: string[],
): boolean {
  const contexts: PendingApprovalContext[] = pendingApprovalIds
    .map((id) => {
      const approval = getTrustApproval(id);
      if (!approval || approval.status !== 'pending' || approval.chat_jid !== chatJid) {
        return null;
      }
      return {
        approvalId: approval.id,
        toolName: approval.tool_name,
        actionClass: approval.action_class,
        description: approval.description,
      };
    })
    .filter((x): x is PendingApprovalContext => x !== null);

  const resolution = parseApprovalReply(text, contexts);
  if (!resolution) return false;

  const resolved = resolveApproval(resolution.approvalId, resolution.decision);
  if (resolved) {
    logger.info(
      { approvalId: resolution.approvalId, decision: resolution.decision, chatJid },
      'Trust approval resolved via channel message',
    );
  }
  return resolved;
}
```

### 5b. Tests

Create `src/__tests__/trust-approval-handler.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  formatApprovalPrompt,
  parseApprovalReply,
} from '../trust-approval-handler.js';

describe('formatApprovalPrompt', () => {
  it('includes tool name and class', () => {
    const msg = formatApprovalPrompt('abc123', 'comms.write', 'send_message', 'Send status update', 30);
    expect(msg).toContain('send_message');
    expect(msg).toContain('comms');
    expect(msg).toContain('write');
    expect(msg).toContain('abc123');
    expect(msg).toContain('30 min');
  });

  it('omits details when description is undefined', () => {
    const msg = formatApprovalPrompt('abc123', 'code.write', 'write_file', undefined, 30);
    expect(msg).not.toContain('Details');
  });
});

describe('parseApprovalReply', () => {
  const pending = [{ approvalId: 'abc123', toolName: 'send_message', actionClass: 'comms.write' }];

  it('returns null when no pending approvals', () => {
    expect(parseApprovalReply('yes', [])).toBeNull();
  });

  it('approves on "yes"', () => {
    const result = parseApprovalReply('yes', pending);
    expect(result?.decision).toBe('approved');
  });

  it('approves on "approve"', () => {
    expect(parseApprovalReply('approve', pending)?.decision).toBe('approved');
  });

  it('denies on "no"', () => {
    expect(parseApprovalReply('no', pending)?.decision).toBe('denied');
  });

  it('denies on "deny"', () => {
    expect(parseApprovalReply('deny this', pending)?.decision).toBe('denied');
  });

  it('does not match ambiguous text', () => {
    expect(parseApprovalReply('what is this about?', pending)).toBeNull();
  });

  it('matches with explicit approval id even in multi-pending', () => {
    const multi = [
      { approvalId: 'abc123', toolName: 'send_message', actionClass: 'comms.write' },
      { approvalId: 'xyz456', toolName: 'write_file', actionClass: 'code.write' },
    ];
    const result = parseApprovalReply('yes abc123', multi);
    expect(result?.approvalId).toBe('abc123');
    expect(result?.decision).toBe('approved');
  });

  it('returns null for multi-pending without explicit id', () => {
    const multi = [
      { approvalId: 'abc123', toolName: 'send_message', actionClass: 'comms.write' },
      { approvalId: 'xyz456', toolName: 'write_file', actionClass: 'code.write' },
    ];
    expect(parseApprovalReply('yes', multi)).toBeNull();
  });
});
```

**Run test:** `npx vitest run src/__tests__/trust-approval-handler.test.ts`

**Verification:** All tests pass.

### 5c. Wire into `src/index.ts`

In `src/index.ts`, before or after the existing event-bus imports, add:

```typescript
import { handlePotentialApprovalReply } from './trust-approval-handler.js';
import { startTrustGateway } from './trust-gateway.js';
import { TRUST_APPROVAL_TIMEOUT_MS } from './config.js';
import { formatApprovalPrompt } from './trust-approval-handler.js';
```

In the main startup section (where channels are started and `startIpcWatcher` is called), add after `startIpcWatcher(...)`:

```typescript
// Start trust gateway (containers call this before write/transact ops)
startTrustGateway({
  sendApprovalPrompt: async (chatJid, approvalId, actionClass, toolName, description) => {
    const msg = formatApprovalPrompt(
      approvalId,
      actionClass,
      toolName,
      description,
      Math.floor(TRUST_APPROVAL_TIMEOUT_MS / 60000),
    );
    await sendMessage(chatJid, msg);
  },
  sendTimeoutNotification: async (chatJid, toolName) => {
    await sendMessage(chatJid, `⏱ Approval request for \`${toolName}\` timed out.`);
  },
});
```

In the inbound message handler (where messages are queued for agent processing), before enqueuing the message, check if it's an approval reply. The pending approval IDs for a `chatJid` can be found via a DB query for pending approvals on that `chat_jid`. Add a helper in `src/db.ts`:

```typescript
export function getPendingTrustApprovalIds(chatJid: string): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM trust_approvals WHERE chat_jid = ? AND status = 'pending' AND expires_at > ?`,
    )
    .all(chatJid, new Date().toISOString()) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
```

Then in `src/index.ts` in the message dispatch loop, intercept before agent invocation:

```typescript
// Check if this message resolves a pending trust approval
const pendingIds = getPendingTrustApprovalIds(chatJid);
if (pendingIds.length > 0) {
  const consumed = handlePotentialApprovalReply(messageText, chatJid, pendingIds);
  if (consumed) {
    // Don't route to agent — this was an approval response
    continue; // or return, depending on the loop structure
  }
}
```

**Note:** The exact insertion point in `src/index.ts` depends on the message dispatch structure. Read the current loop before inserting to find the right location — look for where `groupQueue.enqueue(...)` or the agent invocation happens after a message is received.

---

## Task 6: Add user trust commands

Trust commands are handled in `src/index.ts` in the same place as other command parsing. The agent trigger message is already parsed — add trust command detection before the agent queue.

### 6a. Add trust command parser in `src/trust-commands.ts`

```typescript
/**
 * Trust command parsing and response formatting.
 * Commands: trust status, never auto-execute [class], reset trust
 */

import {
  getAllTrustLevels,
  resetTrustLevels,
  setTrustAutoExecute,
} from './db.js';
import type { ActionClass } from './trust-engine.js';

export type TrustCommand =
  | { type: 'status' }
  | { type: 'never_auto'; actionClass: ActionClass }
  | { type: 'reset' };

/** Parse a trigger-stripped message into a trust command, or null. */
export function parseTrustCommand(text: string): TrustCommand | null {
  const lower = text.trim().toLowerCase();

  if (lower === 'trust status' || lower.startsWith('trust status')) {
    return { type: 'status' };
  }

  const neverMatch = lower.match(
    /^never\s+auto[-\s]?execute\s+([a-z]+\.[a-z]+)$/,
  );
  if (neverMatch) {
    return { type: 'never_auto', actionClass: neverMatch[1] as ActionClass };
  }

  if (lower === 'reset trust') {
    return { type: 'reset' };
  }

  return null;
}

const CONFIDENCE_BAR_LENGTH = 10;
function confidenceBar(confidence: number): string {
  const filled = Math.round(confidence * CONFIDENCE_BAR_LENGTH);
  return '█'.repeat(filled) + '░'.repeat(CONFIDENCE_BAR_LENGTH - filled);
}

/** Execute a trust command and return the response text. */
export function executeTrustCommand(
  command: TrustCommand,
  groupId: string,
): string {
  switch (command.type) {
    case 'status': {
      const levels = getAllTrustLevels(groupId);
      if (levels.length === 0) {
        return '🔒 *Trust Status*\n\nNo trust data yet — everything requires approval (cold start).';
      }
      const lines = ['🔒 *Trust Status*', ''];
      for (const level of levels) {
        const bar = confidenceBar(level.confidence);
        const pct = (level.confidence * 100).toFixed(0);
        const gate = !level.auto_execute ? ' 🔐 manual' : '';
        lines.push(
          `**${level.action_class}**${gate}`,
          `[${bar}] ${pct}% (${level.approvals}✓ ${level.denials}✗, threshold ${(level.threshold * 100).toFixed(0)}%)`,
          '',
        );
      }
      return lines.join('\n').trim();
    }

    case 'never_auto': {
      setTrustAutoExecute(command.actionClass, groupId, false, 1.0);
      return `🔐 \`${command.actionClass}\` is now permanently gated — will always ask for approval.`;
    }

    case 'reset': {
      resetTrustLevels(groupId);
      return '🔄 Trust levels reset to cold start. All actions will require approval again.';
    }
  }
}
```

### 6b. Tests

Create `src/__tests__/trust-commands.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, upsertTrustLevel } from '../db.js';
import { parseTrustCommand, executeTrustCommand } from '../trust-commands.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

describe('parseTrustCommand', () => {
  it('parses "trust status"', () => {
    expect(parseTrustCommand('trust status')).toEqual({ type: 'status' });
  });

  it('parses "never auto-execute health.write"', () => {
    expect(parseTrustCommand('never auto-execute health.write')).toEqual({
      type: 'never_auto',
      actionClass: 'health.write',
    });
  });

  it('parses "never autoexecute code.transact"', () => {
    expect(parseTrustCommand('never autoexecute code.transact')).toEqual({
      type: 'never_auto',
      actionClass: 'code.transact',
    });
  });

  it('parses "reset trust"', () => {
    expect(parseTrustCommand('reset trust')).toEqual({ type: 'reset' });
  });

  it('returns null for unrecognized commands', () => {
    expect(parseTrustCommand('hello')).toBeNull();
    expect(parseTrustCommand('what is trust')).toBeNull();
  });
});

describe('executeTrustCommand', () => {
  it('status with no data returns cold start message', () => {
    const result = executeTrustCommand({ type: 'status' }, 'group1');
    expect(result).toContain('cold start');
  });

  it('status shows level data', () => {
    upsertTrustLevel({
      action_class: 'comms.write',
      group_id: 'group1',
      approvals: 5,
      denials: 0,
      confidence: 0.833,
      threshold: 0.8,
      auto_execute: true,
      last_updated: new Date().toISOString(),
    });
    const result = executeTrustCommand({ type: 'status' }, 'group1');
    expect(result).toContain('comms.write');
    expect(result).toContain('5');
  });

  it('never_auto sets manual gate', () => {
    const result = executeTrustCommand({ type: 'never_auto', actionClass: 'health.transact' }, 'group1');
    expect(result).toContain('permanently gated');
  });

  it('reset clears all data', () => {
    upsertTrustLevel({
      action_class: 'comms.write',
      group_id: 'group1',
      approvals: 5,
      denials: 0,
      confidence: 0.833,
      threshold: 0.8,
      auto_execute: true,
      last_updated: new Date().toISOString(),
    });
    executeTrustCommand({ type: 'reset' }, 'group1');
    const statusResult = executeTrustCommand({ type: 'status' }, 'group1');
    expect(statusResult).toContain('cold start');
  });
});
```

### 6c. Wire into `src/index.ts`

In the message routing section of `src/index.ts`, after stripping the trigger prefix and before enqueueing for agent processing, add:

```typescript
import { parseTrustCommand, executeTrustCommand } from './trust-commands.js';
import { getAllRegisteredGroups } from './db.js';

// Handle trust commands (after trigger strip)
const strippedText = messageText.replace(triggerPattern, '').trim();
const trustCmd = parseTrustCommand(strippedText);
if (trustCmd) {
  const response = executeTrustCommand(trustCmd, groupFolder);
  await sendMessage(chatJid, response);
  return; // consumed
}
```

**Note:** The exact location depends on where the trigger is stripped in the current `index.ts`. Read the relevant section before inserting.

---

## Task 7: Wire containers to trust gateway

Containers must be told where the trust gateway is and call it before executing write/transact operations.

### 7a. Update `src/container-runner.ts`

In the `buildEnvironment` function (or wherever environment variables are constructed for the container), add `TRUST_GATEWAY_URL` alongside `ONECLI_URL`. Search for where `ONECLI_URL` is passed to find the right location:

```typescript
import { TRUST_GATEWAY_URL } from './config.js';

// In the env vars array passed to the container spawn:
`TRUST_GATEWAY_URL=${TRUST_GATEWAY_URL}`,
```

Look for the section that builds the `-e` flags for `docker run`. Add after the `ONECLI_URL` line:

```
-e TRUST_GATEWAY_URL=http://host.docker.internal:10255
```

Or, if the env is built as an array of key-value pairs:

```typescript
{ name: 'TRUST_GATEWAY_URL', value: TRUST_GATEWAY_URL },
```

Read `src/container-runner.ts` lines 350–500 to find the exact spawn arguments construction before inserting.

### 7b. Update container agent-runner to call trust gateway

The container-side agent runner (`container/agent-runner/src/index.ts`) needs a trust gateway client. Add a new file `container/agent-runner/src/trust-client.ts`:

```typescript
/**
 * Trust Gateway Client — runs inside container
 *
 * Called by agent tools before executing write/transact operations.
 * Polls for user approval if needed.
 */

const TRUST_GATEWAY_URL =
  process.env.TRUST_GATEWAY_URL || 'http://host.docker.internal:10255';
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 600; // 30 min / 3s = 600 polls

interface EvaluateRequest {
  tool_name: string;
  action_class?: string;
  description?: string;
  group_id: string;
  chat_jid: string;
}

interface EvaluateResponse {
  decision: 'approved' | 'pending';
  reason?: string;
  approval_id?: string;
  timeout_s?: number;
}

interface PollResponse {
  decision: 'approved' | 'denied' | 'pending' | 'timeout';
}

async function fetchJson<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trust gateway ${options.method ?? 'GET'} ${url}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Request trust approval for an action.
 * Returns true if approved (auto or user), false if denied/timeout.
 *
 * Blocks until resolved or timeout.
 */
export async function requestTrustApproval(params: {
  toolName: string;
  actionClass?: string;
  description?: string;
  groupId: string;
  chatJid: string;
}): Promise<{ approved: boolean; reason?: string }> {
  const body: EvaluateRequest = {
    tool_name: params.toolName,
    action_class: params.actionClass,
    description: params.description,
    group_id: params.groupId,
    chat_jid: params.chatJid,
  };

  const evalResp = await fetchJson<EvaluateResponse>(
    `${TRUST_GATEWAY_URL}/trust/evaluate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  if (evalResp.decision === 'approved') {
    return { approved: true, reason: evalResp.reason };
  }

  // Poll until resolved
  if (!evalResp.approval_id) {
    return { approved: false, reason: 'no approval_id returned' };
  }

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const pollResp = await fetchJson<PollResponse>(
      `${TRUST_GATEWAY_URL}/trust/approval/${evalResp.approval_id}`,
    );

    if (pollResp.decision === 'approved') return { approved: true };
    if (pollResp.decision === 'denied') return { approved: false, reason: 'user denied' };
    if (pollResp.decision === 'timeout') return { approved: false, reason: 'approval timed out' };
    // 'pending' → keep polling
  }

  return { approved: false, reason: 'polling exhausted' };
}
```

### 7c. Wrap tool calls in agent-runner

In `container/agent-runner/src/index.ts`, the agent uses Claude SDK's `query()`. The trust gateway interception happens at the **MCP tool level** — tools that write/transact should call `requestTrustApproval` before executing.

The cleanest integration point is within custom tool handlers. Look for where MCP tools are defined or wrapped in the agent-runner. If the agent uses an MCP server via `ipc-mcp-stdio.ts`, the trust check should be added there.

Read `container/agent-runner/src/ipc-mcp-stdio.ts` to understand the tool dispatch pattern. Add trust checks for tools classified as `write` or `transact`:

```typescript
import { requestTrustApproval } from './trust-client.js';

// Before executing a write/transact tool:
const SKIP_TRUST_TOOLS = new Set(['read_file', 'list_files', 'web_search', 'search_contacts']);

if (!SKIP_TRUST_TOOLS.has(toolName)) {
  const { approved, reason } = await requestTrustApproval({
    toolName,
    groupId: config.groupFolder,
    chatJid: config.chatJid,
  });
  if (!approved) {
    return { content: [{ type: 'text', text: `Action blocked: ${reason ?? 'not approved'}` }] };
  }
}
```

**Note:** Read `container/agent-runner/src/ipc-mcp-stdio.ts` fully before implementing Task 7c — the exact integration point depends on how MCP tools are dispatched there.

---

## Task 8: Integration test

Create `src/__tests__/trust-integration.test.ts`:

```typescript
/**
 * Integration test: full trust flow
 * container calls write tool → gateway creates pending → user approves → auto-approved on repeat
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { _initTestDatabase, _closeDatabase } from '../db.js';
import { startTrustGateway, stopTrustGateway } from '../trust-gateway.js';
import { recordTrustDecision } from '../trust-engine.js';

const TEST_PORT = 19256;
process.env.TRUST_GATEWAY_PORT = String(TEST_PORT);

async function post(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: TEST_PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function get(path: string): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: TEST_PORT, path, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const promptsSent: string[] = [];
const mockDeps = {
  sendApprovalPrompt: async (chatJid: string, approvalId: string) => {
    promptsSent.push(approvalId);
  },
  sendTimeoutNotification: async () => {},
};

beforeEach(async () => {
  promptsSent.length = 0;
  _initTestDatabase();
  startTrustGateway(mockDeps);
  await new Promise((r) => setTimeout(r, 50));
});

afterEach(async () => {
  await stopTrustGateway();
  _closeDatabase();
});

describe('full approval flow', () => {
  it('cold start → pending → user approves → resolved', async () => {
    // 1. Container requests trust for a write action
    const evalRes = await post('/trust/evaluate', {
      tool_name: 'send_message',
      group_id: 'group1',
      chat_jid: 'tg:123',
      description: 'Send a report',
    });
    expect(evalRes.status).toBe(202);
    const approvalId = (evalRes.data as any).approval_id;
    expect(approvalId).toBeDefined();

    // 2. Approval prompt was sent to user
    expect(promptsSent).toContain(approvalId);

    // 3. Container polls — still pending
    const poll1 = await get(`/trust/approval/${approvalId}`);
    expect((poll1.data as any).decision).toBe('pending');

    // 4. User approves
    await post(`/trust/resolve/${approvalId}`, { decision: 'approved' });

    // 5. Container polls — now approved
    const poll2 = await get(`/trust/approval/${approvalId}`);
    expect((poll2.data as any).decision).toBe('approved');
  });

  it('graduation: after 5 approvals, auto-execute without asking', async () => {
    // Simulate 5 prior approvals
    for (let i = 0; i < 5; i++) {
      recordTrustDecision('send_message', 'group1', 'approved');
    }

    // 6th call → auto-approved
    const res = await post('/trust/evaluate', {
      tool_name: 'send_message',
      group_id: 'group1',
      chat_jid: 'tg:123',
    });
    expect(res.status).toBe(200);
    expect((res.data as any).decision).toBe('approved');
    expect(promptsSent).toHaveLength(0); // no prompt sent
  });

  it('denial resets progress toward graduation', async () => {
    for (let i = 0; i < 4; i++) {
      recordTrustDecision('send_message', 'group1', 'approved');
    }
    recordTrustDecision('send_message', 'group1', 'denied');
    recordTrustDecision('send_message', 'group1', 'denied');

    const res = await post('/trust/evaluate', {
      tool_name: 'send_message',
      group_id: 'group1',
      chat_jid: 'tg:123',
    });
    expect(res.status).toBe(202); // still needs approval
  });
});
```

**Run test:** `npx vitest run src/__tests__/trust-integration.test.ts`

---

## Task 9: Final verification

Run all trust-related tests and the full build in sequence:

```bash
cd /path/to/project

# Run all trust tests
npx vitest run src/__tests__/trust-db.test.ts
npx vitest run src/__tests__/trust-engine.test.ts
npx vitest run src/__tests__/trust-gateway.test.ts
npx vitest run src/__tests__/trust-approval-handler.test.ts
npx vitest run src/__tests__/trust-commands.test.ts
npx vitest run src/__tests__/trust-integration.test.ts

# Full build — zero TypeScript errors expected
npm run build
```

**Expected results:**
- All test suites: PASS
- Build: 0 errors, 0 warnings on trust files
- `npm run dev` starts without error; trust gateway logs `Trust gateway started` on port 10255

### Checklist

- [ ] `src/events.ts` — 4 new trust event types added, EventMap updated
- [ ] `src/db.ts` — 3 new tables (trust_actions, trust_levels, trust_approvals), 10 new DB functions
- [ ] `src/trust-engine.ts` — classification, confidence, threshold evaluation
- [ ] `src/trust-gateway.ts` — HTTP server with evaluate/poll/resolve endpoints + expiry checker
- [ ] `src/trust-approval-handler.ts` — approval prompt formatting + reply parsing
- [ ] `src/trust-commands.ts` — trust status/never-auto/reset commands
- [ ] `src/config.ts` — TRUST_GATEWAY_PORT, TRUST_GATEWAY_URL, TRUST_APPROVAL_TIMEOUT_MS added
- [ ] `src/index.ts` — gateway started at startup, approval replies intercepted, trust commands wired
- [ ] `src/container-runner.ts` — TRUST_GATEWAY_URL env var passed to containers
- [ ] `container/agent-runner/src/trust-client.ts` — trust gateway HTTP client for container side
- [ ] `container/agent-runner/src/ipc-mcp-stdio.ts` (or equivalent) — trust check before write/transact tools
- [ ] All 6 test files created and passing

---

## Implementation notes

**Port assignment:** 10255 for trust gateway (10254 is OneCLI, 10256+ reserved for future services).

**Container networking:** Containers reach the host via `host.docker.internal` — same mechanism as OneCLI. No new networking setup needed.

**Per-group trust:** Trust levels are scoped to `(action_class, group_id)` pairs. Different groups build trust independently.

**No LLM classification in MVP:** The spec mentions LLM self-classification for novel tools. The MVP uses the static map + `services.transact` fallback. LLM classification can be added in a follow-up by calling OneCLI from inside the trust gateway.

**Approval reply threading:** The approval reply check (Task 5c) runs before messages are enqueued for the agent. This means "yes" to an approval doesn't spawn an agent turn — it's consumed by the host. This is intentional: approval replies should be fast and not require agent processing.

**Cold start on denial:** When a user denies an action, `denials` increments and confidence drops. With the formula `N/(N+D+1)`, a single denial after 4 approvals drops from `4/5=0.8` to `4/6=0.67`, which falls below the 0.8 write threshold. This is the intended "trust easy to lose" behavior.
