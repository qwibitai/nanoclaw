# NanoClaw Hardening & Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all pre-existing test failures, harden the learning/procedure system, wire webhook consumers, seed knowledge store, and update the upstream PR — transforming the scope expansion from "deployed" to "production-grade."

**Architecture:** Eight independent tasks that can be executed in any order. Each task is self-contained: write failing tests, implement, verify, commit. The teach-mode parser gets flexible NLP matching. The procedure lifecycle gets auto-execute promotion and decay cleanup. Trace buffers get memory bounds. The webhook server gets an event consumer. The knowledge store gets automatic ingestion.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Qdrant JS client, Node.js crypto, Docker

---

### Task 1: Fix 3 Pre-Existing Test Failures in index.test.ts

**Root cause:** The config mock is missing `STORE_DIR` (and several other config exports added during scope expansion). When `runAgent` calls `listProcedures()`, `procedure-store.ts` does `path.join(STORE_DIR, 'procedures')` with `STORE_DIR = undefined`, throwing `TypeError`. This kills `runAgent` before `runContainerAgent` is ever called.

**Files:**
- Modify: `src/index.test.ts:9-25` (config mock)

- [ ] **Step 1: Verify current failures**

Run: `npx vitest run src/index.test.ts 2>&1 | tail -10`
Expected: 3 failed, 16 passed

- [ ] **Step 2: Add missing config exports to mock**

In `src/index.test.ts`, replace the config mock (lines 9–25):

```typescript
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'TestBot',
  ASSISTANT_HAS_OWN_NUMBER: false,
  DEFAULT_TRIGGER: '@TestBot',
  getTriggerPattern: (trigger: string) => new RegExp(trigger, 'i'),
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  STORE_DIR: '/tmp/nanoclaw-test-store',
  DATA_DIR: '/tmp/nanoclaw-test-data',
  IDLE_TIMEOUT: 1800000,
  MAX_MESSAGES_PER_PROMPT: 50,
  ONECLI_URL: 'http://localhost:10254',
  POLL_INTERVAL: 2000,
  SCHEDULER_POLL_INTERVAL: 60000,
  TIMEZONE: 'America/Los_Angeles',
  DAILY_BUDGET_USD: 50,
  MAX_CONCURRENT_CONTAINERS: 3,
  WARM_POOL_SIZE: 0,
  WEBHOOK_PORT: 0,
  WEBHOOK_SECRET: '',
  QDRANT_URL: '',
  TRUST_GATEWAY_PORT: 10255,
  TRUST_GATEWAY_URL: 'http://host.docker.internal:10255',
  BROWSER_CDP_URL: '',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_TIMEOUT: 1800000,
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  WARM_POOL_IDLE_TIMEOUT: 600000,
  IPC_POLL_INTERVAL: 2000,
  SUPERPILOT_MCP_URL: 'http://localhost:8100',
  EMAIL_INTELLIGENCE_ENABLED: false,
  PROACTIVE_SUGGESTION_INTERVAL: 900000,
  PROACTIVE_LOOKAHEAD_MS: 14400000,
  PROACTIVE_MIN_GAP_MS: 300000,
  DELEGATION_GUARDRAIL_COUNT: 10,
}));
```

- [ ] **Step 3: Run tests to verify all pass**

Run: `npx vitest run src/index.test.ts 2>&1 | tail -10`
Expected: 19 passed (0 failed)

If new failures appear because additional config values are referenced at runtime, check the error message for the missing export name, add it to the mock with a sensible default, and re-run.

- [ ] **Step 4: Commit**

```bash
git add src/index.test.ts
git commit -m "fix(tests): add missing config exports to index.test.ts mock

STORE_DIR and other scope-expansion config values were absent from the
vi.mock factory, causing runAgent to throw before reaching the container."
```

---

### Task 2: Harden Teach-Mode Parser — Flexible NLP + Extract Action

**Problem:** `parseStepFromNarration` only matches exact prefix verbs. The `extract` action exists in the type but has no parser branch. Polite phrasing ("please click", "can you open") is silently dropped. No fallback for unrecognized verbs.

**Files:**
- Modify: `container/skills/teach-mode/teach-mode.ts:18-46`
- Modify: `container/skills/teach-mode/teach-mode.test.ts`

- [ ] **Step 1: Write failing tests for new patterns**

Add these test cases to `container/skills/teach-mode/teach-mode.test.ts`, inside the `parseStepFromNarration` describe block:

