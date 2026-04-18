# Learning System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire outcome-based learning into NanoClaw — distill rules from outcomes/feedback, inject into agent prompts, record and match procedures, auto-execute with user opt-in.

**Architecture:** Event-driven learning loop. Rules engine distills outcomes + user feedback into actionable rules. Outcome enricher injects relevant rules into agent prompts. Procedure recorder captures IPC traces from successful tasks. Procedure matcher offers/auto-executes matched procedures.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), vitest, existing EventBus

---

## Task 1: Learn Event Types

Add 7 `learn.*` event interfaces and EventMap entries to `src/events.ts`.

- [ ] **Step 1.1** — Add event interfaces and EventMap entries to `src/events.ts`

  Append after the `BrowserVisualChangedEvent` interface (before the `EventMap`), and add entries to `EventMap`:

  ```typescript
  // --- Learn events ---

  export interface LearnRuleCreatedEvent extends NanoClawEvent {
    type: 'learn.rule_created';
    source: 'learning';
    payload: {
      ruleId: string;
      rule: string;
      source: 'outcome_pattern' | 'user_feedback' | 'agent_reported';
      groupId: string | null;
    };
  }

  export interface LearnRuleAppliedEvent extends NanoClawEvent {
    type: 'learn.rule_applied';
    source: 'learning';
    payload: {
      ruleId: string;
      groupId: string;
      taskId: string;
    };
  }

  export interface LearnProcedureSavedEvent extends NanoClawEvent {
    type: 'learn.procedure_saved';
    source: 'learning';
    payload: {
      name: string;
      trigger: string;
      groupId: string;
      stepCount: number;
    };
  }

  export interface LearnProcedureMatchedEvent extends NanoClawEvent {
    type: 'learn.procedure_matched';
    source: 'learning';
    payload: {
      name: string;
      trigger: string;
      groupId: string;
      autoExecute: boolean;
    };
  }

  export interface LearnProcedureExecutedEvent extends NanoClawEvent {
    type: 'learn.procedure_executed';
    source: 'learning';
    payload: {
      name: string;
      groupId: string;
      success: boolean;
      durationMs: number;
    };
  }

  export interface LearnProcedurePromotedEvent extends NanoClawEvent {
    type: 'learn.procedure_promoted';
    source: 'learning';
    payload: {
      name: string;
      fromGroups: string[];
      stepCount: number;
    };
  }

  export interface LearnFeedbackReceivedEvent extends NanoClawEvent {
    type: 'learn.feedback_received';
    source: 'learning';
    payload: {
      ruleId: string;
      feedback: string;
      groupId: string;
    };
  }
  ```

  In `EventMap`, add after `'browser.visual.changed': BrowserVisualChangedEvent;`:

  ```typescript
  'learn.rule_created': LearnRuleCreatedEvent;
  'learn.rule_applied': LearnRuleAppliedEvent;
  'learn.procedure_saved': LearnProcedureSavedEvent;
  'learn.procedure_matched': LearnProcedureMatchedEvent;
  'learn.procedure_executed': LearnProcedureExecutedEvent;
  'learn.procedure_promoted': LearnProcedurePromotedEvent;
  'learn.feedback_received': LearnFeedbackReceivedEvent;
  ```

- [ ] **Step 1.2** — Verify types compile

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit
  ```

---

## Task 2: Rules Engine

Create `src/learning/rules-engine.ts` and `src/learning/rules-engine.test.ts`.

- [ ] **Step 2.1** — Write failing tests first

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/rules-engine.test.ts`:

  ```typescript
  import { describe, it, expect, vi, beforeEach } from 'vitest';

  vi.mock('../logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  const mockDb = {
    exec: vi.fn(),
    prepare: vi.fn(),
  };

  vi.mock('../db.js', () => ({ getDb: vi.fn(() => mockDb) }));

  import {
    initRulesStore,
    addRule,
    queryRules,
    markMatched,
    pruneStaleRules,
    deleteRule,
    decayConfidence,
  } from './rules-engine.js';

  describe('initRulesStore', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates learned_rules table and FTS index', () => {
      initRulesStore();
      expect(mockDb.exec).toHaveBeenCalledOnce();
      const sql = mockDb.exec.mock.calls[0][0] as string;
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS learned_rules');
      expect(sql).toContain('fts5');
    });
  });

  describe('addRule', () => {
    beforeEach(() => vi.clearAllMocks());

    it('inserts rule and returns generated id', () => {
      const mockRun = vi.fn().mockReturnValue({ lastInsertRowid: 1 });
      const mockInsertStmt = { run: mockRun };
      const mockFtsStmt = { run: vi.fn() };
      let callCount = 0;
      mockDb.prepare.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockInsertStmt : mockFtsStmt;
      });

      const id = addRule({
        rule: 'Refresh OAuth before email ops',
        source: 'outcome_pattern',
        actionClasses: ['email.read'],
        groupId: 'g1',
        confidence: 0.5,
        evidenceCount: 2,
      });

      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect(mockRun).toHaveBeenCalledOnce();
    });
  });

  describe('queryRules', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns rules matching action classes and group', () => {
      const rows = [
        {
          id: 'abc',
          rule: 'Use API not browser',
          source: 'outcome_pattern',
          action_classes: '["github.read"]',
          group_id: 'g1',
          confidence: 0.7,
          evidence_count: 3,
          created_at: new Date().toISOString(),
          last_matched_at: new Date().toISOString(),
        },
      ];
      mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue(rows) });

      const results = queryRules(['github.read'], 'g1');
      expect(results).toHaveLength(1);
      expect(results[0].actionClasses).toEqual(['github.read']);
    });

    it('returns empty array when no rules found', () => {
      mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([]) });
      const results = queryRules(['email.send'], 'g1');
      expect(results).toEqual([]);
    });
  });

  describe('markMatched', () => {
    beforeEach(() => vi.clearAllMocks());

    it('updates last_matched_at for the rule', () => {
      const mockRun = vi.fn();
      mockDb.prepare.mockReturnValue({ run: mockRun });
      markMatched('rule-id-1');
      expect(mockRun).toHaveBeenCalledWith(expect.any(String), 'rule-id-1');
    });
  });

  describe('pruneStaleRules', () => {
    beforeEach(() => vi.clearAllMocks());

    it('deletes rules with confidence below 0.1 and returns count', () => {
      const mockRun = vi.fn().mockReturnValue({ changes: 3 });
      mockDb.prepare.mockReturnValue({ run: mockRun });
      const count = pruneStaleRules();
      expect(count).toBe(3);
    });
  });

  describe('deleteRule', () => {
    beforeEach(() => vi.clearAllMocks());

    it('deletes rule by id from both tables', () => {
      const mockRun = vi.fn();
      mockDb.prepare.mockReturnValue({ run: mockRun });
      deleteRule('rule-id-1');
      expect(mockRun).toHaveBeenCalledTimes(2);
    });
  });

  describe('decayConfidence', () => {
    beforeEach(() => vi.clearAllMocks());

    it('reduces confidence for rules not matched in 30 days', () => {
      const mockRun = vi.fn().mockReturnValue({ changes: 2 });
      mockDb.prepare.mockReturnValue({ run: mockRun });
      const count = decayConfidence();
      expect(count).toBe(2);
    });
  });
  ```