```typescript
describe('extract action', () => {
  it.each([
    ['Extract the price', 'the price'],
    ['extract all email addresses', 'all email addresses'],
    ['Grab the title text', 'the title text'],
    ['grab order number', 'order number'],
    ['Copy the confirmation code', 'the confirmation code'],
    ['copy that value', 'that value'],
  ])('parses "%s" → extract target "%s"', (narration, expectedTarget) => {
    const step = parseStepFromNarration(narration);
    expect(step).not.toBeNull();
    expect(step!.action).toBe('extract');
    expect(step!.target).toBe(expectedTarget);
  });
});

describe('polite/prefixed phrasing', () => {
  it.each([
    ['Please click the submit button', 'click', 'the submit button'],
    ['Can you open https://example.com', 'navigate', 'https://example.com'],
    ['Now type hello', 'type', 'hello'],
    ['Then find the login form', 'find', 'the login form'],
    ['Please navigate to settings', 'navigate', 'settings'],
    ['Next, click Save', 'click', 'Save'],
    ['And then wait 5 seconds', 'wait', '5 seconds'],
  ])(
    'parses "%s" → action "%s" target "%s"',
    (narration, expectedAction, expectedTarget) => {
      const step = parseStepFromNarration(narration);
      expect(step).not.toBeNull();
      expect(step!.action).toBe(expectedAction);
      expect(step!.target).toBe(expectedTarget);
    },
  );
});

describe('scroll action', () => {
  it.each([
    ['Scroll down', 'down'],
    ['scroll to the bottom', 'to the bottom'],
    ['Scroll up to the top', 'up to the top'],
  ])('parses "%s" → navigate target "%s"', (narration, expectedTarget) => {
    const step = parseStepFromNarration(narration);
    expect(step).not.toBeNull();
    expect(step!.action).toBe('navigate');
    expect(step!.target).toBe(expectedTarget);
  });
});

describe('select/choose action', () => {
  it.each([
    ['Select the dropdown', 'the dropdown'],
    ['select option B', 'option B'],
    ['Choose the first item', 'the first item'],
    ['choose Premium plan', 'Premium plan'],
  ])('parses "%s" → click target "%s"', (narration, expectedTarget) => {
    const step = parseStepFromNarration(narration);
    expect(step).not.toBeNull();
    expect(step!.action).toBe('click');
    expect(step!.target).toBe(expectedTarget);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run container/skills/teach-mode/teach-mode.test.ts 2>&1 | tail -15`
Expected: Multiple failures for extract, polite phrasing, scroll, select patterns

- [ ] **Step 3: Update parseStepFromNarration**

Replace the function body in `container/skills/teach-mode/teach-mode.ts` (lines 18–46):

```typescript
export function parseStepFromNarration(narration: string): ProcedureStep | null {
  // Strip polite/filler prefixes before matching the action verb
  const stripped = narration
    .replace(/^(please|can you|now|then|next,?|and then|first,?|finally,?)\s+/i, '')
    .trim();
  const lower = stripped.toLowerCase().trim();

  if (lower.startsWith('go to ') || lower.startsWith('navigate to ') || lower.startsWith('open ')) {
    const url = stripped.replace(/^(go to|navigate to|open)\s+/i, '').trim();
    return { action: 'navigate', target: url, description: narration };
  }

  if (lower.startsWith('scroll ')) {
    const target = stripped.replace(/^scroll\s+/i, '').trim();
    return { action: 'navigate', target, description: narration };
  }

  if (
    lower.startsWith('click ') || lower.startsWith('press ') ||
    lower.startsWith('tap ') || lower.startsWith('select ') ||
    lower.startsWith('choose ')
  ) {
    const target = stripped.replace(/^(click|press|tap|select|choose)\s+(on\s+)?/i, '').trim();
    return { action: 'click', target, description: narration };
  }

  if (lower.startsWith('find ') || lower.startsWith('look for ') || lower.startsWith('locate ')) {
    const target = stripped.replace(/^(find|look for|locate)\s+/i, '').trim();
    return { action: 'find', target, description: narration };
  }

  if (lower.startsWith('type ') || lower.startsWith('enter ') || lower.startsWith('input ')) {
    const target = stripped.replace(/^(type|enter|input)\s+/i, '').trim();
    return { action: 'type', target, description: narration };
  }

  if (
    lower.startsWith('extract ') || lower.startsWith('grab ') ||
    lower.startsWith('copy ')
  ) {
    const target = stripped.replace(/^(extract|grab|copy)\s+/i, '').trim();
    return { action: 'extract', target, description: narration };
  }

  if (lower.startsWith('wait ')) {
    return { action: 'wait', target: stripped.replace(/^wait\s+/i, ''), description: narration };
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run container/skills/teach-mode/teach-mode.test.ts 2>&1 | tail -10`
Expected: All tests pass (58 existing + ~20 new ≈ 78 total)

Some existing tests may need minor updates if the prefix stripping changes how the `description` field is set. The key invariant: `description` always holds the original `narration` (pre-stripping), while `target` uses the stripped version. Verify by checking existing tests still pass; if any fail, update expectations.

- [ ] **Step 5: Commit**

```bash
git add container/skills/teach-mode/teach-mode.ts container/skills/teach-mode/teach-mode.test.ts
git commit -m "feat(teach-mode): flexible NLP parsing with extract, scroll, select actions

Strip polite prefixes (please, can you, now, then, next) before matching
action verbs. Add extract/grab/copy, scroll, select/choose as recognized
actions. 20 new test cases covering all patterns."
```

---

### Task 3: Fix description/details Field Mismatch

**Problem:** The container-side `ProcedureStep` uses `description` and `target` fields, but the store-side `ProcedureStep` uses `details`. When `executeProcedure` renders steps, it does `s.details || s.action` — teach-mode procedures have no `details` field, so they render as bare action names like "navigate" instead of "Go to alto.com".

**Files:**
- Modify: `container/skills/teach-mode/teach-mode.ts:48-60` (buildProcedure)
- Modify: `container/skills/teach-mode/teach-mode.test.ts`
- Test: `src/learning/procedure-matcher.test.ts`

- [ ] **Step 1: Write failing test for teach-mode step rendering**

Add to `src/learning/procedure-matcher.test.ts`:

```typescript
describe('executeProcedure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders teach-mode procedure steps with description text', async () => {
    const { executeProcedure } = await import('./procedure-matcher.js');
    const mockRunAgent = vi.fn().mockResolvedValue('success');

    const proc = {
      name: 'reorder-meds',
      trigger: 'reorder medications',
      description: 'Reorder medications from Alto',
      steps: [
        { action: 'navigate', details: 'Go to alto.com' },
        { action: 'click', details: 'Click Sign In' },
      ],
      success_count: 3,
      failure_count: 0,
      auto_execute: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      groupId: 'g1',
    };

    await executeProcedure(proc, 'g1', mockRunAgent);

    const prompt = mockRunAgent.mock.calls[0][0];
    expect(prompt).toContain('Go to alto.com');
    expect(prompt).toContain('Click Sign In');
    expect(prompt).not.toContain('1. navigate');
  });
});
```

- [ ] **Step 2: Run test to verify it passes (it should — this test uses `details` correctly)**

Run: `npx vitest run src/learning/procedure-matcher.test.ts 2>&1 | tail -10`
Expected: PASS — this confirms the store-side rendering works.

- [ ] **Step 3: Update buildProcedure to emit store-compatible steps**

In `container/skills/teach-mode/teach-mode.ts`, update `buildProcedure` to map teach-mode fields to store-compatible fields:

```typescript
export function buildProcedure(
  name: string,
  steps: ProcedureStep[],
  groupId: string,
): Procedure {
  return {
    name: name.replace(/\s+/g, '_').toLowerCase(),
    trigger: `user asks to ${name}`,
    steps: steps.map((s) => ({
      ...s,
      details: s.description || `${s.action} ${s.target}`,
    })),
    learnedFrom: `${new Date().toISOString()} teach mode in ${groupId}`,
    acquisition: 'teach',
  };
}
```

- [ ] **Step 4: Update teach-mode tests for the new `details` field**

In `container/skills/teach-mode/teach-mode.test.ts`, update the `buildProcedure` test "preserves all steps in order":

```typescript
  it('preserves all steps in order and adds details field', () => {
    const steps = [
      { action: 'navigate' as const, target: 'a.com', description: 'Go to a.com' },
      { action: 'click' as const, target: 'Login', description: 'Click Login' },
      { action: 'type' as const, target: 'user@test.com', description: 'Type user@test.com' },
      { action: 'click' as const, target: 'Submit', description: 'Click Submit' },
      { action: 'wait' as const, target: '3 seconds', description: 'Wait 3 seconds' },
    ];
    const proc = buildProcedure('login flow', steps, 'g1');
    expect(proc.steps).toHaveLength(5);
    expect(proc.steps[0].action).toBe('navigate');
    expect(proc.steps[0].details).toBe('Go to a.com');
    expect(proc.steps[4].action).toBe('wait');
    expect(proc.steps[4].details).toBe('Wait 3 seconds');
  });
```