- [ ] **Step 2.2** — Run tests (expect failures)

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/rules-engine.test.ts
  ```

- [ ] **Step 2.3** — Implement `src/learning/rules-engine.ts`

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/rules-engine.ts`:

  ```typescript
  import { randomUUID } from 'crypto';

  import { getDb } from '../db.js';
  import { logger } from '../logger.js';

  export interface LearnedRule {
    id: string;
    rule: string;
    source: 'outcome_pattern' | 'user_feedback' | 'agent_reported';
    actionClasses: string[];
    groupId: string | null;
    confidence: number;
    evidenceCount: number;
    createdAt: string;
    lastMatchedAt: string;
  }

  export type AddRuleInput = Omit<LearnedRule, 'id' | 'createdAt' | 'lastMatchedAt'>;

  interface RuleRow {
    id: string;
    rule: string;
    source: string;
    action_classes: string;
    group_id: string | null;
    confidence: number;
    evidence_count: number;
    created_at: string;
    last_matched_at: string;
  }

  function rowToRule(row: RuleRow): LearnedRule {
    return {
      id: row.id,
      rule: row.rule,
      source: row.source as LearnedRule['source'],
      actionClasses: JSON.parse(row.action_classes) as string[],
      groupId: row.group_id,
      confidence: row.confidence,
      evidenceCount: row.evidence_count,
      createdAt: row.created_at,
      lastMatchedAt: row.last_matched_at,
    };
  }

  export function initRulesStore(): void {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS learned_rules (
        id TEXT PRIMARY KEY,
        rule TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('outcome_pattern', 'user_feedback', 'agent_reported')),
        action_classes TEXT NOT NULL,
        group_id TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_matched_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS learned_rules_fts USING fts5(
        rule,
        action_classes,
        content=learned_rules,
        content_rowid=rowid
      );
      CREATE TRIGGER IF NOT EXISTS learned_rules_fts_insert
        AFTER INSERT ON learned_rules BEGIN
          INSERT INTO learned_rules_fts(rowid, rule, action_classes)
          VALUES (new.rowid, new.rule, new.action_classes);
        END;
      CREATE TRIGGER IF NOT EXISTS learned_rules_fts_delete
        AFTER DELETE ON learned_rules BEGIN
          INSERT INTO learned_rules_fts(learned_rules_fts, rowid, rule, action_classes)
          VALUES ('delete', old.rowid, old.rule, old.action_classes);
        END;
    `);
    logger.debug('Rules store initialized');
  }

  export function addRule(input: AddRuleInput): string {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO learned_rules (id, rule, source, action_classes, group_id, confidence, evidence_count, created_at, last_matched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.rule,
      input.source,
      JSON.stringify(input.actionClasses),
      input.groupId,
      input.confidence,
      input.evidenceCount,
      now,
      now,
    );

    logger.debug({ id, source: input.source, groupId: input.groupId }, 'Rule added');
    return id;
  }

  export function queryRules(
    actionClasses: string[],
    groupId: string,
    limit = 5,
  ): LearnedRule[] {
    const db = getDb();
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const classFilter = actionClasses.map(() => "action_classes LIKE ?").join(' OR ');
    const sql = classFilter
      ? `SELECT * FROM learned_rules
         WHERE (group_id = ? OR group_id IS NULL)
           AND (${classFilter})
           AND (last_matched_at >= ? OR created_at >= ?)
         ORDER BY confidence DESC LIMIT ?`
      : `SELECT * FROM learned_rules
         WHERE (group_id = ? OR group_id IS NULL)
           AND (last_matched_at >= ? OR created_at >= ?)
         ORDER BY confidence DESC LIMIT ?`;

    const params: (string | number)[] = [groupId];
    if (classFilter) {
      for (const cls of actionClasses) params.push(`%${cls}%`);
    }
    params.push(cutoff, cutoff, limit);

    const rows = db.prepare(sql).all(...params) as RuleRow[];
    return rows.map(rowToRule);
  }

  export function markMatched(ruleId: string): void {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`UPDATE learned_rules SET last_matched_at = ? WHERE id = ?`).run(now, ruleId);
  }

  export function pruneStaleRules(): number {
    const db = getDb();
    const result = db
      .prepare(`DELETE FROM learned_rules WHERE confidence < 0.1`)
      .run();
    const count = result.changes;
    if (count > 0) logger.info({ count }, 'Pruned stale rules');
    return count;
  }

  export function deleteRule(id: string): void {
    const db = getDb();
    db.prepare(`DELETE FROM learned_rules_fts WHERE rowid = (SELECT rowid FROM learned_rules WHERE id = ?)`).run(id);
    db.prepare(`DELETE FROM learned_rules WHERE id = ?`).run(id);
  }

  export function decayConfidence(): number {
    const db = getDb();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = db
      .prepare(
        `UPDATE learned_rules
         SET confidence = MAX(0.0, confidence - 0.1)
         WHERE last_matched_at < ?`,
      )
      .run(cutoff);
    return result.changes;
  }
  ```

- [ ] **Step 2.4** — Run tests (expect pass)

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/rules-engine.test.ts
  ```

- [ ] **Step 2.5** — Typecheck

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit
  ```

---

## Task 3: Outcome Enricher

Create `src/learning/outcome-enricher.ts` and `src/learning/outcome-enricher.test.ts`.

- [ ] **Step 3.1** — Write failing tests first

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/outcome-enricher.test.ts`:

  ```typescript
  import { describe, it, expect, vi, beforeEach } from 'vitest';

  vi.mock('../logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  const mockQueryRules = vi.fn();
  const mockMarkMatched = vi.fn();

  vi.mock('./rules-engine.js', () => ({
    queryRules: (...args: unknown[]) => mockQueryRules(...args),
    markMatched: (...args: unknown[]) => mockMarkMatched(...args),
  }));

  import { inferActionClasses, buildRulesBlock } from './outcome-enricher.js';

  describe('inferActionClasses', () => {
    it('maps email keywords to email action classes', () => {
      const classes = inferActionClasses('check my gmail inbox for unread messages');
      expect(classes).toContain('email.read');
      expect(classes).toContain('email.send');
    });

    it('maps github keywords to github action classes', () => {
      const classes = inferActionClasses('what is the status of my PR on github?');
      expect(classes).toContain('github.read');
    });

    it('maps browser keywords to browser action classes', () => {
      const classes = inferActionClasses('navigate to the website and click login');
      expect(classes).toContain('browser.read');
    });

    it('maps schedule keywords to task.schedule', () => {
      const classes = inferActionClasses('remind me to check the schedule tomorrow');
      expect(classes).toContain('task.schedule');
    });

    it('returns empty array for unrecognized message', () => {
      const classes = inferActionClasses('hello world');
      expect(classes).toEqual([]);
    });
  });

  describe('buildRulesBlock', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns null when no rules found', () => {
      mockQueryRules.mockReturnValue([]);
      const result = buildRulesBlock('check my email', 'g1');
      expect(result).toBeNull();
    });

    it('formats rules as a compact block', () => {
      mockQueryRules.mockReturnValue([
        {
          id: 'r1',
          rule: 'Refresh OAuth tokens before email ops',
          source: 'outcome_pattern',
          actionClasses: ['email.read'],
          groupId: 'g1',
          confidence: 0.8,
          evidenceCount: 3,
          createdAt: new Date().toISOString(),
          lastMatchedAt: new Date().toISOString(),
        },
      ]);

      const result = buildRulesBlock('check my email', 'g1');
      expect(result).not.toBeNull();
      expect(result).toContain('## Learned Rules');
      expect(result).toContain('Refresh OAuth tokens before email ops');
    });

    it('calls markMatched for each injected rule', () => {
      mockQueryRules.mockReturnValue([
        {
          id: 'r1',
          rule: 'Use API not browser',
          source: 'outcome_pattern',
          actionClasses: ['github.read'],
          groupId: 'g1',
          confidence: 0.7,
          evidenceCount: 2,
          createdAt: new Date().toISOString(),
          lastMatchedAt: new Date().toISOString(),
        },
      ]);

      buildRulesBlock('check PR status', 'g1');
      expect(mockMarkMatched).toHaveBeenCalledWith('r1');
    });

    it('truncates block to 500 characters', () => {
      const longRule = 'A'.repeat(200);
      mockQueryRules.mockReturnValue(
        Array.from({ length: 5 }, (_, i) => ({
          id: `r${i}`,
          rule: longRule,
          source: 'outcome_pattern',
          actionClasses: ['email.read'],
          groupId: 'g1',
          confidence: 0.8,
          evidenceCount: 1,
          createdAt: new Date().toISOString(),
          lastMatchedAt: new Date().toISOString(),
        })),
      );

      const result = buildRulesBlock('check email', 'g1');
      expect(result).not.toBeNull();
      expect(result!.length).toBeLessThanOrEqual(500);
    });
  });
  ```

- [ ] **Step 3.2** — Run tests (expect failures)

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/outcome-enricher.test.ts
  ```

- [ ] **Step 3.3** — Implement `src/learning/outcome-enricher.ts`

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/outcome-enricher.ts`:

  ```typescript
  import { logger } from '../logger.js';
  import { markMatched, queryRules } from './rules-engine.js';

  export const ACTION_CLASS_KEYWORDS: Record<string, string[]> = {
    email: ['email.read', 'email.send'],
    gmail: ['email.read', 'email.send'],
    inbox: ['email.read', 'email.send'],
    message: ['email.read', 'email.send'],
    PR: ['github.read', 'github.write'],
    'pull request': ['github.read', 'github.write'],
    github: ['github.read', 'github.write'],
    repo: ['github.read', 'github.write'],
    commit: ['github.read', 'github.write'],
    browser: ['browser.read', 'browser.write'],
    website: ['browser.read', 'browser.write'],
    page: ['browser.read', 'browser.write'],
    navigate: ['browser.read', 'browser.write'],
    click: ['browser.read', 'browser.write'],
    cost: ['cost.read'],
    budget: ['cost.read'],
    spending: ['cost.read'],
    schedule: ['task.schedule'],
    task: ['task.schedule'],
    reminder: ['task.schedule'],
  };

  export function inferActionClasses(message: string): string[] {
    const lower = message.toLowerCase();
    const found = new Set<string>();

    for (const [keyword, classes] of Object.entries(ACTION_CLASS_KEYWORDS)) {
      if (lower.includes(keyword.toLowerCase())) {
        for (const cls of classes) found.add(cls);
      }
    }

    return Array.from(found);
  }

  export function buildRulesBlock(message: string, groupId: string): string | null {
    const actionClasses = inferActionClasses(message);
    const rules = queryRules(actionClasses, groupId, 5);

    if (rules.length === 0) return null;

    const header = '## Learned Rules (auto-generated)\n';
    const lines: string[] = [];
    let totalLen = header.length;

    for (const rule of rules) {
      const line = `- ${rule.rule}`;
      if (totalLen + line.length + 1 > 500) break;
      lines.push(line);
      totalLen += line.length + 1;
    }

    if (lines.length === 0) return null;

    for (const rule of rules.slice(0, lines.length)) {
      markMatched(rule.id);
    }

    logger.debug({ groupId, ruleCount: lines.length }, 'Injecting learned rules into prompt');
    return header + lines.join('\n');
  }
  ```

- [ ] **Step 3.4** — Run tests (expect pass)

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/outcome-enricher.test.ts
  ```

- [ ] **Step 3.5** — Typecheck

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit
  ```

---

## Task 4: Procedure Recorder

Create `src/learning/procedure-recorder.ts` and `src/learning/procedure-recorder.test.ts`.

- [ ] **Step 4.1** — Write failing tests first

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/procedure-recorder.test.ts`:

  ```typescript
  import { describe, it, expect, vi, beforeEach } from 'vitest';

  vi.mock('../logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  const mockSaveProcedure = vi.fn();
  const mockFindProcedure = vi.fn();

  vi.mock('../memory/procedure-store.js', () => ({
    saveProcedure: (...args: unknown[]) => mockSaveProcedure(...args),
    findProcedure: (...args: unknown[]) => mockFindProcedure(...args),
  }));

  import {
    startTrace,
    addTrace,
    finalizeTrace,
  } from './procedure-recorder.js';

  describe('startTrace', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates a trace buffer entry without errors', () => {
      expect(() => startTrace('g1', 'task-1')).not.toThrow();
    });
  });

  describe('addTrace', () => {
    beforeEach(() => vi.clearAllMocks());

    it('appends action to trace buffer', () => {
      startTrace('g1', 'task-2');
      expect(() =>
        addTrace('g1', 'task-2', {
          type: 'browser_navigate',
          timestamp: Date.now(),
          inputSummary: 'https://github.com',
          result: 'success',
        }),
      ).not.toThrow();
    });

    it('silently ignores addTrace when no trace started', () => {
      expect(() =>
        addTrace('g1', 'no-trace-task', {
          type: 'send_message',
          timestamp: Date.now(),
          inputSummary: 'hello',
          result: 'success',
        }),
      ).not.toThrow();
    });
  });

  describe('finalizeTrace', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockFindProcedure.mockReturnValue(null);
    });

    it('discards trace on failure', () => {
      startTrace('g1', 'task-fail');
      addTrace('g1', 'task-fail', { type: 'browser_navigate', timestamp: Date.now(), inputSummary: 'x', result: 'success' });
      addTrace('g1', 'task-fail', { type: 'send_message', timestamp: Date.now(), inputSummary: 'y', result: 'success' });
      finalizeTrace('g1', 'task-fail', false);
      expect(mockSaveProcedure).not.toHaveBeenCalled();
    });

    it('saves procedure from IPC trace on success with 2+ actions', () => {
      startTrace('g1', 'task-ok');
      addTrace('g1', 'task-ok', { type: 'github_api', timestamp: Date.now(), inputSummary: 'GET /pulls', result: 'success' });
      addTrace('g1', 'task-ok', { type: 'send_message', timestamp: Date.now(), inputSummary: 'PR is open', result: 'success' });
      finalizeTrace('g1', 'task-ok', true);
      expect(mockSaveProcedure).toHaveBeenCalledOnce();
    });

    it('skips save when fewer than 2 actions', () => {
      startTrace('g1', 'task-single');
      addTrace('g1', 'task-single', { type: 'send_message', timestamp: Date.now(), inputSummary: 'hi', result: 'success' });
      finalizeTrace('g1', 'task-single', true);
      expect(mockSaveProcedure).not.toHaveBeenCalled();
    });

    it('uses agent procedure name/description when provided', () => {
      startTrace('g1', 'task-agent');
      addTrace('g1', 'task-agent', { type: 'github_api', timestamp: Date.now(), inputSummary: 'GET /pulls', result: 'success' });
      addTrace('g1', 'task-agent', { type: 'send_message', timestamp: Date.now(), inputSummary: 'done', result: 'success' });
      finalizeTrace('g1', 'task-agent', true, {
        name: 'check-pr-status',
        trigger: 'check PR status',
        description: 'Check GitHub PR status and summarize',
        steps: [
          { action: 'github_api', details: 'GET /repos/{owner}/{repo}/pulls/{number}' },
          { action: 'format_response', details: 'Summarize PR title, status, reviewers' },
        ],
      });
      const saved = mockSaveProcedure.mock.calls[0][0];
      expect(saved.name).toBe('check-pr-status');
      expect(saved.trigger).toBe('check PR status');
    });

    it('increments success_count when duplicate procedure found', () => {
      mockFindProcedure.mockReturnValue({
        name: 'check-pr-status',
        trigger: 'check PR status',
        description: 'existing',
        steps: [{ action: 'github_api' }, { action: 'send_message' }],
        success_count: 5,
        failure_count: 0,
        auto_execute: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        groupId: 'g1',
      });
      startTrace('g1', 'task-dup');
      addTrace('g1', 'task-dup', { type: 'github_api', timestamp: Date.now(), inputSummary: 'GET /pulls', result: 'success' });
      addTrace('g1', 'task-dup', { type: 'send_message', timestamp: Date.now(), inputSummary: 'done', result: 'success' });
      finalizeTrace('g1', 'task-dup', true, {
        name: 'check-pr-status',
        trigger: 'check PR status',
        description: 'Check GitHub PR status',
        steps: [
          { action: 'github_api', details: 'GET /pulls' },
          { action: 'send_message', details: 'send result' },
        ],
      });
      const saved = mockSaveProcedure.mock.calls[0][0];
      expect(saved.success_count).toBe(6);
    });
  });
  ```

- [ ] **Step 4.2** — Run tests (expect failures)

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/procedure-recorder.test.ts
  ```