Also update the end-to-end test assertion to check `details`:

```typescript
    expect(content.procedure.steps[0].details).toBe('Go to https://alto.com/pharmacy');
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run container/skills/teach-mode/ src/learning/procedure-matcher.test.ts 2>&1 | tail -10`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add container/skills/teach-mode/teach-mode.ts container/skills/teach-mode/teach-mode.test.ts src/learning/procedure-matcher.test.ts
git commit -m "fix(teach-mode): map description to details field for correct step rendering

buildProcedure now emits store-compatible steps with 'details' field so
executeProcedure renders 'Go to alto.com' instead of bare 'navigate'."
```

---

### Task 4: Procedure Lifecycle — Auto-Execute Promotion & Decay

**Problem:** `auto_execute` is hardcoded to `false` and never updated. Procedures accumulate on disk forever. No decay policy.

**Design:**
- After 5 consecutive successes (`success_count >= 5` and `failure_count === 0`), promote to `auto_execute: true`
- After 3 consecutive failures (failure_count >= 3 and success_count === 0) OR if `failure_count / (success_count + failure_count) > 0.5` with at least 5 total runs, mark as deprecated (don't delete — rename to `{name}.deprecated.json`)
- `promoteProcedure` cleans up group copies after promoting to global

**Files:**
- Modify: `src/memory/procedure-store.ts:150-182` (updateProcedureStats)
- Modify: `src/memory/procedure-store.test.ts`
- Modify: `src/learning/procedure-matcher.ts:67-104` (promoteProcedure cleanup)

- [ ] **Step 1: Write failing tests for auto-promotion**

Add to `src/memory/procedure-store.test.ts`:

```typescript
  describe('auto-execute promotion', () => {
    it('promotes to auto_execute after 5 consecutive successes', () => {
      saveProcedure(makeProcedure({ success_count: 4, failure_count: 0 }));
      updateProcedureStats('test_procedure', true);
      const found = findProcedure('test this thing');
      expect(found!.auto_execute).toBe(true);
      expect(found!.success_count).toBe(5);
    });

    it('does not promote if any failures exist', () => {
      saveProcedure(makeProcedure({ success_count: 4, failure_count: 1 }));
      updateProcedureStats('test_procedure', true);
      const found = findProcedure('test this thing');
      expect(found!.auto_execute).toBe(false);
    });
  });

  describe('procedure deprecation', () => {
    it('deprecates after 3 consecutive failures with no successes', () => {
      saveProcedure(makeProcedure({ success_count: 0, failure_count: 2 }));
      updateProcedureStats('test_procedure', false);
      // Original file should be gone
      const found = findProcedure('test this thing');
      expect(found).toBeNull();
    });

    it('deprecates when failure rate exceeds 50% with 5+ runs', () => {
      saveProcedure(makeProcedure({ success_count: 2, failure_count: 2 }));
      updateProcedureStats('test_procedure', false);
      // failure_count = 3, total = 5, rate = 60% > 50%
      const found = findProcedure('test this thing');
      expect(found).toBeNull();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/memory/procedure-store.test.ts 2>&1 | tail -10`
Expected: 2–4 failures

- [ ] **Step 3: Implement auto-promotion and decay in updateProcedureStats**

In `src/memory/procedure-store.ts`, replace `updateProcedureStats` (lines 150–182):

```typescript
export function updateProcedureStats(
  name: string,
  success: boolean,
  groupId?: string,
): boolean {
  const filePath = procedurePath(name, groupId);

  if (!fs.existsSync(filePath)) {
    if (groupId) {
      return updateProcedureStats(name, success);
    }
    return false;
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Procedure;
    if (success) {
      data.success_count = (data.success_count || 0) + 1;
    } else {
      data.failure_count = (data.failure_count || 0) + 1;
    }
    data.updated_at = new Date().toISOString();

    // Auto-promote: 5+ successes with zero failures
    if (data.success_count >= 5 && data.failure_count === 0) {
      data.auto_execute = true;
    }

    const total = data.success_count + data.failure_count;
    const shouldDeprecate =
      (data.failure_count >= 3 && data.success_count === 0) ||
      (total >= 5 && data.failure_count / total > 0.5);

    if (shouldDeprecate) {
      // Rename to .deprecated.json instead of deleting
      const deprecatedPath = filePath.replace(/\.json$/, '.deprecated.json');
      fs.renameSync(filePath, deprecatedPath);
      logger.info({ name, groupId, filePath: deprecatedPath }, 'Procedure deprecated');
      return true;
    }

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    logger.warn(
      { name, error: String(err) },
      'Failed to update procedure stats',
    );
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/memory/procedure-store.test.ts 2>&1 | tail -10`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/memory/procedure-store.ts src/memory/procedure-store.test.ts
git commit -m "feat(procedures): auto-execute promotion after 5 successes, decay on failure

Procedures with 5+ successes and zero failures auto-promote to
auto_execute: true. Procedures deprecated (renamed .deprecated.json)
after 3 failures with no successes, or >50% failure rate after 5 runs."
```

---

### Task 5: Trace Buffer Memory Bounds & Scheduled Pruning

**Problem:** `pruneOrphanedTraces()` is defined but never called. Trace buffer grows unboundedly. The prune check uses `actions[0].timestamp` (first action) which would prune active long-running traces.

**Files:**
- Modify: `src/learning/procedure-recorder.ts:32-42` (pruneOrphanedTraces)
- Modify: `src/learning/procedure-recorder.test.ts`
- Modify: `src/learning/index.ts` (schedule pruning)

- [ ] **Step 1: Write failing tests for improved pruning**

Add to `src/learning/procedure-recorder.test.ts`:

```typescript
import { pruneOrphanedTraces } from './procedure-recorder.js';

describe('pruneOrphanedTraces', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prunes traces older than MAX_TRACE_AGE_MS based on last action', () => {
    startTrace('g1', 'old-task');
    addTrace('g1', 'old-task', {
      type: 'navigate',
      timestamp: Date.now() - 2 * 60 * 60 * 1000, // 2h ago
      inputSummary: 'old',
      result: 'success',
    });
    const pruned = pruneOrphanedTraces();
    expect(pruned).toBe(1);
  });

  it('does not prune traces with recent actions', () => {
    startTrace('g1', 'recent-task');
    addTrace('g1', 'recent-task', {
      type: 'navigate',
      timestamp: Date.now() - 2 * 60 * 60 * 1000, // old first action
      inputSummary: 'first',
      result: 'success',
    });
    addTrace('g1', 'recent-task', {
      type: 'click',
      timestamp: Date.now(), // recent last action
      inputSummary: 'second',
      result: 'success',
    });
    const pruned = pruneOrphanedTraces();
    expect(pruned).toBe(0);
  });

  it('prunes empty trace buffers', () => {
    startTrace('g1', 'empty-task');
    const pruned = pruneOrphanedTraces();
    expect(pruned).toBe(1);
  });

  it('caps trace buffer at MAX_BUFFER_SIZE', () => {
    // Start many traces — only the most recent should survive
    for (let i = 0; i < 150; i++) {
      startTrace('g1', `task-${i}`);
    }
    const pruned = pruneOrphanedTraces();
    // Should have pruned at least the excess over 100
    expect(pruned).toBeGreaterThanOrEqual(50);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/learning/procedure-recorder.test.ts 2>&1 | tail -15`
Expected: "does not prune traces with recent actions" fails (current code checks first action timestamp), "caps trace buffer" fails (no cap logic)

- [ ] **Step 3: Fix pruneOrphanedTraces — check last action, add buffer cap**

In `src/learning/procedure-recorder.ts`, replace `pruneOrphanedTraces` (lines 32–42):

```typescript
const MAX_TRACE_BUFFER_SIZE = 100;

export function pruneOrphanedTraces(): number {
  const cutoff = Date.now() - MAX_TRACE_AGE_MS;
  let pruned = 0;

  // Remove old/empty traces
  for (const [key, actions] of traceBuffer.entries()) {
    if (actions.length === 0) {
      traceBuffer.delete(key);
      pruned++;
      continue;
    }
    // Check the LAST action timestamp, not the first
    const lastTimestamp = actions[actions.length - 1].timestamp;
    if (lastTimestamp < cutoff) {
      traceBuffer.delete(key);
      pruned++;
    }
  }

  // Enforce buffer size cap — evict oldest traces first
  if (traceBuffer.size > MAX_TRACE_BUFFER_SIZE) {
    const entries = [...traceBuffer.entries()].sort((a, b) => {
      const aTime = a[1].length > 0 ? a[1][a[1].length - 1].timestamp : 0;
      const bTime = b[1].length > 0 ? b[1][b[1].length - 1].timestamp : 0;
      return aTime - bTime;
    });
    const excess = traceBuffer.size - MAX_TRACE_BUFFER_SIZE;
    for (let i = 0; i < excess; i++) {
      traceBuffer.delete(entries[i][0]);
      pruned++;
    }
  }

  return pruned;
}
```

- [ ] **Step 4: Schedule pruning in learning system init**

In `src/learning/index.ts`, add a pruning interval after the event handlers. Find the end of `initLearningSystem` and add:

```typescript
// Prune orphaned trace buffers every 15 minutes
setInterval(() => {
  const pruned = pruneOrphanedTraces();
  if (pruned > 0) {
    logger.debug({ pruned }, 'Pruned orphaned traces');
  }
}, 15 * 60 * 1000);
```

Import `pruneOrphanedTraces` at the top of `src/learning/index.ts`:

```typescript
import { startTrace, addTrace, finalizeTrace, pruneOrphanedTraces } from './procedure-recorder.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/learning/procedure-recorder.test.ts 2>&1 | tail -10`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/learning/procedure-recorder.ts src/learning/procedure-recorder.test.ts src/learning/index.ts
git commit -m "fix(learning): fix trace pruning to check last action, add buffer cap and scheduler

pruneOrphanedTraces now checks the LAST action timestamp instead of
first, preventing premature pruning of active traces. Adds a 100-entry
buffer cap. Scheduled every 15 minutes via initLearningSystem."
```

---

### Task 6: Wire Webhook Event Consumer

**Problem:** `webhook-server.ts` emits `webhook.received` events on the event bus, but nothing listens for them. Events are silently dropped.

**Design:** Register a handler in `src/index.ts` that listens for `webhook.received` events and enqueues them as tasks for the appropriate group (defaults to `main`).

**Files:**
- Modify: `src/index.ts` (add event listener)
- Modify: `src/events.ts` (ensure WebhookReceivedEvent type exists)
- Create: `src/__tests__/webhook-consumer.test.ts`

- [ ] **Step 1: Check existing event types**

Read `src/events.ts` and find the `EventMap` interface. Check if `'webhook.received'` is already defined. If not, it needs to be added.

- [ ] **Step 2: Write failing test for webhook consumer**

Create `src/__tests__/webhook-consumer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('webhook consumer', () => {
  it('enqueues a task when webhook.received fires', async () => {
    // This test verifies the wiring in index.ts.
    // Since index.ts is hard to unit-test in isolation, we test the
    // handler function directly.
    const { handleWebhookEvent } = await import('../webhook-consumer.js');

    const mockEnqueue = vi.fn();
    const event = {
      type: 'webhook.github' as const,
      payload: {
        action: 'opened',
        pull_request: { title: 'test PR', number: 42 },
      },
      source: 'github',
      receivedAt: new Date().toISOString(),
    };

    handleWebhookEvent(event, mockEnqueue, 'main');

    expect(mockEnqueue).toHaveBeenCalledOnce();
    const task = mockEnqueue.mock.calls[0][0];
    expect(task).toContain('webhook');
    expect(task).toContain('github');
  });

  it('skips events with no payload', () => {
    const { handleWebhookEvent } = await import('../webhook-consumer.js');
    const mockEnqueue = vi.fn();
    const event = {
      type: 'webhook.generic' as const,
      payload: {},
      source: 'generic',
      receivedAt: new Date().toISOString(),
    };

    handleWebhookEvent(event, mockEnqueue, 'main');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/__tests__/webhook-consumer.test.ts 2>&1 | tail -10`
Expected: FAIL — module `../webhook-consumer.js` does not exist

- [ ] **Step 4: Create the webhook consumer module**

Create `src/webhook-consumer.ts`:

```typescript
import { logger } from './logger.js';

export interface WebhookEvent {
  type: string;
  payload: Record<string, unknown>;
  source: string;
  receivedAt: string;
}

/**
 * Handle an incoming webhook event by formatting it as a task prompt
 * and enqueueing it for the specified group.
 */
export function handleWebhookEvent(
  event: WebhookEvent,
  enqueueTask: (prompt: string) => void,
  groupName: string,
): void {
  if (!event.payload || Object.keys(event.payload).length === 0) {
    logger.debug({ source: event.source }, 'Skipping empty webhook payload');
    return;
  }

  const summary = JSON.stringify(event.payload).slice(0, 500);
  const prompt =
    `Incoming webhook event from ${event.source} (type: ${event.type}):\n` +
    `\`\`\`json\n${summary}\n\`\`\`\n` +
    `Summarize this event and take appropriate action if needed.`;

  enqueueTask(prompt);

  logger.info(
    { source: event.source, type: event.type, groupName },
    'Webhook event enqueued as task',
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/__tests__/webhook-consumer.test.ts 2>&1 | tail -10`
Expected: All pass

- [ ] **Step 6: Wire into index.ts**

In `src/index.ts`, after the existing `startWebhookServer` call, add:

```typescript
import { handleWebhookEvent } from './webhook-consumer.js';

// After startWebhookServer(WEBHOOK_PORT, WEBHOOK_SECRET):
eventBus.on('webhook.received', (event) => {
  handleWebhookEvent(event, (prompt) => {
    // Enqueue as a task for the main group
    const mainGroup = Object.values(registeredGroups).find((g) => g.isMain);
    if (mainGroup) {
      enqueueTask(mainGroup.folder, prompt);
    }
  }, 'main');
});
```

Find the exact insertion point by searching for `startWebhookServer` in `src/index.ts` and placing the listener right after it.

- [ ] **Step 7: Build and run full test suite**

Run: `npm run build && npx vitest run 2>&1 | tail -5`
Expected: Clean build, all tests pass

- [ ] **Step 8: Commit**

```bash
git add src/webhook-consumer.ts src/__tests__/webhook-consumer.test.ts src/index.ts src/events.ts
git commit -m "feat(webhooks): wire event consumer to process incoming webhook events

Incoming webhook events are now formatted as task prompts and enqueued
for the main group. Supports all webhook sources (GitHub, Notion, etc).
Empty payloads are silently skipped."
```

---

### Task 7: Seed Knowledge Store with Automatic Ingestion

**Problem:** Qdrant collection exists and is healthy but has 0 vectors. No automatic ingestion pipeline — only explicit agent IPC `learn_fact` calls add facts.

**Design:** Add automatic fact ingestion at two points:
1. After each successful agent task (capture the task summary as a fact)
2. From SSE email classifications (capture important email summaries)

**Files:**
- Modify: `src/index.ts` (post-task fact capture)
- Modify: `src/sse-classifier.ts` (email fact capture)
- Create: `src/__tests__/knowledge-ingestion.test.ts`

- [ ] **Step 1: Write failing test for post-task ingestion**

Create `src/__tests__/knowledge-ingestion.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockStoreFactWithVector = vi.fn().mockResolvedValue(1);

vi.mock('../memory/knowledge-store.js', () => ({
  storeFactWithVector: (...args: unknown[]) => mockStoreFactWithVector(...args),
}));

import { captureTaskOutcome } from '../knowledge-ingestion.js';

describe('captureTaskOutcome', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores a fact from a successful task', async () => {
    await captureTaskOutcome({
      groupId: 'telegram_main',
      prompt: 'Check the PR status for nanoclaw',
      status: 'success',
      durationMs: 5000,
    });

    expect(mockStoreFactWithVector).toHaveBeenCalledOnce();
    const arg = mockStoreFactWithVector.mock.calls[0][0];
    expect(arg.text).toContain('Check the PR status');
    expect(arg.domain).toBe('task_outcome');
    expect(arg.groupId).toBe('telegram_main');
    expect(arg.source).toBe('auto_capture');
  });

  it('skips failed tasks', async () => {
    await captureTaskOutcome({
      groupId: 'g1',
      prompt: 'do something',
      status: 'error',
      durationMs: 1000,
    });

    expect(mockStoreFactWithVector).not.toHaveBeenCalled();
  });

  it('truncates very long prompts', async () => {
    await captureTaskOutcome({
      groupId: 'g1',
      prompt: 'x'.repeat(1000),
      status: 'success',
      durationMs: 2000,
    });

    const arg = mockStoreFactWithVector.mock.calls[0][0];
    expect(arg.text.length).toBeLessThanOrEqual(300);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/knowledge-ingestion.test.ts 2>&1 | tail -10`
Expected: FAIL — module not found

- [ ] **Step 3: Create knowledge-ingestion module**

Create `src/knowledge-ingestion.ts`:

```typescript
import { logger } from './logger.js';

interface TaskOutcome {
  groupId: string;
  prompt: string;
  status: 'success' | 'error';
  durationMs: number;
}

const MAX_FACT_LENGTH = 250;

/**
 * Capture a successful task outcome as a knowledge fact.
 * Silently skips failed tasks and very short prompts.
 */
export async function captureTaskOutcome(outcome: TaskOutcome): Promise<void> {
  if (outcome.status !== 'success') return;
  if (outcome.prompt.length < 10) return;

  try {
    const { storeFactWithVector } = await import('./memory/knowledge-store.js');
    const truncated = outcome.prompt.slice(0, MAX_FACT_LENGTH);
    const fact = `Task completed: ${truncated} (${Math.round(outcome.durationMs / 1000)}s)`;

    await storeFactWithVector({
      text: fact,
      domain: 'task_outcome',
      groupId: outcome.groupId,
      source: 'auto_capture',
    });

    logger.debug({ groupId: outcome.groupId }, 'Task outcome captured as fact');
  } catch (err) {
    logger.debug({ err }, 'Failed to capture task outcome (non-fatal)');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/knowledge-ingestion.test.ts 2>&1 | tail -10`
Expected: All pass

- [ ] **Step 5: Wire into index.ts after successful runAgent**

In `src/index.ts`, find the code path where `runAgent` returns `'success'`. After the cost logging, add:

```typescript
import { captureTaskOutcome } from './knowledge-ingestion.js';

// After: logSessionCost(...)
if (result === 'success') {
  captureTaskOutcome({
    groupId: group.folder,
    prompt: fullPrompt.slice(0, 250),
    status: 'success',
    durationMs: Date.now() - startMs,
  }).catch(() => {});
}
```

This should be fire-and-forget (`.catch(() => {})`) to avoid blocking the message flow.

- [ ] **Step 6: Build and run full suite**

Run: `npm run build && npx vitest run 2>&1 | tail -5`
Expected: Clean build, all tests pass

- [ ] **Step 7: Commit**

```bash
git add src/knowledge-ingestion.ts src/__tests__/knowledge-ingestion.test.ts src/index.ts
git commit -m "feat(knowledge): auto-capture successful task outcomes as facts

Successful task completions are stored in the knowledge store with
domain 'task_outcome'. Prompts are truncated to 250 chars. Failed
tasks and very short prompts are skipped. Non-fatal on errors."
```

---

### Task 8: Update Upstream PR Branch

**Problem:** PR #1795 (`feat/scope-expansion` branch) is missing the latest commits: IPC bug fix, config fix, teach-mode tests, and all the work from this plan.

**Files:**
- No code changes — git operations only

- [ ] **Step 1: Update feat/scope-expansion branch from main**

```bash
git checkout feat/scope-expansion
git merge main --no-edit
git push origin feat/scope-expansion
git checkout main
```

- [ ] **Step 2: Verify PR is updated**

```bash
gh pr view 1795 --repo qwibitai/nanoclaw --json commits | head -5
```

Expected: Latest commits visible in PR

- [ ] **Step 3: Run full test suite one final time**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: All tests pass (zero failures — the 3 pre-existing were fixed in Task 1)

---

## Execution Order

Tasks are independent and can run in any order, but the recommended sequence is:

1. **Task 1** (fix index tests) — quick win, unblocks accurate test counts
2. **Task 3** (description/details mismatch) — critical data bug
3. **Task 2** (teach-mode parser) — builds on Task 3's changes to the same file
4. **Task 4** (procedure lifecycle) — depends on understanding from Tasks 2–3
5. **Task 5** (trace buffer) — independent, can run in parallel with 4
6. **Task 6** (webhook consumer) — independent
7. **Task 7** (knowledge ingestion) — independent
8. **Task 8** (upstream PR) — must be last

## Verification Checklist

After all tasks:

- [ ] `npx vitest run` — zero failures
- [ ] `npx tsc --noEmit` — zero TypeScript errors
- [ ] `npm run build` — clean
- [ ] NanoClaw running with all integrations: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- [ ] Webhook server listening: `curl -s http://localhost:8090/` returns 405
- [ ] Qdrant has vectors: `curl -s http://localhost:6333/collections/nanoclaw_knowledge | jq .result.points_count`
- [ ] All commits pushed: `git log --oneline origin/main..main` is empty