- [ ] **Step 4.3** — Implement `src/learning/procedure-recorder.ts`

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/procedure-recorder.ts`:

  ```typescript
  import { findProcedure, saveProcedure } from '../memory/procedure-store.js';
  import type { Procedure, ProcedureStep } from '../memory/procedure-store.js';
  import { logger } from '../logger.js';

  export interface TracedAction {
    type: string;
    timestamp: number;
    inputSummary: string;
    result: 'success' | 'error';
  }

  export interface AgentProcedure {
    name: string;
    trigger: string;
    description: string;
    steps: Array<{ action: string; details?: string }>;
  }

  const traceBuffer = new Map<string, TracedAction[]>();

  function traceKey(groupId: string, taskId: string): string {
    return `${groupId}::${taskId}`;
  }

  export function startTrace(groupId: string, taskId: string): void {
    traceBuffer.set(traceKey(groupId, taskId), []);
    logger.debug({ groupId, taskId }, 'Trace started');
  }

  export function addTrace(
    groupId: string,
    taskId: string,
    action: TracedAction,
  ): void {
    const key = traceKey(groupId, taskId);
    const buf = traceBuffer.get(key);
    if (!buf) return;
    buf.push(action);
  }

  function stepsOverlap(
    existing: ProcedureStep[],
    candidate: ProcedureStep[],
  ): number {
    if (existing.length === 0 || candidate.length === 0) return 0;
    const existingActions = new Set(existing.map((s) => s.action));
    const matches = candidate.filter((s) => existingActions.has(s.action)).length;
    return matches / Math.max(existing.length, candidate.length);
  }

  export function finalizeTrace(
    groupId: string,
    taskId: string,
    success: boolean,
    agentProcedure?: AgentProcedure,
  ): void {
    const key = traceKey(groupId, taskId);
    const actions = traceBuffer.get(key) ?? [];
    traceBuffer.delete(key);

    if (!success) {
      logger.debug({ groupId, taskId }, 'Trace discarded (task failed)');
      return;
    }

    if (actions.length < 2) {
      logger.debug({ groupId, taskId, actionCount: actions.length }, 'Trace too short, skipping');
      return;
    }

    const now = new Date().toISOString();

    let steps: ProcedureStep[];
    let name: string;
    let trigger: string;
    let description: string;

    if (agentProcedure) {
      const traceActionTypes = new Set(actions.map((a) => a.type));
      const validAgentSteps = agentProcedure.steps.filter((s) =>
        traceActionTypes.has(s.action),
      );
      const extraTraceSteps = actions
        .filter((a) => !agentProcedure.steps.some((s) => s.action === a.type))
        .map((a) => ({ action: a.type, details: a.inputSummary.slice(0, 100) }));

      steps = [...validAgentSteps, ...extraTraceSteps];
      name = agentProcedure.name;
      trigger = agentProcedure.trigger;
      description = agentProcedure.description;
    } else {
      steps = actions.map((a) => ({
        action: a.type,
        details: a.inputSummary.slice(0, 100),
      }));
      name = `procedure-${groupId}-${Date.now()}`;
      trigger = steps.map((s) => s.action).join(', ');
      description = `Auto-recorded procedure with ${steps.length} steps`;
    }

    const existing = findProcedure(trigger, groupId);

    if (existing) {
      const overlap = stepsOverlap(existing.steps, steps);
      if (overlap >= 0.7) {
        saveProcedure({
          ...existing,
          success_count: existing.success_count + 1,
          updated_at: now,
        });
        logger.debug({ name: existing.name, groupId }, 'Procedure success_count incremented');
        return;
      }
      name = `${name}-v${Date.now()}`;
    }

    const proc: Procedure = {
      name,
      trigger,
      description,
      steps,
      success_count: 1,
      failure_count: 0,
      auto_execute: false,
      created_at: now,
      updated_at: now,
      groupId,
    };

    saveProcedure(proc);
    logger.info({ name, trigger, groupId, stepCount: steps.length }, 'Procedure saved');
  }
  ```

- [ ] **Step 4.4** — Run tests (expect pass)

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/procedure-recorder.test.ts
  ```

- [ ] **Step 4.5** — Typecheck

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit
  ```

---

## Task 5: Procedure Matcher

Create `src/learning/procedure-matcher.ts` and `src/learning/procedure-matcher.test.ts`.

- [ ] **Step 5.1** — Write failing tests first

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/procedure-matcher.test.ts`:

  ```typescript
  import { describe, it, expect, vi, beforeEach } from 'vitest';

  vi.mock('../logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  const mockFindProcedure = vi.fn();
  const mockListProcedures = vi.fn();
  const mockSaveProcedure = vi.fn();
  const mockUpdateProcedureStats = vi.fn();

  vi.mock('../memory/procedure-store.js', () => ({
    findProcedure: (...args: unknown[]) => mockFindProcedure(...args),
    listProcedures: (...args: unknown[]) => mockListProcedures(...args),
    saveProcedure: (...args: unknown[]) => mockSaveProcedure(...args),
    updateProcedureStats: (...args: unknown[]) => mockUpdateProcedureStats(...args),
  }));

  import {
    checkProcedureMatch,
    formatProcedureOffer,
    promoteProcedure,
  } from './procedure-matcher.js';

  describe('checkProcedureMatch', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns null when no procedure matches', () => {
      mockFindProcedure.mockReturnValue(null);
      const result = checkProcedureMatch('hello world', 'g1');
      expect(result).toBeNull();
    });

    it('returns procedure when trigger matches', () => {
      const proc = {
        name: 'check-pr-status',
        trigger: 'check PR status',
        description: 'Check GitHub PR status',
        steps: [{ action: 'github_api' }],
        success_count: 5,
        failure_count: 1,
        auto_execute: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        groupId: 'g1',
      };
      mockFindProcedure.mockReturnValue(proc);
      const result = checkProcedureMatch('check PR status for nanoclaw', 'g1');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('check-pr-status');
    });
  });

  describe('formatProcedureOffer', () => {
    it('formats an offer message with success rate', () => {
      const proc = {
        name: 'check-pr-status',
        trigger: 'check PR status',
        description: 'Check GitHub PR status and summarize',
        steps: [{ action: 'github_api' }, { action: 'send_message' }],
        success_count: 7,
        failure_count: 1,
        auto_execute: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        groupId: 'g1',
      };
      const offer = formatProcedureOffer(proc);
      expect(offer).toContain('learned procedure');
      expect(offer).toContain('87%');
      expect(offer).toContain('8 times');
      expect(offer).toContain('Yes');
      expect(offer).toContain('Yes, always');
      expect(offer).toContain('No');
    });
  });

  describe('promoteProcedure', () => {
    beforeEach(() => vi.clearAllMocks());

    it('copies procedure to global scope when found in 2+ groups', () => {
      const baseProc = {
        name: 'check-pr',
        trigger: 'check PR status',
        description: 'Check PR status',
        steps: [{ action: 'github_api' }],
        success_count: 3,
        failure_count: 0,
        auto_execute: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      mockListProcedures
        .mockReturnValueOnce([{ ...baseProc, groupId: 'g1' }])
        .mockReturnValueOnce([{ ...baseProc, groupId: 'g2' }]);
      mockFindProcedure.mockReturnValue(null);

      promoteProcedure('check-pr', 'check PR status', ['g1', 'g2']);
      expect(mockSaveProcedure).toHaveBeenCalledOnce();
      const saved = mockSaveProcedure.mock.calls[0][0];
      expect(saved.groupId).toBeUndefined();
    });

    it('does not promote when found in only 1 group', () => {
      mockListProcedures
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ name: 'check-pr', groupId: 'g2' }]);
      promoteProcedure('check-pr', 'check PR status', ['g1', 'g2']);
      expect(mockSaveProcedure).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 5.2** — Run tests (expect failures)

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/procedure-matcher.test.ts
  ```

- [ ] **Step 5.3** — Implement `src/learning/procedure-matcher.ts`

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/procedure-matcher.ts`:

  ```typescript
  import {
    findProcedure,
    listProcedures,
    saveProcedure,
    updateProcedureStats,
  } from '../memory/procedure-store.js';
  import type { Procedure } from '../memory/procedure-store.js';
  import { logger } from '../logger.js';

  export function checkProcedureMatch(
    message: string,
    groupId: string,
  ): Procedure | null {
    const words = message.toLowerCase().trim();
    const match = findProcedure(words, groupId);
    if (match) {
      logger.debug({ name: match.name, groupId }, 'Procedure matched');
    }
    return match;
  }

  export function formatProcedureOffer(procedure: Procedure): string {
    const total = procedure.success_count + procedure.failure_count;
    const rate =
      total > 0 ? Math.round((procedure.success_count / total) * 100) : 0;
    return (
      `I have a learned procedure for this (${rate}% success rate, ran ${total} times).\n` +
      `Run it? [Yes / Yes, always / No]`
    );
  }

  export async function executeProcedure(
    procedure: Procedure,
    groupId: string,
    runAgent: (prompt: string) => Promise<'success' | 'error'>,
  ): Promise<boolean> {
    const stepLines = procedure.steps
      .map((s, i) => `${i + 1}. ${s.details || s.action}`)
      .join('\n');

    const prompt =
      `Execute this exact procedure (learned from prior success):\n${stepLines}\n\n` +
      `Follow these steps precisely. If any step fails, report the failure.`;

    const startMs = Date.now();
    const status = await runAgent(prompt);
    const success = status === 'success';
    const durationMs = Date.now() - startMs;

    updateProcedureStats(procedure.name, success, groupId);

    if (!success) {
      logger.warn({ name: procedure.name, groupId }, 'Procedure execution failed');
    } else {
      logger.info({ name: procedure.name, groupId, durationMs }, 'Procedure executed');
    }

    return success;
  }

  export function promoteProcedure(
    name: string,
    trigger: string,
    allGroupIds: string[],
  ): boolean {
    const matchingGroups: Procedure[] = [];

    for (const gid of allGroupIds) {
      const procs = listProcedures(gid);
      const match = procs.find(
        (p) => p.name === name && p.groupId === gid,
      );
      if (match) matchingGroups.push(match);
    }

    if (matchingGroups.length < 2) return false;

    const existing = findProcedure(trigger, undefined);
    if (existing) return false;

    const merged: Procedure = {
      ...matchingGroups[0],
      success_count: matchingGroups.reduce((s, p) => s + p.success_count, 0),
      failure_count: matchingGroups.reduce((s, p) => s + p.failure_count, 0),
      groupId: undefined,
      updated_at: new Date().toISOString(),
    };
    delete merged.groupId;

    saveProcedure(merged);
    logger.info(
      { name, fromGroups: matchingGroups.map((p) => p.groupId), stepCount: merged.steps.length },
      'Procedure promoted to global scope',
    );
    return true;
  }
  ```

- [ ] **Step 5.4** — Run tests (expect pass)

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/procedure-matcher.test.ts
  ```

- [ ] **Step 5.5** — Typecheck

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit
  ```

---

## Task 6: Feedback Capture

Create `src/learning/feedback-capture.ts` and `src/learning/feedback-capture.test.ts`.

- [ ] **Step 6.1** — Write failing tests first

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/feedback-capture.test.ts`:

  ```typescript
  import { describe, it, expect, vi, beforeEach } from 'vitest';

  vi.mock('../logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  const mockAddRule = vi.fn().mockReturnValue('rule-id-1');
  const mockQueryRules = vi.fn().mockReturnValue([]);

  vi.mock('./rules-engine.js', () => ({
    addRule: (...args: unknown[]) => mockAddRule(...args),
    queryRules: (...args: unknown[]) => mockQueryRules(...args),
  }));

  import { detectFeedback, saveFeedbackAsRule } from './feedback-capture.js';

  describe('detectFeedback', () => {
    const now = Date.now();
    const recentBotTs = now - 60_000; // 1 minute ago

    it('detects correction keywords', () => {
      const result = detectFeedback("that's wrong, use the API instead", recentBotTs, 'g1');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('correction');
    });

    it('detects positive keywords', () => {
      const result = detectFeedback('perfect, that worked exactly right', recentBotTs, 'g1');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('positive');
    });

    it('returns null when message is outside 2-minute window', () => {
      const oldBotTs = now - 3 * 60_000;
      const result = detectFeedback("that's wrong", oldBotTs, 'g1');
      expect(result).toBeNull();
    });

    it('returns null for neutral messages', () => {
      const result = detectFeedback('okay thanks', recentBotTs, 'g1');
      expect(result).toBeNull();
    });

    it('returns null when lastBotTimestamp is 0 (no prior bot message)', () => {
      const result = detectFeedback("that's wrong", 0, 'g1');
      expect(result).toBeNull();
    });
  });

  describe('saveFeedbackAsRule', () => {
    beforeEach(() => vi.clearAllMocks());

    it('calls addRule with user_feedback source and 0.9 confidence', () => {
      saveFeedbackAsRule({ type: 'correction', text: 'Use API not browser for GitHub' }, 'g1');
      expect(mockAddRule).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'user_feedback',
          confidence: 0.9,
          rule: 'Use API not browser for GitHub',
          groupId: 'g1',
        }),
      );
    });

    it('returns the rule id from addRule', () => {
      mockAddRule.mockReturnValue('new-rule-id');
      const id = saveFeedbackAsRule({ type: 'correction', text: 'Do not use browser' }, 'g1');
      expect(id).toBe('new-rule-id');
    });
  });
  ```

- [ ] **Step 6.2** — Run tests (expect failures)

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/feedback-capture.test.ts
  ```

- [ ] **Step 6.3** — Implement `src/learning/feedback-capture.ts`

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/feedback-capture.ts`:

  ```typescript
  import { logger } from '../logger.js';
  import { addRule } from './rules-engine.js';
  import { inferActionClasses } from './outcome-enricher.js';

  export const CORRECTION_KEYWORDS = [
    'wrong',
    "don't",
    'stop',
    'instead',
    'not that',
    "shouldn't",
    'bad',
    'incorrect',
    'no,',
    'no.',
  ];

  export const POSITIVE_KEYWORDS = [
    'perfect',
    'exactly',
    'great',
    'keep doing',
    'that worked',
  ];

  export interface DetectedFeedback {
    type: 'correction' | 'positive';
    text: string;
  }

  const TWO_MINUTES_MS = 2 * 60 * 1000;

  export function detectFeedback(
    message: string,
    lastBotTimestamp: number,
    groupId: string,
  ): DetectedFeedback | null {
    if (!lastBotTimestamp) return null;

    const age = Date.now() - lastBotTimestamp;
    if (age > TWO_MINUTES_MS) return null;

    const lower = message.toLowerCase();

    for (const kw of CORRECTION_KEYWORDS) {
      if (lower.includes(kw)) {
        logger.debug({ groupId, keyword: kw }, 'Correction feedback detected');
        return { type: 'correction', text: message };
      }
    }

    for (const kw of POSITIVE_KEYWORDS) {
      if (lower.includes(kw)) {
        logger.debug({ groupId, keyword: kw }, 'Positive feedback detected');
        return { type: 'positive', text: message };
      }
    }

    return null;
  }

  export function saveFeedbackAsRule(
    feedback: DetectedFeedback,
    groupId: string,
  ): string {
    const actionClasses = inferActionClasses(feedback.text);

    const id = addRule({
      rule: feedback.text,
      source: 'user_feedback',
      actionClasses: actionClasses.length > 0 ? actionClasses : ['general'],
      groupId,
      confidence: 0.9,
      evidenceCount: 1,
    });

    logger.info({ id, groupId }, 'Feedback saved as rule');
    return id;
  }
  ```

- [ ] **Step 6.4** — Run tests (expect pass)

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/feedback-capture.test.ts
  ```

- [ ] **Step 6.5** — Typecheck

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit
  ```

---

## Task 7: Learning System Init + Container Skill

Create `src/learning/index.ts`, `src/learning/index.test.ts`, and `container/skills/learning/SKILL.md`.

- [ ] **Step 7.1** — Write failing tests first

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/index.test.ts`:

  ```typescript
  import { describe, it, expect, vi, beforeEach } from 'vitest';

  vi.mock('../logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  const mockDb = { exec: vi.fn(), prepare: vi.fn() };
  vi.mock('../db.js', () => ({ getDb: vi.fn(() => mockDb) }));

  const mockInitRulesStore = vi.fn();
  vi.mock('./rules-engine.js', () => ({
    initRulesStore: () => mockInitRulesStore(),
    queryRules: vi.fn().mockReturnValue([]),
    addRule: vi.fn().mockReturnValue('r1'),
    markMatched: vi.fn(),
    pruneStaleRules: vi.fn().mockReturnValue(0),
    decayConfidence: vi.fn().mockReturnValue(0),
  }));

  vi.mock('./procedure-recorder.js', () => ({
    startTrace: vi.fn(),
    addTrace: vi.fn(),
    finalizeTrace: vi.fn(),
  }));

  vi.mock('./outcome-enricher.js', () => ({
    buildRulesBlock: vi.fn().mockReturnValue(null),
    inferActionClasses: vi.fn().mockReturnValue([]),
  }));

  vi.mock('./feedback-capture.js', () => ({
    detectFeedback: vi.fn().mockReturnValue(null),
    saveFeedbackAsRule: vi.fn().mockReturnValue('r1'),
  }));

  vi.mock('../memory/outcome-store.js', () => ({
    queryOutcomes: vi.fn().mockReturnValue([]),
  }));

  import { EventBus } from '../event-bus.js';
  import { initLearningSystem } from './index.js';

  describe('initLearningSystem', () => {
    beforeEach(() => vi.clearAllMocks());

    it('calls initRulesStore on startup', () => {
      const bus = new EventBus();
      initLearningSystem(bus, {
        getRegisteredGroups: () => ({}),
        sendMessage: vi.fn(),
        enqueueTask: vi.fn(),
      });
      expect(mockInitRulesStore).toHaveBeenCalledOnce();
    });

    it('subscribes to task.started and task.complete events', () => {
      const bus = new EventBus();
      const onSpy = vi.spyOn(bus, 'on');

      initLearningSystem(bus, {
        getRegisteredGroups: () => ({}),
        sendMessage: vi.fn(),
        enqueueTask: vi.fn(),
      });

      const subscribedEvents = onSpy.mock.calls.map((c) => c[0]);
      expect(subscribedEvents).toContain('task.started');
      expect(subscribedEvents).toContain('task.complete');
      expect(subscribedEvents).toContain('message.inbound');
    });

    it('wires task.started to startTrace', () => {
      const { startTrace } = vi.mocked(
        await import('./procedure-recorder.js'),
      );
      const bus = new EventBus();

      initLearningSystem(bus, {
        getRegisteredGroups: () => ({}),
        sendMessage: vi.fn(),
        enqueueTask: vi.fn(),
      });

      bus.emit('task.started', {
        type: 'task.started',
        source: 'executor',
        groupId: 'g1',
        timestamp: Date.now(),
        payload: {
          taskId: 'task-1',
          groupJid: 'g1',
          containerName: 'c1',
          slotIndex: 0,
        },
      });

      expect(startTrace).toHaveBeenCalledWith('g1', 'task-1');
    });
  });
  ```

- [ ] **Step 7.2** — Run tests (expect failures)

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/index.test.ts
  ```

- [ ] **Step 7.3** — Implement `src/learning/index.ts`

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/index.ts`:

  ```typescript
  import type { EventBus } from '../event-bus.js';
  import { logger } from '../logger.js';
  import { queryOutcomes } from '../memory/outcome-store.js';
  import type { RegisteredGroup } from '../types.js';
  import { detectFeedback, saveFeedbackAsRule } from './feedback-capture.js';
  import { buildRulesBlock } from './outcome-enricher.js';
  import { addTrace, finalizeTrace, startTrace } from './procedure-recorder.js';
  import {
    addRule,
    decayConfidence,
    initRulesStore,
    pruneStaleRules,
  } from './rules-engine.js';

  export interface LearningDeps {
    getRegisteredGroups: () => Record<string, RegisteredGroup>;
    sendMessage: (jid: string, text: string) => Promise<void>;
    enqueueTask: (jid: string, taskId: string, fn: () => Promise<void>) => void;
  }

  const lastBotMessageTs: Record<string, number> = {};

  export { addTrace, buildRulesBlock };

  export function initLearningSystem(bus: EventBus, deps: LearningDeps): void {
    initRulesStore();
    logger.info('Learning system initialized');

    bus.on('task.started', (event) => {
      const groupId = event.groupId ?? event.payload.groupJid;
      const taskId = event.payload.taskId;
      startTrace(groupId, taskId);
    });

    bus.on('task.complete', (event) => {
      const groupId = event.groupId ?? event.payload.groupJid;
      const taskId = event.payload.taskId;
      const success = event.payload.status === 'success';

      finalizeTrace(groupId, taskId, success);

      if (success) {
        analyzeOutcomePatterns(groupId);
      }
    });

    bus.on('message.inbound', (event) => {
      const groupId = event.groupId ?? event.payload.chatJid;
      const lastBotTs = lastBotMessageTs[groupId] ?? 0;

      const feedback = detectFeedback(
        String(event.payload.messageCount),
        lastBotTs,
        groupId,
      );
      if (feedback) {
        const ruleId = saveFeedbackAsRule(feedback, groupId);
        bus.emit('learn.feedback_received', {
          type: 'learn.feedback_received',
          source: 'learning',
          groupId,
          timestamp: Date.now(),
          payload: { ruleId, feedback: feedback.text, groupId },
        });
      }
    });

    bus.on('message.outbound', (event) => {
      const groupId = event.groupId ?? event.payload.chatJid;
      lastBotMessageTs[groupId] = Date.now();
    });

    setInterval(() => {
      const pruned = pruneStaleRules();
      const decayed = decayConfidence();
      if (pruned > 0 || decayed > 0) {
        logger.info({ pruned, decayed }, 'Learning maintenance run');
      }
    }, 24 * 60 * 60 * 1000);
  }

  function analyzeOutcomePatterns(groupId: string): void {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const outcomes = queryOutcomes({
      groupId,
      since: sevenDaysAgo,
      limit: 100,
    });

    const failuresByClass: Record<string, { errors: string[]; count: number }> = {};
    for (const o of outcomes) {
      if (o.result === 'failure' && o.error) {
        if (!failuresByClass[o.action_class]) {
          failuresByClass[o.action_class] = { errors: [], count: 0 };
        }
        failuresByClass[o.action_class].errors.push(o.error);
        failuresByClass[o.action_class].count++;
      }
    }

    for (const [actionClass, data] of Object.entries(failuresByClass)) {
      if (data.count < 2) continue;

      const topError = data.errors[0].slice(0, 120);
      const rule = `Recurring failure in ${actionClass}: ${topError}`;
      const confidence = Math.min(0.8, 0.5 + (data.count - 2) * 0.1);

      addRule({
        rule,
        source: 'outcome_pattern',
        actionClasses: [actionClass],
        groupId,
        confidence,
        evidenceCount: data.count,
      });

      logger.debug({ actionClass, count: data.count, groupId }, 'Outcome pattern rule created');
    }
  }
  ```

- [ ] **Step 7.4** — Run tests (expect pass)

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/index.test.ts
  ```

- [ ] **Step 7.5** — Create container skill file

  Create `/Users/topcoder1/dev/nanoclaw/container/skills/learning/SKILL.md`:

  ````markdown
  # Learning Skill

  After completing a **multi-step task successfully**, you may optionally emit structured output blocks to help the system learn from your work.

  ## `_procedure` Block

  Emit when you complete a task that involved 2 or more distinct tool calls or actions. Include a trigger phrase that would match future similar requests.

  Format: a JSON block in your final response.

  ```json
  {
    "_procedure": {
      "name": "kebab-case-name",
      "trigger": "short phrase that would match this task",
      "description": "One sentence describing what this procedure does",
      "steps": [
        { "action": "tool_or_api_name", "details": "what was done" },
        { "action": "send_message", "details": "format and send result" }
      ]
    }
  }
  ```

  **Rules:**
  - Only emit after a **successful** multi-step task
  - `trigger` should be a short, natural-language phrase (e.g., "check PR status", "summarize inbox")
  - `action` values should match the tool or IPC type used (e.g., `github_api`, `browser_navigate`, `send_message`)
  - Maximum 10 steps
  - Do not emit for single-action tasks (one tool call)

  ## `_lesson` Block

  Emit when you discover something factual and reusable during execution — something that would help future runs avoid a mistake or use a better approach.

  Format: a JSON block in your final response.

  ```json
  {
    "_lesson": "OAuth tokens for this Gmail account expire every 55 minutes. Refresh before any email operation if last refresh was >50 minutes ago."
  }
  ```

  **Rules:**
  - Keep it under 200 characters
  - Only emit if you actually discovered something new — do not fabricate lessons
  - One lesson per task at most
  - Focus on facts about the environment, not general programming advice

  ## Both blocks are optional

  The system captures IPC traces regardless of whether you emit these blocks. Emitting them adds human-readable descriptions and improves procedure quality, but is never required.
  ````

- [ ] **Step 7.6** — Typecheck

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit
  ```

---

## Task 8: Orchestrator Integration

Modify `src/index.ts` and `src/ipc.ts` to wire the learning system.

- [ ] **Step 8.1** — Write integration test for ipc.ts learn_feedback case

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/ipc-learn-feedback.test.ts`:

  ```typescript
  import { describe, it, expect, vi, beforeEach } from 'vitest';

  vi.mock('./logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  const mockAddRule = vi.fn().mockReturnValue('r1');
  vi.mock('./learning/rules-engine.js', () => ({
    addRule: (...args: unknown[]) => mockAddRule(...args),
  }));

  vi.mock('./db.js', () => ({
    getDb: vi.fn(() => ({ exec: vi.fn(), prepare: vi.fn() })),
    createTask: vi.fn(),
    deleteTask: vi.fn(),
    getTaskById: vi.fn(),
    setGroupVerbose: vi.fn(),
    updateTask: vi.fn(),
  }));

  vi.mock('./config.js', () => ({
    DATA_DIR: '/tmp/test-data',
    IPC_POLL_INTERVAL: 1000,
    TIMEZONE: 'America/Los_Angeles',
    EMAIL_INTELLIGENCE_ENABLED: false,
  }));

  vi.mock('./group-folder.js', () => ({ isValidGroupFolder: vi.fn().mockReturnValue(true) }));

  import { processTaskIpc } from './ipc.js';

  const mockDeps = {
    sendMessage: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    enqueueEmailTrigger: vi.fn(),
  };

  describe('processTaskIpc learn_feedback', () => {
    beforeEach(() => vi.clearAllMocks());

    it('saves feedback as rule via addRule', async () => {
      await processTaskIpc(
        { type: 'learn_feedback', feedback: 'Use API not browser for GitHub', groupId: 'g1' } as Parameters<typeof processTaskIpc>[0],
        'g1',
        false,
        mockDeps,
      );
      expect(mockAddRule).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'user_feedback',
          confidence: 0.9,
          rule: 'Use API not browser for GitHub',
        }),
      );
    });
  });
  ```

- [ ] **Step 8.2** — Modify `src/ipc.ts`: add `learn_feedback` IPC type and `addTrace` calls

  In `src/ipc.ts`, add import at top (after existing imports):

  ```typescript
  import { addRule } from './learning/rules-engine.js';
  import { addTrace } from './learning/procedure-recorder.js';
  import { inferActionClasses } from './learning/outcome-enricher.js';
  ```

  Also extend the `data` parameter interface in `processTaskIpc` to include:

  ```typescript
  // For learn_feedback
  feedback?: string;
  groupId?: string;
  ```

  Add at the end of the `switch` statement (before the `default` or closing brace), a new case:

  ```typescript
  case 'learn_feedback':
    if (data.feedback) {
      const actionClasses = inferActionClasses(data.feedback);
      addRule({
        rule: data.feedback,
        source: 'user_feedback',
        actionClasses: actionClasses.length > 0 ? actionClasses : ['general'],
        groupId: data.groupId ?? sourceGroup,
        confidence: 0.9,
        evidenceCount: 1,
      });
      logger.info({ groupId: data.groupId ?? sourceGroup }, 'learn_feedback IPC processed');
    }
    break;
  ```

  Also add `addTrace` call at the end of `processTaskIpc` for relevant action types. Append after the switch block, before the function ends:

  ```typescript
  // Trace IPC actions for procedure recording
  if (data.taskId) {
    const traceableTypes = new Set([
      'browser_navigate', 'browser_act', 'browser_extract', 'browser_observe',
      'schedule_task', 'cancel_task', 'relay_message', 'email_trigger',
    ]);
    if (traceableTypes.has(data.type)) {
      addTrace(sourceGroup, data.taskId, {
        type: data.type,
        timestamp: Date.now(),
        inputSummary: (data.instruction ?? data.prompt ?? data.text ?? data.type).slice(0, 200),
        result: 'success',
      });
    }
  }
  ```

- [ ] **Step 8.3** — Modify `src/index.ts`: call `initLearningSystem`, inject rules, parse `_lesson`

  **Import additions** (at top of file with existing imports):

  ```typescript
  import { initLearningSystem, buildRulesBlock } from './learning/index.js';
  ```

  **Init call** — After `startEventLog(eventBus)`, add:

  ```typescript
  initLearningSystem(eventBus, {
    getRegisteredGroups: () => registeredGroups,
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      await channel.sendMessage(jid, text);
    },
    enqueueTask: (jid, taskId, fn) => queue.enqueueTask(jid, taskId, fn),
  });
  ```

  **Rules injection in `runAgent()`** — Before `const output = await runContainerAgent(...)`, add:

  ```typescript
  const rulesBlock = buildRulesBlock(prompt, group.folder);
  const enrichedPrompt = rulesBlock ? `${prompt}\n\n${rulesBlock}` : prompt;
  ```

  Then change `prompt` to `enrichedPrompt` in the `runContainerAgent` call:

  ```typescript
  const output = await runContainerAgent(
    group,
    {
      prompt: enrichedPrompt,
      ...
    },
    ...
  );
  ```

  **Parse `_lesson` from agent output** — After the `if (output.status === 'error')` block (in the success path), add:

  ```typescript
  if (output.result) {
    const lessonMatch = output.result.match(/"_lesson"\s*:\s*"([^"]{1,400})"/);
    if (lessonMatch) {
      const { addRule } = await import('./learning/rules-engine.js');
      const { inferActionClasses } = await import('./learning/outcome-enricher.js');
      const lessonText = lessonMatch[1];
      addRule({
        rule: lessonText,
        source: 'agent_reported',
        actionClasses: inferActionClasses(lessonText),
        groupId: group.folder,
        confidence: 0.3,
        evidenceCount: 1,
      });
      logger.debug({ groupId: group.folder }, 'Agent lesson captured as rule');
    }
  }
  ```

  **Parse `_procedure` from agent output** — In the same success block (after lesson parse), add:

  ```typescript
  if (output.result) {
    const procMatch = output.result.match(/"_procedure"\s*:\s*(\{[\s\S]*?\})\s*\}/);
    if (procMatch) {
      try {
        const agentProc = JSON.parse(procMatch[1]) as import('./learning/procedure-recorder.js').AgentProcedure;
        const { finalizeTrace } = await import('./learning/procedure-recorder.js');
        const taskIdForProc = `agent-${group.folder}-${startMs}`;
        finalizeTrace(group.folder, taskIdForProc, true, agentProc);
      } catch {
        logger.debug({ groupId: group.folder }, 'Failed to parse _procedure block');
      }
    }
  }
  ```

- [ ] **Step 8.4** — Run ipc integration test

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/ipc-learn-feedback.test.ts
  ```

- [ ] **Step 8.5** — Typecheck all modified files

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit
  ```

- [ ] **Step 8.6** — Full build

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npm run build
  ```

---

## Task 9: Procedure Matching Integration

Modify `src/index.ts` message handling to check for matching procedures before enqueuing.

- [ ] **Step 9.1** — Write integration test

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/procedure-match-integration.test.ts`:

  ```typescript
  import { describe, it, expect, vi, beforeEach } from 'vitest';

  vi.mock('../logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  const mockCheckProcedureMatch = vi.fn();
  const mockFormatProcedureOffer = vi.fn();
  const mockExecuteProcedure = vi.fn().mockResolvedValue(true);

  vi.mock('./procedure-matcher.js', () => ({
    checkProcedureMatch: (...args: unknown[]) => mockCheckProcedureMatch(...args),
    formatProcedureOffer: (...args: unknown[]) => mockFormatProcedureOffer(...args),
    executeProcedure: (...args: unknown[]) => mockExecuteProcedure(...args),
  }));

  import { handleMessageWithProcedureCheck } from './procedure-match-integration.js';

  describe('handleMessageWithProcedureCheck', () => {
    const mockRunAgent = vi.fn().mockResolvedValue('success');
    const mockSendMessage = vi.fn().mockResolvedValue(undefined);
    const mockEnqueue = vi.fn();

    beforeEach(() => vi.clearAllMocks());

    it('returns false when no procedure matches (caller enqueues normally)', async () => {
      mockCheckProcedureMatch.mockReturnValue(null);
      const handled = await handleMessageWithProcedureCheck(
        'hello world',
        'g1',
        mockRunAgent,
        mockSendMessage,
        mockEnqueue,
      );
      expect(handled).toBe(false);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('auto-executes procedure and returns true when auto_execute is true', async () => {
      mockCheckProcedureMatch.mockReturnValue({
        name: 'check-pr',
        trigger: 'check PR status',
        description: 'Check PR',
        steps: [{ action: 'github_api' }],
        success_count: 5,
        failure_count: 0,
        auto_execute: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        groupId: 'g1',
      });

      const handled = await handleMessageWithProcedureCheck(
        'check PR status',
        'g1',
        mockRunAgent,
        mockSendMessage,
        mockEnqueue,
      );

      expect(handled).toBe(true);
      expect(mockExecuteProcedure).toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('learned procedure'));
    });

    it('sends offer message when auto_execute is false', async () => {
      mockCheckProcedureMatch.mockReturnValue({
        name: 'check-pr',
        trigger: 'check PR status',
        description: 'Check PR',
        steps: [{ action: 'github_api' }],
        success_count: 5,
        failure_count: 1,
        auto_execute: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        groupId: 'g1',
      });
      mockFormatProcedureOffer.mockReturnValue('I have a learned procedure... [Yes / Yes, always / No]');

      const handled = await handleMessageWithProcedureCheck(
        'check PR status',
        'g1',
        mockRunAgent,
        mockSendMessage,
        mockEnqueue,
      );

      expect(handled).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith('g1', expect.stringContaining('learned procedure'));
    });
  });
  ```

- [ ] **Step 9.2** — Run tests (expect failures)

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/procedure-match-integration.test.ts
  ```

- [ ] **Step 9.3** — Create `src/learning/procedure-match-integration.ts`

  Create `/Users/topcoder1/dev/nanoclaw/src/learning/procedure-match-integration.ts`:

  ```typescript
  import { logger } from '../logger.js';
  import {
    checkProcedureMatch,
    executeProcedure,
    formatProcedureOffer,
  } from './procedure-matcher.js';
  import { updateProcedureStats } from '../memory/procedure-store.js';

  export async function handleMessageWithProcedureCheck(
    message: string,
    groupId: string,
    runAgent: (prompt: string) => Promise<'success' | 'error'>,
    sendMessage: (jid: string, text: string) => Promise<void>,
    enqueueTask: (fn: () => Promise<void>) => void,
  ): Promise<boolean> {
    const procedure = checkProcedureMatch(message, groupId);
    if (!procedure) return false;

    if (procedure.auto_execute) {
      logger.info({ name: procedure.name, groupId }, 'Auto-executing procedure');
      const success = await executeProcedure(procedure, groupId, runAgent);

      if (!success) {
        if (procedure.groupId) {
          updateProcedureStats(procedure.name, false, procedure.groupId);
        }
        await sendMessage(groupId, 'Learned procedure failed, running normally.');
        enqueueTask(async () => {
          await runAgent(message);
        });
      }
      return true;
    }

    const offer = formatProcedureOffer(procedure);
    await sendMessage(groupId, offer);
    return true;
  }
  ```

- [ ] **Step 9.4** — Wire into `src/index.ts` message processing

  In `src/index.ts`, add import:

  ```typescript
  import { handleMessageWithProcedureCheck } from './learning/procedure-match-integration.js';
  ```

  In the message processing section (inside `processMessages` or equivalent, before `queue.enqueueMessageCheck`), add procedure check. Find the section where the agent is enqueued for a new inbound message and wrap it:

  ```typescript
  const procedureHandled = await handleMessageWithProcedureCheck(
    prompt,
    chatJid,
    (p) => runAgent(group, p, chatJid),
    async (jid, text) => {
      const ch = findChannel(channels, jid);
      if (ch) await ch.sendMessage(jid, text);
    },
    (fn) => queue.enqueueTask(chatJid, `proc-${Date.now()}`, fn),
  );
  if (!procedureHandled) {
    queue.enqueueTask(chatJid, taskId, async () => {
      await runAgent(group, prompt, chatJid);
    });
  }
  ```

- [ ] **Step 9.5** — Run integration tests

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/procedure-match-integration.test.ts
  ```

- [ ] **Step 9.6** — Run all learning tests

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/
  ```

- [ ] **Step 9.7** — Full typecheck and build

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit && npm run build
  ```

- [ ] **Step 9.8** — Run full test suite

  ```bash
  cd /Users/topcoder1/dev/nanoclaw && npx vitest run
  ```

---

## File Summary

```
NEW FILES:
src/learning/rules-engine.ts
src/learning/rules-engine.test.ts
src/learning/outcome-enricher.ts
src/learning/outcome-enricher.test.ts
src/learning/procedure-recorder.ts
src/learning/procedure-recorder.test.ts
src/learning/procedure-matcher.ts
src/learning/procedure-matcher.test.ts
src/learning/feedback-capture.ts
src/learning/feedback-capture.test.ts
src/learning/index.ts
src/learning/index.test.ts
src/learning/procedure-match-integration.ts
src/learning/procedure-match-integration.test.ts
src/learning/ipc-learn-feedback.test.ts
container/skills/learning/SKILL.md

MODIFIED FILES:
src/events.ts        — 7 learn.* event interfaces + EventMap entries
src/index.ts         — initLearningSystem(), buildRulesBlock injection, _lesson/_procedure parse
src/ipc.ts           — addTrace() calls, learn_feedback case
```
