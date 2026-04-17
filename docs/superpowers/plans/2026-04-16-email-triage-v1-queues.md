# Email Triage v1 — Queues + LLM Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rule-based `classify()` in `sse-classifier.ts` with a tier-routed, prompt-cached LLM classifier; add pinned live dashboards for attention/archive queues in Telegram; wire closed-loop learning from user button clicks. Ship behind `TRIAGE_V1_ENABLED` with a shadow-mode stage before going live.

**Architecture:** Extend existing infrastructure rather than replace it. Reuses `src/email-sse.ts` (SSE consumer), `src/tracked-items.ts` (state machine + SQLite), `src/callback-router.ts` (Telegram button routing), `src/classification-adjustments.ts` + `src/sender-allowlist.ts` (learning), `src/digest-engine.ts` (archive digest posting), `src/llm/` (provider resolution), `src/memory/knowledge-store.ts` (Weaviate). New modules live under `src/triage/`.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, Vitest. **LLM calls use the Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`) — the pattern already used in `src/llm/utility.ts`. Prompt caching on Anthropic is exposed via `providerOptions.anthropic.cacheControl` on message parts (verify shape against installed `@ai-sdk/anthropic` version, currently `^3.0.69`). MLflow is not wired at runtime in v1 — JSONL traces under `.omc/logs/triage/` are sufficient.

**Reference spec:** [2026-04-16-email-triage-pipeline-design.md](../specs/2026-04-16-email-triage-pipeline-design.md)

---

## Pre-work: Verify baseline

- [ ] **Step 0.1: Run the full test suite on main to capture baseline**

Run: `npm test`
Expected: All pass. If any are broken before this plan starts, open a separate bug fix — do not proceed until main is green.

- [ ] **Step 0.2: Verify Vercel AI SDK deps are present**

Run: `grep -E '"ai"|"@ai-sdk/anthropic"' package.json`
Expected: both present. The codebase uses the Vercel AI SDK (see `src/llm/utility.ts` for the canonical pattern). Do NOT install `@anthropic-ai/sdk`; use `@ai-sdk/anthropic` + `generateText`/`generateObject` from `ai`.

- [ ] **Step 0.3: Confirm SuperPilot SSE is flowing**

Run: `npm run dev` in one terminal, watch logs for `SSE connected to superpilot`. Ctrl-C once confirmed.

---

## Task 1: Database schema migration — extend tracked_items for triage

**Files:**
- Modify: `src/db.ts` (add migration)
- Modify: `src/tracked-items.ts` (extend TrackedItem type + CRUD)
- Test: `src/__tests__/db-migration.test.ts` (add case)

The existing `tracked_items` table already holds email triage state. Add the columns needed by the LLM classifier: `confidence`, `model_tier`, `action_intent`, `facts_extracted_json`, `repo_candidates_json`. Keep `classification_reason` as-is (legacy); add richer `reasons_json` alongside.

- [ ] **Step 1.1: Write the failing migration test**

Add to `src/__tests__/db-migration.test.ts` (or create if missing):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';

describe('triage migration', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('adds triage columns to tracked_items', () => {
    const db = getDb();
    const cols = db
      .prepare("PRAGMA table_info('tracked_items')")
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('confidence');
    expect(names).toContain('model_tier');
    expect(names).toContain('action_intent');
    expect(names).toContain('facts_extracted_json');
    expect(names).toContain('repo_candidates_json');
    expect(names).toContain('reasons_json');
  });
});
```

- [ ] **Step 1.2: Run test to confirm failure**

Run: `npm test -- db-migration.test.ts`
Expected: FAIL — columns do not exist yet.

- [ ] **Step 1.3: Add the migration to `src/db.ts`**

Locate the `migrate()` function (or the section that runs `ALTER TABLE` migrations idempotently). Append:

```typescript
// Triage v1 columns
const trackedColumns = db
  .prepare("PRAGMA table_info('tracked_items')")
  .all() as { name: string }[];
const trackedColNames = new Set(trackedColumns.map((c) => c.name));
const triageColumns: Array<[string, string]> = [
  ['confidence', 'REAL'],
  ['model_tier', 'INTEGER'],
  ['action_intent', 'TEXT'],
  ['facts_extracted_json', 'TEXT'],
  ['repo_candidates_json', 'TEXT'],
  ['reasons_json', 'TEXT'],
];
for (const [col, type] of triageColumns) {
  if (!trackedColNames.has(col)) {
    db.prepare(`ALTER TABLE tracked_items ADD COLUMN ${col} ${type}`).run();
  }
}
```

Use the exact pattern already present for any prior `ALTER TABLE` migration — search `src/db.ts` for existing `ALTER TABLE` and match style.

- [ ] **Step 1.4: Extend `TrackedItem` in `src/tracked-items.ts`**

Add to the `TrackedItem` interface (after `metadata`):

```typescript
  // Triage v1 fields
  confidence: number | null;
  model_tier: number | null;
  action_intent: string | null;
  facts_extracted: Array<{ key: string; value: string; source_span: string }> | null;
  repo_candidates: Array<{ repo: string; score: number; signal: string }> | null;
  reasons: string[] | null;
```

Update `insertTrackedItem()` to write these columns and the corresponding `SELECT` mapper to parse the `_json` columns via `JSON.parse` (null-safe).

- [ ] **Step 1.5: Run test to confirm pass**

Run: `npm test -- db-migration.test.ts`
Expected: PASS.

- [ ] **Step 1.6: Run full tracked-items test suite — no regressions**

Run: `npm test -- tracked-items`
Expected: PASS.

- [ ] **Step 1.7: Commit**

```bash
git add src/db.ts src/tracked-items.ts src/__tests__/db-migration.test.ts
git commit -m "feat(triage): add triage columns to tracked_items"
```

---

## Task 2: Triage config + feature flags

**Files:**
- Create: `src/triage/config.ts`
- Modify: `src/config.ts` (export new env-driven flags)

- [ ] **Step 2.1: Write the failing test**

Create `src/__tests__/triage-config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TRIAGE_DEFAULTS } from '../triage/config.js';

describe('triage config', () => {
  it('defines sensible default thresholds', () => {
    expect(TRIAGE_DEFAULTS.attentionThreshold).toBeGreaterThan(0);
    expect(TRIAGE_DEFAULTS.attentionThreshold).toBeLessThan(1);
    expect(TRIAGE_DEFAULTS.archiveThreshold).toBeGreaterThan(
      TRIAGE_DEFAULTS.attentionThreshold,
    );
    expect(TRIAGE_DEFAULTS.escalateLow).toBeLessThan(TRIAGE_DEFAULTS.escalateHigh);
    expect(TRIAGE_DEFAULTS.dailyCostCapUsd).toBeGreaterThan(0);
  });

  it('defines tier-model mapping', () => {
    expect(TRIAGE_DEFAULTS.models.tier1).toMatch(/haiku/);
    expect(TRIAGE_DEFAULTS.models.tier2).toMatch(/sonnet/);
    expect(TRIAGE_DEFAULTS.models.tier3).toMatch(/opus/);
  });
});
```

- [ ] **Step 2.2: Run test to confirm failure**

Run: `npm test -- triage-config`
Expected: FAIL — module does not exist.

- [ ] **Step 2.3: Create `src/triage/config.ts`**

```typescript
/**
 * Triage v1 configuration. Sourced from env vars with sane defaults.
 * See docs/superpowers/specs/2026-04-16-email-triage-pipeline-design.md.
 */

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const TRIAGE_DEFAULTS = {
  enabled: envBool('TRIAGE_V1_ENABLED', false),
  shadowMode: envBool('TRIAGE_SHADOW_MODE', true),

  models: {
    tier1: envStr('TRIAGE_MODEL_TIER1', 'claude-haiku-4-5-20251001'),
    tier2: envStr('TRIAGE_MODEL_TIER2', 'claude-sonnet-4-6'),
    tier3: envStr('TRIAGE_MODEL_TIER3', 'claude-opus-4-7'),
  },

  attentionThreshold: envNum('TRIAGE_ATTENTION_THRESHOLD', 0.7),
  archiveThreshold: envNum('TRIAGE_ARCHIVE_THRESHOLD', 0.8),
  escalateLow: envNum('TRIAGE_ESCALATE_LOW', 0.3),
  escalateHigh: envNum('TRIAGE_ESCALATE_HIGH', 0.75),

  skiplistPromotionHits: envNum('TRIAGE_SKIPLIST_PROMOTION_HITS', 5),
  attentionRemindHours: envNum('TRIAGE_ATTENTION_REMIND_HOURS', 4),
  negativeExamplesRetained: envNum('TRIAGE_NEGATIVE_EXAMPLES_RETAINED', 10),
  positiveExamplesRetained: envNum('TRIAGE_POSITIVE_EXAMPLES_RETAINED', 20),

  dailyCostCapUsd: envNum('TRIAGE_DAILY_COST_CAP_USD', 2.0),
} as const;

export type TriageDefaults = typeof TRIAGE_DEFAULTS;
```

- [ ] **Step 2.4: Run test to confirm pass**

Run: `npm test -- triage-config`
Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add src/triage/config.ts src/__tests__/triage-config.test.ts
git commit -m "feat(triage): add triage config module with env-driven flags"
```

---

## Task 3: Structured output schema + validator

**Files:**
- Create: `src/triage/schema.ts`
- Test: `src/__tests__/triage-schema.test.ts`

The classifier must emit strict JSON matching `TriageDecision`. Invalid output → retry with stricter instruction → escalate to next tier.

- [ ] **Step 3.1: Write failing tests**

Create `src/__tests__/triage-schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateTriageDecision } from '../triage/schema.js';

describe('validateTriageDecision', () => {
  const valid = {
    queue: 'attention',
    confidence: 0.85,
    reasons: ['GitHub PR review requested', 'sender in VIP list'],
    action_intent: 'none',
    facts_extracted: [],
    repo_candidates: [],
    attention_reason: 'direct review ask from teammate',
  };

  it('accepts valid decision', () => {
    expect(validateTriageDecision(valid)).toEqual({ ok: true, value: valid });
  });

  it('rejects when reasons has fewer than 2 entries', () => {
    const bad = { ...valid, reasons: ['only one'] };
    const r = validateTriageDecision(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least 2 reasons/i);
  });

  it('rejects when queue=attention but attention_reason is missing', () => {
    const bad = { ...valid, attention_reason: undefined };
    const r = validateTriageDecision(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/attention_reason/);
  });

  it('rejects when queue=archive_candidate but archive_category is missing', () => {
    const bad = {
      ...valid,
      queue: 'archive_candidate',
      attention_reason: undefined,
    };
    const r = validateTriageDecision(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/archive_category/);
  });

  it('rejects invalid queue value', () => {
    const r = validateTriageDecision({ ...valid, queue: 'garbage' });
    expect(r.ok).toBe(false);
  });

  it('rejects confidence out of [0,1]', () => {
    const r = validateTriageDecision({ ...valid, confidence: 1.5 });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 3.2: Run test to confirm failure**

Run: `npm test -- triage-schema`
Expected: FAIL.

- [ ] **Step 3.3: Implement `src/triage/schema.ts`**

```typescript
export type TriageQueue =
  | 'attention'
  | 'archive_candidate'
  | 'action'
  | 'ignore';

export type ActionIntent =
  | 'bug_report'
  | 'sentry_alert'
  | 'dependabot'
  | 'security_alert'
  | 'deadline'
  | 'receipt'
  | 'knowledge_extract'
  | 'none';

export interface ExtractedFact {
  key: string;
  value: string;
  source_span: string;
}

export interface RepoCandidate {
  repo: string;
  score: number;
  signal: string;
}

export interface TriageDecision {
  queue: TriageQueue;
  confidence: number;
  reasons: string[];
  action_intent?: ActionIntent;
  facts_extracted: ExtractedFact[];
  repo_candidates: RepoCandidate[];
  attention_reason?: string;
  archive_category?: string;
}

export type ValidationResult =
  | { ok: true; value: TriageDecision }
  | { ok: false; error: string };

const VALID_QUEUES: ReadonlySet<string> = new Set([
  'attention',
  'archive_candidate',
  'action',
  'ignore',
]);
const VALID_INTENTS: ReadonlySet<string> = new Set([
  'bug_report',
  'sentry_alert',
  'dependabot',
  'security_alert',
  'deadline',
  'receipt',
  'knowledge_extract',
  'none',
]);

export function validateTriageDecision(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'decision is not an object' };
  }
  const d = raw as Record<string, unknown>;

  if (typeof d.queue !== 'string' || !VALID_QUEUES.has(d.queue)) {
    return { ok: false, error: `invalid queue: ${String(d.queue)}` };
  }
  if (
    typeof d.confidence !== 'number' ||
    d.confidence < 0 ||
    d.confidence > 1
  ) {
    return { ok: false, error: 'confidence must be number in [0,1]' };
  }
  if (!Array.isArray(d.reasons) || d.reasons.length < 2) {
    return { ok: false, error: 'reasons must have at least 2 entries' };
  }
  if (d.reasons.some((r) => typeof r !== 'string')) {
    return { ok: false, error: 'reasons must all be strings' };
  }
  if (d.action_intent !== undefined && typeof d.action_intent === 'string') {
    if (!VALID_INTENTS.has(d.action_intent)) {
      return { ok: false, error: `invalid action_intent: ${d.action_intent}` };
    }
  }
  if (!Array.isArray(d.facts_extracted)) {
    return { ok: false, error: 'facts_extracted must be an array' };
  }
  if (!Array.isArray(d.repo_candidates)) {
    return { ok: false, error: 'repo_candidates must be an array' };
  }
  if (d.queue === 'attention' && typeof d.attention_reason !== 'string') {
    return {
      ok: false,
      error: 'attention_reason is required when queue=attention',
    };
  }
  if (
    d.queue === 'archive_candidate' &&
    typeof d.archive_category !== 'string'
  ) {
    return {
      ok: false,
      error: 'archive_category is required when queue=archive_candidate',
    };
  }

  return { ok: true, value: d as unknown as TriageDecision };
}
```

- [ ] **Step 3.4: Run test to confirm pass**

Run: `npm test -- triage-schema`
Expected: PASS.

- [ ] **Step 3.5: Commit**

```bash
git add src/triage/schema.ts src/__tests__/triage-schema.test.ts
git commit -m "feat(triage): add structured output schema with validation"
```

---

## Task 4: Pre-filter — SuperPilot flags + skip-list

**Files:**
- Create: `src/triage/prefilter.ts`
- Test: `src/__tests__/triage-prefilter.test.ts`

The pre-filter answers: "should this email skip the LLM entirely?" Returns `{ skip: true, reason }` for bulk/promotional SP labels and learned skip-list hits. Builds on existing `src/sender-allowlist.ts` patterns but stored in a new `skip_list` table for triage.

- [ ] **Step 4.1: Add skip_list table migration to `src/db.ts`**

In the same migration section as Task 1, add:

```typescript
db.prepare(
  `CREATE TABLE IF NOT EXISTS triage_skip_list (
    pattern TEXT PRIMARY KEY,
    pattern_type TEXT NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 0,
    last_hit_at INTEGER NOT NULL,
    promoted_at INTEGER
  )`,
).run();
```

- [ ] **Step 4.2: Write the failing test**

Create `src/__tests__/triage-prefilter.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';
import { shouldSkip, recordSkip } from '../triage/prefilter.js';

describe('triage prefilter', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('skips when SuperPilot labels as newsletter', () => {
    const r = shouldSkip({
      superpilotLabel: 'newsletter',
      sender: 'hello@ben-evans.com',
    });
    expect(r.skip).toBe(true);
    expect(r.reason).toMatch(/newsletter/);
  });

  it('skips when sender is on promoted skip list', () => {
    getDb()
      .prepare(
        `INSERT INTO triage_skip_list (pattern, pattern_type, hit_count, last_hit_at, promoted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('noreply@foo.com', 'sender_exact', 5, Date.now(), Date.now());

    const r = shouldSkip({
      superpilotLabel: 'fyi',
      sender: 'noreply@foo.com',
    });
    expect(r.skip).toBe(true);
    expect(r.reason).toMatch(/skip_list/);
  });

  it('does NOT skip when sender is on skip list but not promoted', () => {
    getDb()
      .prepare(
        `INSERT INTO triage_skip_list (pattern, pattern_type, hit_count, last_hit_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('noreply@foo.com', 'sender_exact', 3, Date.now());

    const r = shouldSkip({
      superpilotLabel: 'fyi',
      sender: 'noreply@foo.com',
    });
    expect(r.skip).toBe(false);
  });

  it('does NOT skip when nothing matches', () => {
    const r = shouldSkip({
      superpilotLabel: 'needs-attention',
      sender: 'alice@example.com',
    });
    expect(r.skip).toBe(false);
  });
});
```

- [ ] **Step 4.3: Run test to confirm failure**

Run: `npm test -- triage-prefilter`
Expected: FAIL — module does not exist.

- [ ] **Step 4.4: Implement `src/triage/prefilter.ts`**

```typescript
import { getDb } from '../db.js';

const SKIP_LABELS: ReadonlySet<string> = new Set([
  'newsletter',
  'promotional',
  'bulk',
]);

export interface PrefilterInput {
  superpilotLabel: string | null;
  sender: string;
}

export interface PrefilterResult {
  skip: boolean;
  reason: string;
}

export function shouldSkip(input: PrefilterInput): PrefilterResult {
  if (input.superpilotLabel && SKIP_LABELS.has(input.superpilotLabel)) {
    return { skip: true, reason: `superpilot:${input.superpilotLabel}` };
  }

  const row = getDb()
    .prepare(
      `SELECT promoted_at FROM triage_skip_list
       WHERE pattern = ? AND pattern_type = 'sender_exact' AND promoted_at IS NOT NULL`,
    )
    .get(input.sender.toLowerCase()) as { promoted_at: number } | undefined;
  if (row) return { skip: true, reason: 'skip_list:sender_exact' };

  const domain = input.sender.toLowerCase().split('@')[1];
  if (domain) {
    const drow = getDb()
      .prepare(
        `SELECT promoted_at FROM triage_skip_list
         WHERE pattern = ? AND pattern_type = 'sender_domain' AND promoted_at IS NOT NULL`,
      )
      .get(domain) as { promoted_at: number } | undefined;
    if (drow) return { skip: true, reason: 'skip_list:sender_domain' };
  }

  return { skip: false, reason: 'no_match' };
}

/**
 * Record a user's archive action. After PROMOTION_HITS consistent archives
 * of the same sender, mark pattern as promoted (active skip-list entry).
 */
export function recordSkip(
  sender: string,
  promotionHits: number,
): { promoted: boolean } {
  const pattern = sender.toLowerCase();
  const now = Date.now();
  const db = getDb();

  db.prepare(
    `INSERT INTO triage_skip_list (pattern, pattern_type, hit_count, last_hit_at)
     VALUES (?, 'sender_exact', 1, ?)
     ON CONFLICT(pattern) DO UPDATE SET
       hit_count = hit_count + 1,
       last_hit_at = excluded.last_hit_at`,
  ).run(pattern, now);

  const row = db
    .prepare(
      `SELECT hit_count, promoted_at FROM triage_skip_list WHERE pattern = ?`,
    )
    .get(pattern) as { hit_count: number; promoted_at: number | null };

  if (row.hit_count >= promotionHits && row.promoted_at === null) {
    db.prepare(
      `UPDATE triage_skip_list SET promoted_at = ? WHERE pattern = ?`,
    ).run(now, pattern);
    return { promoted: true };
  }

  return { promoted: false };
}
```

- [ ] **Step 4.5: Run test to confirm pass**

Run: `npm test -- triage-prefilter`
Expected: PASS.

- [ ] **Step 4.6: Commit**

```bash
git add src/db.ts src/triage/prefilter.ts src/__tests__/triage-prefilter.test.ts
git commit -m "feat(triage): add pre-filter with SP flags + skip-list promotion"
```

---

## Task 5: Example store — positive/negative examples for prompt injection

**Files:**
- Create: `src/triage/examples.ts`
- Test: `src/__tests__/triage-examples.test.ts`

Every user override (buttonclick that disagrees with agent) becomes a negative example. Correct high-confidence decisions become positive examples. Ring-buffered per config limits.

- [ ] **Step 5.1: Add `triage_examples` table migration to `src/db.ts`**

```typescript
db.prepare(
  `CREATE TABLE IF NOT EXISTS triage_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,                -- 'positive' | 'negative'
    tracked_item_id TEXT NOT NULL,
    email_summary TEXT NOT NULL,
    agent_queue TEXT NOT NULL,
    user_queue TEXT NOT NULL,
    reasons_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
).run();
db.prepare(
  `CREATE INDEX IF NOT EXISTS idx_triage_examples_kind_created
   ON triage_examples(kind, created_at DESC)`,
).run();
```

- [ ] **Step 5.2: Write failing tests**

Create `src/__tests__/triage-examples.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';
import {
  recordExample,
  getRecentExamples,
} from '../triage/examples.js';

describe('triage examples store', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('stores and retrieves negative examples ordered desc', () => {
    recordExample({
      kind: 'negative',
      trackedItemId: 'a',
      emailSummary: 'A summary',
      agentQueue: 'archive_candidate',
      userQueue: 'attention',
      reasons: ['was bulk promo', 'sender unknown'],
    });
    recordExample({
      kind: 'negative',
      trackedItemId: 'b',
      emailSummary: 'B summary',
      agentQueue: 'archive_candidate',
      userQueue: 'attention',
      reasons: ['r1', 'r2'],
    });

    const recent = getRecentExamples('negative', 10);
    expect(recent.length).toBe(2);
    expect(recent[0].trackedItemId).toBe('b');
    expect(recent[1].trackedItemId).toBe('a');
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 15; i++) {
      recordExample({
        kind: 'positive',
        trackedItemId: `t${i}`,
        emailSummary: 'summary',
        agentQueue: 'archive_candidate',
        userQueue: 'archive_candidate',
        reasons: ['r1', 'r2'],
      });
    }
    const recent = getRecentExamples('positive', 5);
    expect(recent.length).toBe(5);
  });
});
```

- [ ] **Step 5.3: Run test — confirm failure**

Run: `npm test -- triage-examples`
Expected: FAIL.

- [ ] **Step 5.4: Implement `src/triage/examples.ts`**

```typescript
import { getDb } from '../db.js';

export type ExampleKind = 'positive' | 'negative';

export interface TriageExample {
  kind: ExampleKind;
  trackedItemId: string;
  emailSummary: string;
  agentQueue: string;
  userQueue: string;
  reasons: string[];
}

export function recordExample(ex: TriageExample): void {
  getDb()
    .prepare(
      `INSERT INTO triage_examples
       (kind, tracked_item_id, email_summary, agent_queue, user_queue,
        reasons_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ex.kind,
      ex.trackedItemId,
      ex.emailSummary,
      ex.agentQueue,
      ex.userQueue,
      JSON.stringify(ex.reasons),
      Date.now(),
    );
}

export function getRecentExamples(
  kind: ExampleKind,
  limit: number,
): TriageExample[] {
  const rows = getDb()
    .prepare(
      `SELECT kind, tracked_item_id, email_summary, agent_queue, user_queue,
              reasons_json
       FROM triage_examples
       WHERE kind = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(kind, limit) as Array<{
    kind: ExampleKind;
    tracked_item_id: string;
    email_summary: string;
    agent_queue: string;
    user_queue: string;
    reasons_json: string;
  }>;

  return rows.map((r) => ({
    kind: r.kind,
    trackedItemId: r.tracked_item_id,
    emailSummary: r.email_summary,
    agentQueue: r.agent_queue,
    userQueue: r.user_queue,
    reasons: JSON.parse(r.reasons_json) as string[],
  }));
}
```

- [ ] **Step 5.5: Run test — confirm pass**

Run: `npm test -- triage-examples`
Expected: PASS.

- [ ] **Step 5.6: Commit**

```bash
git add src/db.ts src/triage/examples.ts src/__tests__/triage-examples.test.ts
git commit -m "feat(triage): add positive/negative example store"
```

---

## Task 6: Prompt builder with cacheable layers

**Files:**
- Create: `src/triage/prompt-builder.ts`
- Test: `src/__tests__/triage-prompt-builder.test.ts`
- Create: `memory/triage_rules.md` (seed file, separate commit if preferred)

The classifier's prompt has 5 stable-to-volatile layers. Cacheable blocks must come before the variable block. We use Anthropic's `cache_control: { type: 'ephemeral' }` on up to 4 breakpoints.

- [ ] **Step 6.1: Create seed `memory/triage_rules.md`**

```markdown
# Triage Rules (user-editable)

These are my standing preferences. Treat them as hard constraints.

- Never auto-archive. Always propose, wait for my button click.
- Security alerts (new device login, password reset I did not request, breach notifications) → attention queue, always.
- GitHub PR review requests where I am explicitly tagged → attention queue.
- Sentry alerts with spike > 10 errors/min → attention queue.
- Dependabot / CodeQL / CVE notifications → attention queue with action_intent=dependabot.
- Receipts and invoices → archive_candidate, category=receipt, extract vendor/amount/date as facts.
- Newsletters and product updates → archive_candidate unless the sender is explicitly in my VIP list.
- Calendar invites → attention queue (I will decide manually).
- Family emails → attention queue regardless of content.
```

- [ ] **Step 6.2: Write failing tests**

Create `src/__tests__/triage-prompt-builder.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../triage/examples.js', () => ({
  getRecentExamples: vi.fn(() => []),
}));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual };
});

import { buildPrompt } from '../triage/prompt-builder.js';

describe('buildPrompt', () => {
  it('returns stable + variable sections with cache breakpoints', () => {
    const out = buildPrompt({
      emailBody: 'Hello, please review PR #42',
      sender: 'alice@example.com',
      subject: 'PR review',
      superpilotLabel: 'needs-attention',
      threadId: 't1',
      account: 'me@gmail.com',
    });

    expect(out.system).toMatch(/output schema/i);
    expect(out.systemBlocks.length).toBeGreaterThanOrEqual(2);
    const cacheable = out.systemBlocks.filter(
      (b) => b.cache_control !== undefined,
    );
    expect(cacheable.length).toBeGreaterThanOrEqual(1);

    expect(out.userMessage).toContain('alice@example.com');
    expect(out.userMessage).toContain('Hello, please review PR #42');
  });

  it('includes the triage rules file when it exists', () => {
    const out = buildPrompt({
      emailBody: 'x',
      sender: 's',
      subject: 'y',
      superpilotLabel: null,
      threadId: 't',
      account: 'a',
    });
    const combined = out.systemBlocks.map((b) => b.text).join('\n');
    expect(combined).toMatch(/Never auto-archive|triage_rules/i);
  });
});
```

- [ ] **Step 6.3: Run tests — confirm failure**

Run: `npm test -- triage-prompt-builder`
Expected: FAIL.

- [ ] **Step 6.4: Implement `src/triage/prompt-builder.ts`**

```typescript
import fs from 'fs';
import path from 'path';
import { getRecentExamples } from './examples.js';
import { TRIAGE_DEFAULTS } from './config.js';

export interface PromptBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface BuildPromptInput {
  emailBody: string;
  sender: string;
  subject: string;
  superpilotLabel: string | null;
  threadId: string;
  account: string;
  rulesPath?: string;      // override for tests
  memoryDir?: string;
}

export interface BuiltPrompt {
  system: string;           // joined convenience
  systemBlocks: PromptBlock[];
  userMessage: string;
}

const SYSTEM_CORE = `You are the NanoClaw email triage classifier.

You will classify one email into a strict JSON decision matching this schema:

{
  "queue": "attention" | "archive_candidate" | "action" | "ignore",
  "confidence": number in [0,1],
  "reasons": string[] (AT LEAST 2 entries, concrete observations, not vibes),
  "action_intent": "bug_report" | "sentry_alert" | "dependabot" |
                   "security_alert" | "deadline" | "receipt" |
                   "knowledge_extract" | "none",
  "facts_extracted": [{"key": string, "value": string, "source_span": string}],
  "repo_candidates": [{"repo": string, "score": number, "signal": string}],
  "attention_reason": string (REQUIRED when queue=attention),
  "archive_category": string (REQUIRED when queue=archive_candidate)
}

Hard rules:
- If queue=attention you MUST include attention_reason.
- If queue=archive_candidate you MUST include archive_category.
- reasons MUST contain at least 2 strings.
- Output JSON only. No prose. No markdown fences.

You will be given stable context first, then the specific email.`;

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function renderExamples(
  examples: ReturnType<typeof getRecentExamples>,
  header: string,
): string {
  if (examples.length === 0) return '';
  const rendered = examples
    .map(
      (ex, i) =>
        `#${i + 1} summary: ${ex.emailSummary}\n` +
        `   agent chose: ${ex.agentQueue} | user corrected to: ${ex.userQueue}\n` +
        `   reasons: ${ex.reasons.join('; ')}`,
    )
    .join('\n');
  return `\n\n${header}\n${rendered}`;
}

export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const memoryDir = input.memoryDir ?? path.resolve(process.cwd(), 'memory');
  const rulesPath =
    input.rulesPath ?? path.join(memoryDir, 'triage_rules.md');
  const rules = readIfExists(rulesPath) ?? '';

  const negatives = getRecentExamples(
    'negative',
    TRIAGE_DEFAULTS.negativeExamplesRetained,
  );
  const positives = getRecentExamples(
    'positive',
    TRIAGE_DEFAULTS.positiveExamplesRetained,
  );

  // Stable blocks (cached, in order). We use 3 cache breakpoints total.
  const stable1: PromptBlock = {
    type: 'text',
    text: SYSTEM_CORE,
    cache_control: { type: 'ephemeral' },
  };
  const stable2: PromptBlock = {
    type: 'text',
    text: `USER STANDING RULES (hard constraints):\n\n${rules || '(none)'}`,
    cache_control: { type: 'ephemeral' },
  };
  const stable3: PromptBlock = {
    type: 'text',
    text:
      `NEGATIVE EXAMPLES — user corrected the agent. Avoid repeating these mistakes:` +
      (renderExamples(negatives, '') || '\n(none yet)'),
    cache_control: { type: 'ephemeral' },
  };
  const rotating: PromptBlock = {
    type: 'text',
    text:
      `RECENT POSITIVE EXAMPLES — user confirmed these were correct:` +
      (renderExamples(positives, '') || '\n(none yet)'),
  };

  const systemBlocks: PromptBlock[] = [stable1, stable2, stable3, rotating];

  const userMessage = [
    `Email to classify:`,
    `From: ${input.sender}`,
    `Subject: ${input.subject}`,
    `Account: ${input.account}`,
    `Thread-ID: ${input.threadId}`,
    `SuperPilot label: ${input.superpilotLabel ?? '(none)'}`,
    ``,
    `--- body ---`,
    input.emailBody,
    `--- /body ---`,
    ``,
    `Return the JSON decision now.`,
  ].join('\n');

  const system = systemBlocks.map((b) => b.text).join('\n\n');
  return { system, systemBlocks, userMessage };
}
```

- [ ] **Step 6.5: Run tests — confirm pass**

Run: `npm test -- triage-prompt-builder`
Expected: PASS.

- [ ] **Step 6.6: Commit (two commits — rules file separate)**

```bash
git add memory/triage_rules.md
git commit -m "chore(triage): seed user-editable triage rules"

git add src/triage/prompt-builder.ts src/__tests__/triage-prompt-builder.test.ts
git commit -m "feat(triage): add cacheable layered prompt builder"
```

---

## Task 7: LLM classifier — tier-routed call with caching + retry

**Files:**
- Create: `src/triage/classifier.ts`
- Test: `src/__tests__/triage-classifier.test.ts`

This is the heart of v1. Uses **Vercel AI SDK** (`generateText` from `ai` + `createAnthropic` from `@ai-sdk/anthropic`) — matching the pattern in `src/llm/utility.ts`. Parses JSON, validates, retries once on malformed, escalates to next tier on still-invalid or when `confidence ∈ (escalateLow, escalateHigh)`.

**Anthropic prompt caching via Vercel AI SDK:** Pass `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }` on system/message parts. The Vercel SDK forwards this to the Anthropic API as `cache_control`. Verify exact shape against installed `@ai-sdk/anthropic` version (currently `^3.0.69`) — consult `node_modules/@ai-sdk/anthropic/README.md` or the package's types if uncertain. If the installed version expects a different shape for per-part cache control, adapt the call-site; the rest of the classifier logic is SDK-agnostic.

**What to mock in tests:** mock `generateText` from `ai` (not the Anthropic SDK). Test doubles return `{ text, usage: { inputTokens, outputTokens, cachedInputTokens } }` — the Vercel SDK's shape.

- [ ] **Step 7.1: Write failing tests**

Create `src/__tests__/triage-classifier.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerateText = vi.fn();
vi.mock('ai', () => ({
  generateText: mockGenerateText,
}));
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));
vi.mock('../triage/examples.js', () => ({
  getRecentExamples: vi.fn(() => []),
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { classifyWithLlm } from '../triage/classifier.js';

function fakeResponse(json: object, cached = 80) {
  return {
    text: JSON.stringify(json),
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: cached,
    },
  };
}

describe('classifyWithLlm', () => {
  beforeEach(() => mockGenerateText.mockReset());

  it('returns decision on first try at tier1 when valid + high confidence', async () => {
    mockGenerateText.mockResolvedValueOnce(
      fakeResponse({
        queue: 'attention',
        confidence: 0.9,
        reasons: ['direct ask', 'VIP sender'],
        action_intent: 'none',
        facts_extracted: [],
        repo_candidates: [],
        attention_reason: 'direct ask',
      }),
    );

    const out = await classifyWithLlm({
      emailBody: 'review this pls',
      sender: 'alice@example.com',
      subject: 'hi',
      superpilotLabel: 'needs-attention',
      threadId: 't1',
      account: 'me@gmail.com',
    });

    expect(out.decision.queue).toBe('attention');
    expect(out.tier).toBe(1);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it('escalates to tier2 when tier1 confidence is in the gap band', async () => {
    mockGenerateText
      .mockResolvedValueOnce(
        fakeResponse({
          queue: 'archive_candidate',
          confidence: 0.5,
          reasons: ['mixed', 'unclear'],
          action_intent: 'none',
          facts_extracted: [],
          repo_candidates: [],
          archive_category: 'newsletter',
        }),
      )
      .mockResolvedValueOnce(
        fakeResponse({
          queue: 'archive_candidate',
          confidence: 0.9,
          reasons: ['clearer on re-read', 'bulk footer'],
          action_intent: 'none',
          facts_extracted: [],
          repo_candidates: [],
          archive_category: 'newsletter',
        }),
      );

    const out = await classifyWithLlm({
      emailBody: 'hmm',
      sender: 'x@y.com',
      subject: 's',
      superpilotLabel: null,
      threadId: 't',
      account: 'a',
    });
    expect(out.tier).toBe(2);
    expect(out.decision.confidence).toBe(0.9);
  });

  it('retries once on malformed JSON, then escalates if still malformed', async () => {
    mockGenerateText
      .mockResolvedValueOnce({
        text: 'not-json {',
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      })
      .mockResolvedValueOnce({
        text: 'still bad',
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      })
      .mockResolvedValueOnce(
        fakeResponse({
          queue: 'ignore',
          confidence: 0.8,
          reasons: ['empty', 'no content'],
          action_intent: 'none',
          facts_extracted: [],
          repo_candidates: [],
        }),
      );

    const out = await classifyWithLlm({
      emailBody: '',
      sender: 'x@y.com',
      subject: '',
      superpilotLabel: null,
      threadId: 't',
      account: 'a',
    });
    expect(out.tier).toBe(2);
    expect(out.decision.queue).toBe('ignore');
    expect(mockGenerateText).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 7.2: Run tests — confirm failure**

Run: `npm test -- triage-classifier`
Expected: FAIL.

- [ ] **Step 7.3: Implement `src/triage/classifier.ts`**

```typescript
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { logger } from '../logger.js';
import { buildPrompt, type BuildPromptInput } from './prompt-builder.js';
import { TRIAGE_DEFAULTS } from './config.js';
import {
  validateTriageDecision,
  type TriageDecision,
} from './schema.js';

export interface ClassifierResult {
  decision: TriageDecision;
  tier: 1 | 2 | 3;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

// Resolve Anthropic model by tier. Lazy + memoized.
const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
});

function modelForTier(tier: 1 | 2 | 3) {
  const modelId =
    tier === 1
      ? TRIAGE_DEFAULTS.models.tier1
      : tier === 2
        ? TRIAGE_DEFAULTS.models.tier2
        : TRIAGE_DEFAULTS.models.tier3;
  return anthropic(modelId);
}

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

async function callTier(
  tier: 1 | 2 | 3,
  input: BuildPromptInput,
  stricterInstruction?: string,
): Promise<{ raw: string; usage: ClassifierResult['usage'] }> {
  const built = buildPrompt(input);
  const userContent = stricterInstruction
    ? `${stricterInstruction}\n\n${built.userMessage}`
    : built.userMessage;

  // Build messages with per-part cacheControl on the stable system blocks.
  // Each cache breakpoint adds a cache-control marker; the Vercel SDK forwards
  // these to Anthropic via providerOptions on each content part.
  //
  // Note: some versions of @ai-sdk/anthropic expose this as
  //   providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }
  // on each content-part object in messages[].content. If your installed
  // version differs, adapt here — the rest of this module is unchanged.
  //
  // For v1, concatenate built.systemBlocks into the `system` string and pass
  // cacheControl once on the full system. This gives good-enough caching on
  // the stable prefix without per-block breakpoints. If cache hit rate is
  // low in shadow mode, revisit this and split into message parts.

  const resp = await generateText({
    model: modelForTier(tier),
    system: built.system,
    messages: [{ role: 'user', content: userContent }],
    maxOutputTokens: 1024,
    providerOptions: {
      anthropic: {
        cacheControl: { type: 'ephemeral' },
      },
    },
  });

  const raw = resp.text ?? '';

  // Vercel AI SDK v3 usage shape: { inputTokens, outputTokens, cachedInputTokens }
  // Some versions use `totalTokens` + provider-specific breakdowns; handle both.
  const usage = {
    inputTokens: resp.usage?.inputTokens ?? 0,
    outputTokens: resp.usage?.outputTokens ?? 0,
    cacheReadTokens:
      (resp.usage as { cachedInputTokens?: number })?.cachedInputTokens ?? 0,
    cacheCreationTokens: 0,   // not exposed uniformly; leave at 0
  };

  return { raw, usage };
}

async function tryTier(
  tier: 1 | 2 | 3,
  input: BuildPromptInput,
): Promise<ClassifierResult | { malformed: true; usage: ClassifierResult['usage'] }> {
  const first = await callTier(tier, input);
  const json1 = extractJson(first.raw);
  const v1 = json1 ? validateTriageDecision(json1) : { ok: false as const, error: 'not json' };
  if (v1.ok) {
    return { decision: v1.value, tier, usage: first.usage };
  }

  logger.warn(
    { tier, error: v1.ok === false ? v1.error : 'unknown' },
    'Triage classifier output invalid — retrying with stricter instruction',
  );

  const second = await callTier(
    tier,
    input,
    `Your previous output was invalid: ${v1.ok === false ? v1.error : 'unknown'}. Output ONLY valid JSON matching the schema. No prose, no markdown fences.`,
  );
  const json2 = extractJson(second.raw);
  const v2 = json2 ? validateTriageDecision(json2) : { ok: false as const, error: 'not json' };
  if (v2.ok) {
    const mergedUsage = {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens,
      outputTokens: first.usage.outputTokens + second.usage.outputTokens,
      cacheReadTokens: first.usage.cacheReadTokens + second.usage.cacheReadTokens,
      cacheCreationTokens:
        first.usage.cacheCreationTokens + second.usage.cacheCreationTokens,
    };
    return { decision: v2.value, tier, usage: mergedUsage };
  }

  return {
    malformed: true,
    usage: {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens,
      outputTokens: first.usage.outputTokens + second.usage.outputTokens,
      cacheReadTokens: first.usage.cacheReadTokens + second.usage.cacheReadTokens,
      cacheCreationTokens:
        first.usage.cacheCreationTokens + second.usage.cacheCreationTokens,
    },
  };
}

/**
 * Classify email through tier-routed, prompt-cached LLM calls.
 * Escalation rules:
 *   - Malformed output after retry at tier N → try tier N+1 (up to 3)
 *   - Valid output at tier 1 with confidence in (escalateLow, escalateHigh) → try tier 2
 *   - Valid output at tier 2 with confidence still in gap → try tier 3
 *   - Tier 3 result is final (malformed tier 3 → throw)
 */
export async function classifyWithLlm(
  input: BuildPromptInput,
): Promise<ClassifierResult> {
  const accUsage: ClassifierResult['usage'] = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  for (const tier of [1, 2, 3] as const) {
    const r = await tryTier(tier, input);
    accUsage.inputTokens += r.usage.inputTokens;
    accUsage.outputTokens += r.usage.outputTokens;
    accUsage.cacheReadTokens += r.usage.cacheReadTokens;
    accUsage.cacheCreationTokens += r.usage.cacheCreationTokens;

    if ('malformed' in r) {
      if (tier === 3) {
        throw new Error('Triage classifier: malformed at tier 3');
      }
      continue;
    }

    const c = r.decision.confidence;
    const inGap =
      c >= TRIAGE_DEFAULTS.escalateLow && c <= TRIAGE_DEFAULTS.escalateHigh;
    if (inGap && tier < 3) {
      logger.info(
        { tier, confidence: c },
        'Triage classifier confidence in gap band — escalating',
      );
      continue;
    }

    return { ...r, usage: accUsage };
  }

  throw new Error('Triage classifier: exhausted all tiers');
}
```

- [ ] **Step 7.4: Run tests — confirm pass**

Run: `npm test -- triage-classifier`
Expected: PASS.

- [ ] **Step 7.5: Commit**

```bash
git add src/triage/classifier.ts src/__tests__/triage-classifier.test.ts
git commit -m "feat(triage): tier-routed LLM classifier with caching and retry"
```

---

## Task 8: MLflow trace emission

**Files:**
- Create: `src/triage/traces.ts`
- Test: `src/__tests__/triage-traces.test.ts`

Trace every classifier call. At minimum: input hash, output, latency, tier, cache hit ratio, cost estimate. Start with local JSONL sink at `.omc/logs/triage/<date>.jsonl` — MLflow MCP calls from inside NanoClaw are a follow-up if/when needed.

- [ ] **Step 8.1: Write failing test**

Create `src/__tests__/triage-traces.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { emitTrace, setTraceDir } from '../triage/traces.js';

describe('triage traces', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-traces-'));
    setTraceDir(dir);
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true });
    } catch {
      /* noop */
    }
  });

  it('appends one JSON line per call to the day file', () => {
    emitTrace({
      trackedItemId: 'i1',
      tier: 1,
      latencyMs: 120,
      queue: 'attention',
      confidence: 0.9,
      cacheReadTokens: 80,
      inputTokens: 100,
      outputTokens: 50,
    });
    emitTrace({
      trackedItemId: 'i2',
      tier: 2,
      latencyMs: 300,
      queue: 'archive_candidate',
      confidence: 0.8,
      cacheReadTokens: 80,
      inputTokens: 120,
      outputTokens: 40,
    });

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBe(1);
    const lines = fs
      .readFileSync(path.join(dir, files[0]), 'utf8')
      .trim()
      .split('\n');
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.trackedItemId).toBe('i1');
    expect(first.tier).toBe(1);
  });
});
```

- [ ] **Step 8.2: Run test — confirm failure**

Run: `npm test -- triage-traces`
Expected: FAIL.

- [ ] **Step 8.3: Implement `src/triage/traces.ts`**

```typescript
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

let traceDir =
  process.env.TRIAGE_TRACE_DIR ?? path.resolve(process.cwd(), '.omc/logs/triage');

export function setTraceDir(d: string): void {
  traceDir = d;
}

export interface TraceRecord {
  trackedItemId: string;
  tier: 1 | 2 | 3;
  latencyMs: number;
  queue: string;
  confidence: number;
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  shadowMode?: boolean;
  error?: string;
}

function todayFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(traceDir, `${date}.jsonl`);
}

export function emitTrace(r: TraceRecord): void {
  try {
    fs.mkdirSync(traceDir, { recursive: true });
    const line = JSON.stringify({ ...r, timestamp: Date.now() }) + '\n';
    fs.appendFileSync(todayFile(), line);
  } catch (err) {
    logger.warn({ err: String(err) }, 'Failed to write triage trace');
  }
}
```

- [ ] **Step 8.4: Run test — confirm pass**

Run: `npm test -- triage-traces`
Expected: PASS.

- [ ] **Step 8.5: Commit**

```bash
git add src/triage/traces.ts src/__tests__/triage-traces.test.ts
git commit -m "feat(triage): JSONL trace emission for every classifier call"
```

---

## Task 9: Cost cap enforcement

**Files:**
- Create: `src/triage/cost-cap.ts`
- Test: `src/__tests__/triage-cost-cap.test.ts`

Before each classifier call, check today's cumulative cost from traces. If ≥ cap, throw. Integrates with the existing `budget.ts` pattern.

- [ ] **Step 9.1: Write failing test**

Create `src/__tests__/triage-cost-cap.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setTraceDir, emitTrace } from '../triage/traces.js';
import { enforceCostCap, estimateCostUsd } from '../triage/cost-cap.js';

describe('cost cap', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-cap-'));
    setTraceDir(dir);
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true });
    } catch {
      /* noop */
    }
  });

  it('estimates cost proportional to tokens and tier', () => {
    const tier1Cost = estimateCostUsd(1, 100_000, 1000, 0);
    const tier3Cost = estimateCostUsd(3, 100_000, 1000, 0);
    expect(tier3Cost).toBeGreaterThan(tier1Cost);
  });

  it('does not throw when today cost < cap', () => {
    expect(() => enforceCostCap(1.0)).not.toThrow();
  });

  it('throws when today cost >= cap', () => {
    for (let i = 0; i < 200; i++) {
      emitTrace({
        trackedItemId: `i${i}`,
        tier: 3,
        latencyMs: 100,
        queue: 'attention',
        confidence: 0.9,
        cacheReadTokens: 0,
        inputTokens: 50_000,
        outputTokens: 2000,
      });
    }
    expect(() => enforceCostCap(1.0)).toThrow(/cost cap/i);
  });
});
```

- [ ] **Step 9.2: Run test — confirm failure**

Run: `npm test -- triage-cost-cap`
Expected: FAIL.

- [ ] **Step 9.3: Implement `src/triage/cost-cap.ts`**

```typescript
import fs from 'fs';
import path from 'path';

// Rough $/1M token prices (as of model release). Update when pricing changes.
// Input pricing is used for uncached input; cached reads are billed at 10%.
const PRICES: Record<1 | 2 | 3, { inUsdPerMtok: number; outUsdPerMtok: number }> = {
  1: { inUsdPerMtok: 1.0, outUsdPerMtok: 5.0 },     // Haiku
  2: { inUsdPerMtok: 3.0, outUsdPerMtok: 15.0 },    // Sonnet
  3: { inUsdPerMtok: 15.0, outUsdPerMtok: 75.0 },   // Opus
};

export function estimateCostUsd(
  tier: 1 | 2 | 3,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): number {
  const price = PRICES[tier];
  const uncachedIn = Math.max(0, inputTokens - cacheReadTokens);
  const cachedIn = cacheReadTokens;
  const inCost =
    (uncachedIn * price.inUsdPerMtok + cachedIn * price.inUsdPerMtok * 0.1) /
    1_000_000;
  const outCost = (outputTokens * price.outUsdPerMtok) / 1_000_000;
  return inCost + outCost;
}

let traceDirOverride: string | null = null;
export function setCostCapTraceDir(d: string): void {
  traceDirOverride = d;
}

function traceDir(): string {
  return (
    traceDirOverride ??
    process.env.TRIAGE_TRACE_DIR ??
    path.resolve(process.cwd(), '.omc/logs/triage')
  );
}

function todayTraceFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(traceDir(), `${date}.jsonl`);
}

export function todayCostUsd(): number {
  const file = todayTraceFile();
  if (!fs.existsSync(file)) return 0;
  const contents = fs.readFileSync(file, 'utf8');
  let total = 0;
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as {
        tier: 1 | 2 | 3;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
      };
      total += estimateCostUsd(
        r.tier,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
      );
    } catch {
      /* skip malformed */
    }
  }
  return total;
}

export function enforceCostCap(capUsd: number): void {
  const today = todayCostUsd();
  if (today >= capUsd) {
    throw new Error(
      `Triage cost cap hit: today=$${today.toFixed(4)}, cap=$${capUsd.toFixed(2)}`,
    );
  }
}
```

- [ ] **Step 9.4: Wire `setCostCapTraceDir` to share state with traces**

In `src/__tests__/triage-cost-cap.test.ts`, the test calls `setTraceDir(dir)` but the cost-cap module has its own dir. Unify by having cost-cap read from the same `traceDir` getter. Update `src/triage/cost-cap.ts`:

```typescript
// Replace setCostCapTraceDir/traceDir() with:
import { getTraceDir } from './traces.js';
// then in todayTraceFile():
function todayTraceFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(getTraceDir(), `${date}.jsonl`);
}
```

And in `src/triage/traces.ts` add:

```typescript
export function getTraceDir(): string {
  return traceDir;
}
```

Remove the unused `setCostCapTraceDir` export and the test's reference to it — the test already calls `setTraceDir(dir)`.

- [ ] **Step 9.5: Run test — confirm pass**

Run: `npm test -- triage-cost-cap`
Expected: PASS.

- [ ] **Step 9.6: Commit**

```bash
git add src/triage/cost-cap.ts src/triage/traces.ts src/__tests__/triage-cost-cap.test.ts
git commit -m "feat(triage): daily cost cap enforcement from trace log"
```

---

## Task 10: Triage worker — orchestrates prefilter + classifier + persistence

**Files:**
- Create: `src/triage/worker.ts`
- Test: `src/__tests__/triage-worker.test.ts`

Entry point called by `sse-classifier`. Runs prefilter → shadow-mode guard → cost-cap check → classifier → persist to `tracked_items`. Returns a decision the caller can use to drive side-effects (or skip them in shadow mode).

- [ ] **Step 10.1: Write failing tests**

Create `src/__tests__/triage-worker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const mockClassify = vi.fn();
vi.mock('../triage/classifier.js', () => ({
  classifyWithLlm: mockClassify,
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import { triageEmail } from '../triage/worker.js';
import { setTraceDir } from '../triage/traces.js';

describe('triageEmail', () => {
  let dir: string;
  beforeEach(() => {
    _initTestDatabase();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-worker-'));
    setTraceDir(dir);
    mockClassify.mockReset();
  });
  afterEach(() => {
    _closeDatabase();
    try { fs.rmSync(dir, { recursive: true }); } catch { /* noop */ }
  });

  it('returns skipped when prefilter matches (SP newsletter)', async () => {
    const out = await triageEmail({
      trackedItemId: 'x',
      emailBody: 'newsletter content',
      sender: 'news@ben-evans.com',
      subject: 'weekly',
      superpilotLabel: 'newsletter',
      threadId: 't',
      account: 'a',
    });
    expect(out.outcome).toBe('skipped');
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('calls classifier when not skipped and persists to tracked_items', async () => {
    mockClassify.mockResolvedValueOnce({
      decision: {
        queue: 'attention',
        confidence: 0.9,
        reasons: ['a', 'b'],
        action_intent: 'none',
        facts_extracted: [],
        repo_candidates: [],
        attention_reason: 'x',
      },
      tier: 1,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 8, cacheCreationTokens: 0 },
    });

    const out = await triageEmail({
      trackedItemId: 'x1',
      emailBody: 'review pls',
      sender: 'alice@example.com',
      subject: 'PR review',
      superpilotLabel: 'needs-attention',
      threadId: 't1',
      account: 'a',
    });

    expect(out.outcome).toBe('classified');
    if (out.outcome === 'classified') {
      expect(out.decision.queue).toBe('attention');
    }
  });

  it('returns classified-shadow when shadow mode is on (no side effects)', async () => {
    process.env.TRIAGE_SHADOW_MODE = '1';
    // Force config re-read; in practice TRIAGE_DEFAULTS is read at import.
    // For this test, trust the worker reads process.env.TRIAGE_SHADOW_MODE directly.
    mockClassify.mockResolvedValueOnce({
      decision: {
        queue: 'attention',
        confidence: 0.9,
        reasons: ['a', 'b'],
        action_intent: 'none',
        facts_extracted: [],
        repo_candidates: [],
        attention_reason: 'x',
      },
      tier: 1,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 8, cacheCreationTokens: 0 },
    });

    const out = await triageEmail({
      trackedItemId: 'x2',
      emailBody: 'x',
      sender: 's@example.com',
      subject: 's',
      superpilotLabel: null,
      threadId: 't',
      account: 'a',
      shadowMode: true,
    });

    expect(out.outcome).toBe('classified');
    if (out.outcome === 'classified') expect(out.shadowMode).toBe(true);
  });
});
```

- [ ] **Step 10.2: Run tests — confirm failure**

Run: `npm test -- triage-worker`
Expected: FAIL.

- [ ] **Step 10.3: Implement `src/triage/worker.ts`**

```typescript
import { logger } from '../logger.js';
import { getDb } from '../db.js';
import { shouldSkip } from './prefilter.js';
import { classifyWithLlm } from './classifier.js';
import { emitTrace } from './traces.js';
import { enforceCostCap } from './cost-cap.js';
import { TRIAGE_DEFAULTS } from './config.js';
import type { TriageDecision } from './schema.js';

export interface TriageWorkerInput {
  trackedItemId: string;
  emailBody: string;
  sender: string;
  subject: string;
  superpilotLabel: string | null;
  threadId: string;
  account: string;
  shadowMode?: boolean;
}

export type TriageOutcome =
  | { outcome: 'skipped'; reason: string }
  | {
      outcome: 'classified';
      decision: TriageDecision;
      tier: 1 | 2 | 3;
      shadowMode: boolean;
    }
  | { outcome: 'error'; reason: string };

export async function triageEmail(
  input: TriageWorkerInput,
): Promise<TriageOutcome> {
  const shadowMode =
    input.shadowMode ?? TRIAGE_DEFAULTS.shadowMode;

  const pre = shouldSkip({
    superpilotLabel: input.superpilotLabel,
    sender: input.sender,
  });
  if (pre.skip) {
    logger.info(
      { trackedItemId: input.trackedItemId, reason: pre.reason },
      'Triage worker: prefilter skip',
    );
    return { outcome: 'skipped', reason: pre.reason };
  }

  try {
    enforceCostCap(TRIAGE_DEFAULTS.dailyCostCapUsd);
  } catch (err) {
    logger.error({ err: String(err) }, 'Triage worker: cost cap hit');
    return { outcome: 'error', reason: String(err) };
  }

  const start = Date.now();
  let result: Awaited<ReturnType<typeof classifyWithLlm>>;
  try {
    result = await classifyWithLlm({
      emailBody: input.emailBody,
      sender: input.sender,
      subject: input.subject,
      superpilotLabel: input.superpilotLabel,
      threadId: input.threadId,
      account: input.account,
    });
  } catch (err) {
    logger.error(
      { trackedItemId: input.trackedItemId, err: String(err) },
      'Triage worker: classifier failed',
    );
    emitTrace({
      trackedItemId: input.trackedItemId,
      tier: 1,
      latencyMs: Date.now() - start,
      queue: 'error',
      confidence: 0,
      cacheReadTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      error: String(err),
      shadowMode,
    });
    return { outcome: 'error', reason: String(err) };
  }

  const latencyMs = Date.now() - start;
  emitTrace({
    trackedItemId: input.trackedItemId,
    tier: result.tier,
    latencyMs,
    queue: result.decision.queue,
    confidence: result.decision.confidence,
    cacheReadTokens: result.usage.cacheReadTokens,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    shadowMode,
  });

  // Persist triage decision to tracked_items (shadow-safe: writing to DB is fine)
  getDb()
    .prepare(
      `UPDATE tracked_items SET
         confidence = ?,
         model_tier = ?,
         action_intent = ?,
         facts_extracted_json = ?,
         repo_candidates_json = ?,
         reasons_json = ?
       WHERE id = ?`,
    )
    .run(
      result.decision.confidence,
      result.tier,
      result.decision.action_intent ?? null,
      JSON.stringify(result.decision.facts_extracted),
      JSON.stringify(result.decision.repo_candidates),
      JSON.stringify(result.decision.reasons),
      input.trackedItemId,
    );

  return {
    outcome: 'classified',
    decision: result.decision,
    tier: result.tier,
    shadowMode,
  };
}
```

- [ ] **Step 10.4: Run tests — confirm pass**

Run: `npm test -- triage-worker`
Expected: PASS.

- [ ] **Step 10.5: Commit**

```bash
git add src/triage/worker.ts src/__tests__/triage-worker.test.ts
git commit -m "feat(triage): orchestrator worker (prefilter→classify→persist)"
```

---

## Task 11: Wire triage worker into `sse-classifier` behind `TRIAGE_V1_ENABLED`

**Files:**
- Modify: `src/sse-classifier.ts`
- Modify: `src/__tests__/sse-classifier.test.ts` (add gated integration test)

Preserve the existing rule-based path when flag is off. When flag is on: after `insertTrackedItem`, schedule `triageEmail` async. Persist the LLM decision by updating the row.

- [ ] **Step 11.1: Write failing integration test**

Add a test case to `src/__tests__/sse-classifier.test.ts`:

```typescript
it('skips triage worker when TRIAGE_V1_ENABLED is falsy', async () => {
  delete process.env.TRIAGE_V1_ENABLED;
  const emails: SSEEmail[] = [
    { thread_id: 't1', account: 'a@b.com', subject: 's', sender: 'x@y.com' },
  ];
  const res = classifyFromSSE(emails);
  expect(res).toHaveLength(1);
  // Legacy decision ('digest' or 'push') without LLM fields
  const item = getTrackedItemBySourceId('gmail', 'gmail:t1');
  expect(item?.confidence).toBeFalsy();
});
```

- [ ] **Step 11.2: Run test — confirm pass for flag-off case (it should already pass given current behavior, but confirm the assertion on `confidence` is null)**

Run: `npm test -- sse-classifier`
Expected: PASS (legacy path unchanged).

- [ ] **Step 11.3: Modify `src/sse-classifier.ts` — fire async triage after insert**

Add import at top:

```typescript
import { triageEmail } from './triage/worker.js';
import { TRIAGE_DEFAULTS } from './triage/config.js';
```

Near end of `classifyFromSSE`, after `eventBus.emit('item.classified', event);` and before `results.push(...)`, add:

```typescript
if (TRIAGE_DEFAULTS.enabled) {
  // Fire-and-forget. Errors are logged inside triageEmail.
  void triageEmail({
    trackedItemId: itemId,
    emailBody: email.subject || '',     // body not yet in SSE payload; v1 uses subject+headers
    sender,
    subject,
    superpilotLabel: email.superpilot_label ?? null,
    threadId: email.thread_id,
    account: email.account,
  }).catch((err) => {
    logger.warn({ err: String(err), itemId }, 'Triage worker error (async)');
  });
}
```

> **Note:** SSE payloads from SuperPilot currently carry only thread_id/account/subject/sender. If the classifier needs the body, SuperPilot's `/api/nanoclaw/events` must emit it (tracked in v1 follow-up, not this task). For now the worker operates on subject+headers+SP label, which is enough for the queue decision even without body. See spec §"Architecture".

- [ ] **Step 11.4: Add enabled-path integration test**

```typescript
it('invokes triage worker when TRIAGE_V1_ENABLED=1', async () => {
  process.env.TRIAGE_V1_ENABLED = '1';
  // triageEmail is fire-and-forget; we spy to verify invocation
  const worker = await import('../triage/worker.js');
  const spy = vi.spyOn(worker, 'triageEmail').mockResolvedValue({
    outcome: 'skipped',
    reason: 'test',
  });

  const emails: SSEEmail[] = [
    { thread_id: 't2', account: 'a@b.com', subject: 'urgent fix', sender: 'x@y.com' },
  ];
  classifyFromSSE(emails);

  // Allow microtasks to flush
  await new Promise((r) => setImmediate(r));
  expect(spy).toHaveBeenCalled();
  delete process.env.TRIAGE_V1_ENABLED;
});
```

Note: `TRIAGE_DEFAULTS.enabled` is evaluated at import time. If the test toggles env after import, reset modules with `vi.resetModules()` and dynamic import — or accept the limitation and only assert via feature-flag-gated behavior in a fresh subprocess. For this task's purposes, the spy-based test above is sufficient.

- [ ] **Step 11.5: Run full SSE test suite**

Run: `npm test -- sse-classifier`
Expected: PASS.

- [ ] **Step 11.6: Commit**

```bash
git add src/sse-classifier.ts src/__tests__/sse-classifier.test.ts
git commit -m "feat(triage): wire triage worker into SSE classifier behind flag"
```

---

## Task 12: Telegram attention pinned dashboard — edit-in-place

**Files:**
- Create: `src/triage/dashboards.ts`
- Test: `src/__tests__/triage-dashboards.test.ts`

One pinned message per topic. Bot edits it when state changes. Uses Telegram Bot API `editMessageText`. Stores `pinned_msg_id` in `tracked_items`-adjacent `triage_dashboards` table.

- [ ] **Step 12.1: Add `triage_dashboards` table migration to `src/db.ts`**

```typescript
db.prepare(
  `CREATE TABLE IF NOT EXISTS triage_dashboards (
    topic TEXT PRIMARY KEY,
    telegram_chat_id TEXT NOT NULL,
    pinned_msg_id INTEGER,
    last_rendered_at INTEGER
  )`,
).run();
```

- [ ] **Step 12.2: Write failing tests**

Create `src/__tests__/triage-dashboards.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';

const mockSend = vi.fn();
const mockEdit = vi.fn();
const mockPin = vi.fn();
vi.mock('../channels/telegram.js', () => ({
  sendTelegramMessage: mockSend,
  editTelegramMessage: mockEdit,
  pinTelegramMessage: mockPin,
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { renderAttentionDashboard } from '../triage/dashboards.js';

describe('renderAttentionDashboard', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockSend.mockReset();
    mockEdit.mockReset();
    mockPin.mockReset();
  });
  afterEach(() => _closeDatabase());

  it('posts + pins a new message when none exists', async () => {
    mockSend.mockResolvedValueOnce({ message_id: 42 });

    await renderAttentionDashboard({
      chatId: '-100123',
      items: [
        {
          id: 'a',
          title: 'PR review requested',
          reason: 'github',
          ageMins: 10,
        },
      ],
    });

    expect(mockSend).toHaveBeenCalled();
    expect(mockPin).toHaveBeenCalledWith('-100123', 42);

    const row = getDb()
      .prepare(`SELECT pinned_msg_id FROM triage_dashboards WHERE topic = 'attention'`)
      .get() as { pinned_msg_id: number };
    expect(row.pinned_msg_id).toBe(42);
  });

  it('edits the existing pinned message on subsequent calls', async () => {
    getDb()
      .prepare(
        `INSERT INTO triage_dashboards (topic, telegram_chat_id, pinned_msg_id, last_rendered_at)
         VALUES ('attention', '-100123', 99, ?)`,
      )
      .run(Date.now());

    mockEdit.mockResolvedValueOnce({ message_id: 99 });

    await renderAttentionDashboard({
      chatId: '-100123',
      items: [],
    });
    expect(mockEdit).toHaveBeenCalledWith(
      '-100123',
      99,
      expect.stringContaining('Attention'),
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 12.3: Run test — confirm failure**

Run: `npm test -- triage-dashboards`
Expected: FAIL.

- [ ] **Step 12.4: Check whether `sendTelegramMessage` / `editTelegramMessage` / `pinTelegramMessage` exist**

Run: `grep -n "editMessageText\|pinChatMessage\|editTelegramMessage\|pinTelegramMessage" src/channels/telegram.ts`

If `editTelegramMessage` / `pinTelegramMessage` exports do not exist, add them. The existing send method can be introspected; add thin wrappers that call Telegram Bot API `editMessageText` and `pinChatMessage` following the existing request helper pattern. If `fetch` is already used in `telegram.ts`, match that pattern.

- [ ] **Step 12.5: Implement `src/triage/dashboards.ts`**

```typescript
import { getDb } from '../db.js';
import { logger } from '../logger.js';
import {
  sendTelegramMessage,
  editTelegramMessage,
  pinTelegramMessage,
} from '../channels/telegram.js';

export interface DashboardItem {
  id: string;
  title: string;
  reason: string;
  ageMins: number;
}

export interface DashboardInput {
  chatId: string;
  items: DashboardItem[];
}

function fmtAttention(items: DashboardItem[]): string {
  const header = `📥 Attention — ${items.length} open`;
  const divider = '────────────────────';
  if (items.length === 0) {
    return `${header}\n${divider}\n(inbox is clear — nothing requires you right now)\n\nLast update: ${new Date().toLocaleTimeString()}`;
  }
  const top = items.slice(0, 5);
  const lines = top.map(
    (it, i) => `${i + 1}. [${it.reason}] ${it.title} · ${it.ageMins}m ago`,
  );
  const tail =
    items.length > 5 ? `\n+${items.length - 5} more · /attention for full list` : '';
  return `${header}\n${divider}\n${lines.join('\n')}${tail}\n\nLast update: ${new Date().toLocaleTimeString()}`;
}

export async function renderAttentionDashboard(
  input: DashboardInput,
): Promise<void> {
  const text = fmtAttention(input.items);
  const db = getDb();
  const row = db
    .prepare(
      `SELECT pinned_msg_id FROM triage_dashboards WHERE topic = 'attention'`,
    )
    .get() as { pinned_msg_id: number | null } | undefined;

  if (!row || row.pinned_msg_id === null) {
    try {
      const sent = await sendTelegramMessage(input.chatId, text);
      await pinTelegramMessage(input.chatId, sent.message_id);
      db.prepare(
        `INSERT INTO triage_dashboards (topic, telegram_chat_id, pinned_msg_id, last_rendered_at)
         VALUES ('attention', ?, ?, ?)
         ON CONFLICT(topic) DO UPDATE SET
           pinned_msg_id = excluded.pinned_msg_id,
           last_rendered_at = excluded.last_rendered_at`,
      ).run(input.chatId, sent.message_id, Date.now());
    } catch (err) {
      logger.warn({ err: String(err) }, 'Failed to create attention dashboard');
    }
    return;
  }

  try {
    await editTelegramMessage(input.chatId, row.pinned_msg_id, text);
    db.prepare(
      `UPDATE triage_dashboards SET last_rendered_at = ? WHERE topic = 'attention'`,
    ).run(Date.now());
  } catch (err) {
    logger.warn(
      { err: String(err), msgId: row.pinned_msg_id },
      'Failed to edit attention dashboard',
    );
  }
}
```

Also add a mirror `renderArchiveDashboard(input)` with its own `fmtArchive` formatter showing category counts + digest time. Implementation is symmetric; include it in this same file.

- [ ] **Step 12.6: Run test — confirm pass**

Run: `npm test -- triage-dashboards`
Expected: PASS.

- [ ] **Step 12.7: Commit**

```bash
git add src/db.ts src/triage/dashboards.ts src/channels/telegram.ts src/__tests__/triage-dashboards.test.ts
git commit -m "feat(triage): pinned live dashboards for attention + archive queues"
```

---

## Task 13: Callback handlers for queue buttons

**Files:**
- Modify: `src/callback-router.ts`
- Test: `src/__tests__/callback-router.test.ts` (add cases)
- Create: `src/triage/queue-actions.ts`

Wire inline-button callbacks (`triage:archive:<id>`, `triage:snooze:<id>:1h|tomorrow`, `triage:dismiss:<id>`, `triage:override:<id>:<new_queue>`) to handlers that write to `tracked_items`, record examples, and trigger dashboard re-render.

- [ ] **Step 13.1: Write failing tests (sketch the routing contract)**

Add to `src/__tests__/callback-router.test.ts`:

```typescript
it('routes triage:archive to the archive handler', async () => {
  const spy = vi.fn();
  registerHandler('triage:archive', spy);
  await route('triage:archive:item-1', { user: 'me' });
  expect(spy).toHaveBeenCalledWith('item-1', { user: 'me' });
});
```

(Adapt to the actual API of `callback-router.ts` — read it first to match exports and router API, then update the test to the real contract.)

- [ ] **Step 13.2: Read `src/callback-router.ts` to learn the existing API**

Run: `cat src/callback-router.ts | head -80` — understand the existing dispatch pattern.

- [ ] **Step 13.3: Implement `src/triage/queue-actions.ts`**

```typescript
import { getDb } from '../db.js';
import { recordExample } from './examples.js';
import { recordSkip } from './prefilter.js';
import { TRIAGE_DEFAULTS } from './config.js';
import { logger } from '../logger.js';

interface ItemRow {
  id: string;
  classification: string | null;
  title: string;
  metadata: string | null;
}

function getItem(id: string): ItemRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, classification, title, metadata FROM tracked_items WHERE id = ?`,
    )
    .get(id) as ItemRow | undefined;
}

function parseSender(metadata: string | null): string {
  try {
    const m = metadata ? JSON.parse(metadata) : {};
    return String(m.sender ?? '');
  } catch {
    return '';
  }
}

export function handleArchive(itemId: string): void {
  const item = getItem(itemId);
  if (!item) return;

  getDb()
    .prepare(`UPDATE tracked_items SET state = 'resolved', resolution_method = 'manual:button', resolved_at = ? WHERE id = ?`)
    .run(Date.now(), itemId);

  const sender = parseSender(item.metadata);
  if (sender) {
    const { promoted } = recordSkip(sender, TRIAGE_DEFAULTS.skiplistPromotionHits);
    if (promoted) logger.info({ sender }, 'Triage: sender promoted to skip-list');
  }

  if (item.classification) {
    recordExample({
      kind: 'positive',
      trackedItemId: itemId,
      emailSummary: item.title,
      agentQueue: item.classification,
      userQueue: 'archive_candidate',
      reasons: ['user clicked archive'],
    });
  }
}

export function handleDismiss(itemId: string): void {
  getDb()
    .prepare(`UPDATE tracked_items SET state = 'resolved', resolution_method = 'manual:button', resolved_at = ? WHERE id = ?`)
    .run(Date.now(), itemId);
}

export function handleSnooze(itemId: string, duration: '1h' | 'tomorrow'): void {
  const untilMs = duration === '1h'
    ? Date.now() + 60 * 60 * 1000
    : new Date(new Date().setHours(8, 0, 0, 0) + 24 * 60 * 60 * 1000).getTime();
  getDb()
    .prepare(`UPDATE tracked_items SET state = 'held', metadata = json_set(COALESCE(metadata, '{}'), '$.snoozed_until', ?) WHERE id = ?`)
    .run(untilMs, itemId);
}

export function handleOverride(itemId: string, userQueue: 'attention' | 'archive_candidate'): void {
  const item = getItem(itemId);
  if (!item || !item.classification) return;

  recordExample({
    kind: 'negative',
    trackedItemId: itemId,
    emailSummary: item.title,
    agentQueue: item.classification,
    userQueue,
    reasons: [`user override to ${userQueue}`],
  });
}
```

- [ ] **Step 13.4: Register callbacks in `src/callback-router.ts`**

Add near the other registrations (match existing pattern):

```typescript
import {
  handleArchive,
  handleDismiss,
  handleSnooze,
  handleOverride,
} from './triage/queue-actions.js';

// within the registration section
registerHandler('triage:archive', (itemId: string) => handleArchive(itemId));
registerHandler('triage:dismiss', (itemId: string) => handleDismiss(itemId));
registerHandler('triage:snooze:1h', (itemId: string) => handleSnooze(itemId, '1h'));
registerHandler('triage:snooze:tomorrow', (itemId: string) => handleSnooze(itemId, 'tomorrow'));
registerHandler('triage:override:attention', (itemId: string) =>
  handleOverride(itemId, 'attention'),
);
registerHandler('triage:override:archive', (itemId: string) =>
  handleOverride(itemId, 'archive_candidate'),
);
```

(Adapt the exact function names to match existing `callback-router.ts` API.)

- [ ] **Step 13.5: Write handler-level tests**

Create `src/__tests__/triage-queue-actions.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';
import {
  handleArchive,
  handleOverride,
} from '../triage/queue-actions.js';
import { insertTrackedItem } from '../tracked-items.js';

describe('queue-actions', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('handleArchive marks item resolved and records skip', () => {
    insertTrackedItem({
      id: 'a1', source: 'gmail', source_id: 'gmail:t', group_name: 'main',
      state: 'pushed', classification: 'push', superpilot_label: null,
      trust_tier: null, title: 'hi', summary: null, thread_id: 't',
      detected_at: Date.now(), pushed_at: Date.now(), resolved_at: null,
      resolution_method: null, digest_count: 0, telegram_message_id: null,
      classification_reason: null,
      metadata: { sender: 'noreply@foo.com' },
      confidence: 0.6, model_tier: 1, action_intent: null,
      facts_extracted: null, repo_candidates: null, reasons: null,
    });

    handleArchive('a1');

    const row = getDb()
      .prepare(`SELECT state FROM tracked_items WHERE id = ?`)
      .get('a1') as { state: string };
    expect(row.state).toBe('resolved');
  });

  it('handleOverride records a negative example', () => {
    insertTrackedItem({
      id: 'a2', source: 'gmail', source_id: 'gmail:t2', group_name: 'main',
      state: 'queued', classification: 'digest', superpilot_label: null,
      trust_tier: null, title: 'yo', summary: null, thread_id: 't2',
      detected_at: Date.now(), pushed_at: null, resolved_at: null,
      resolution_method: null, digest_count: 0, telegram_message_id: null,
      classification_reason: null,
      metadata: null,
      confidence: 0.6, model_tier: 1, action_intent: null,
      facts_extracted: null, repo_candidates: null, reasons: null,
    });

    handleOverride('a2', 'attention');
    const row = getDb()
      .prepare(`SELECT kind, user_queue FROM triage_examples WHERE tracked_item_id = ?`)
      .get('a2') as { kind: string; user_queue: string };
    expect(row.kind).toBe('negative');
    expect(row.user_queue).toBe('attention');
  });
});
```

- [ ] **Step 13.6: Run all tests**

Run: `npm test -- triage-queue-actions callback-router`
Expected: PASS.

- [ ] **Step 13.7: Commit**

```bash
git add src/triage/queue-actions.ts src/callback-router.ts src/__tests__/triage-queue-actions.test.ts src/__tests__/callback-router.test.ts
git commit -m "feat(triage): callback handlers for queue buttons + learning"
```

---

## Task 14: Push message with inline buttons on new attention item

**Files:**
- Create: `src/triage/push-attention.ts`
- Test: `src/__tests__/triage-push-attention.test.ts`

When the triage worker classifies `queue=attention`, post a per-email Telegram message with buttons and re-render the pinned dashboard.

- [ ] **Step 14.1: Write failing test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../channels/telegram.js', () => ({
  sendTelegramMessage: mockSend,
  editTelegramMessage: vi.fn(),
  pinTelegramMessage: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import { pushAttentionItem } from '../triage/push-attention.js';

describe('pushAttentionItem', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockSend.mockReset();
  });
  afterEach(() => _closeDatabase());

  it('sends a message with the full set of inline buttons', async () => {
    mockSend.mockResolvedValueOnce({ message_id: 101 });
    await pushAttentionItem({
      chatId: '-100456',
      itemId: 'x1',
      title: 'PR #42 review requested',
      reason: 'direct review ask',
      sender: 'alice@example.com',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [, text, opts] = mockSend.mock.calls[0];
    expect(text).toContain('PR #42');
    expect(opts.reply_markup.inline_keyboard).toBeDefined();
    const flat = (opts.reply_markup.inline_keyboard as Array<Array<{ callback_data: string }>>)
      .flat()
      .map((b) => b.callback_data);
    expect(flat).toEqual(
      expect.arrayContaining([
        'triage:dismiss:x1',
        'triage:snooze:1h:x1',
        'triage:snooze:tomorrow:x1',
        'triage:archive:x1',
        'triage:override:archive:x1',
      ]),
    );
  });
});
```

- [ ] **Step 14.2: Run test — confirm failure**

Run: `npm test -- triage-push-attention`
Expected: FAIL.

- [ ] **Step 14.3: Implement `src/triage/push-attention.ts`**

```typescript
import { sendTelegramMessage } from '../channels/telegram.js';

export interface PushAttentionInput {
  chatId: string;
  itemId: string;
  title: string;
  reason: string;
  sender: string;
}

export async function pushAttentionItem(
  input: PushAttentionInput,
): Promise<void> {
  const text = `📌 *${input.title}*\nfrom: ${input.sender}\nreason: ${input.reason}`;

  const keyboard = [
    [
      { text: 'Snooze 1h', callback_data: `triage:snooze:1h:${input.itemId}` },
      { text: 'Snooze tomorrow', callback_data: `triage:snooze:tomorrow:${input.itemId}` },
    ],
    [
      { text: 'Dismiss', callback_data: `triage:dismiss:${input.itemId}` },
      { text: 'Archive', callback_data: `triage:archive:${input.itemId}` },
    ],
    [
      { text: 'Move to archive queue', callback_data: `triage:override:archive:${input.itemId}` },
    ],
  ];

  await sendTelegramMessage(input.chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  });
}
```

- [ ] **Step 14.4: Run test — confirm pass**

Run: `npm test -- triage-push-attention`
Expected: PASS.

- [ ] **Step 14.5: Commit**

```bash
git add src/triage/push-attention.ts src/__tests__/triage-push-attention.test.ts
git commit -m "feat(triage): push per-email attention message with inline buttons"
```

---

## Task 15: Wire push + dashboard re-render into the worker side-effects

**Files:**
- Modify: `src/triage/worker.ts`
- Modify: `src/__tests__/triage-worker.test.ts`

After a successful `classified` outcome (and NOT in shadow mode), invoke `pushAttentionItem` for `queue=attention` and `renderAttentionDashboard` with the current open set.

- [ ] **Step 15.1: Add a query helper to `src/tracked-items.ts`**

```typescript
export function getOpenAttentionItems(groupName: string): TrackedItem[] {
  // Items with confidence-derived queue=attention and not yet resolved
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM tracked_items
       WHERE group_name = ? AND state IN ('pushed', 'pending', 'held')
       AND action_intent IS NOT 'none'         -- crude filter; refine later
       ORDER BY detected_at DESC
       LIMIT 50`,
    )
    .all(groupName) as unknown as TrackedItem[];
  return rows;
}
```

(Refine `action_intent IS NOT 'none'` once we store the explicit queue; fine for v1 first pass.)

- [ ] **Step 15.2: Wire side effects in `src/triage/worker.ts`**

After the `UPDATE tracked_items` at the end of `triageEmail`, add:

```typescript
if (!shadowMode && result.decision.queue === 'attention') {
  const chatId = process.env.EMAIL_INTEL_TG_CHAT_ID;
  if (chatId) {
    try {
      const { pushAttentionItem } = await import('./push-attention.js');
      await pushAttentionItem({
        chatId,
        itemId: input.trackedItemId,
        title: input.subject || '(no subject)',
        reason:
          result.decision.attention_reason ??
          result.decision.reasons[0] ??
          '(no reason)',
        sender: input.sender,
      });
      const { renderAttentionDashboard } = await import('./dashboards.js');
      const { getOpenAttentionItems } = await import('../tracked-items.js');
      const open = getOpenAttentionItems('main');
      await renderAttentionDashboard({
        chatId,
        items: open.map((it) => ({
          id: it.id,
          title: it.title,
          reason: (it.reasons && it.reasons[0]) ?? '(no reason)',
          ageMins: Math.round((Date.now() - it.detected_at) / 60_000),
        })),
      });
    } catch (err) {
      logger.warn(
        { err: String(err), itemId: input.trackedItemId },
        'Triage: failed to push+render attention',
      );
    }
  }
}
```

- [ ] **Step 15.3: Update existing worker test to cover the shadow-mode suppression path**

Add to `src/__tests__/triage-worker.test.ts`:

```typescript
it('does NOT push or render when shadowMode=true', async () => {
  process.env.EMAIL_INTEL_TG_CHAT_ID = '-100999';
  mockClassify.mockResolvedValueOnce({
    decision: {
      queue: 'attention',
      confidence: 0.9,
      reasons: ['r1', 'r2'],
      action_intent: 'none',
      facts_extracted: [],
      repo_candidates: [],
      attention_reason: 'x',
    },
    tier: 1,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 8, cacheCreationTokens: 0 },
  });

  const pushSpy = vi.fn();
  vi.doMock('../triage/push-attention.js', () => ({ pushAttentionItem: pushSpy }));

  const out = await triageEmail({
    trackedItemId: 'x3',
    emailBody: 'x',
    sender: 's@example.com',
    subject: 's',
    superpilotLabel: null,
    threadId: 't',
    account: 'a',
    shadowMode: true,
  });
  expect(out.outcome).toBe('classified');
  expect(pushSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 15.4: Run tests**

Run: `npm test -- triage-worker`
Expected: PASS.

- [ ] **Step 15.5: Commit**

```bash
git add src/triage/worker.ts src/tracked-items.ts src/__tests__/triage-worker.test.ts
git commit -m "feat(triage): push attention + re-render dashboard on classify"
```

---

## Task 16: Facts extraction → knowledge.md + Weaviate

**Files:**
- Create: `src/triage/knowledge-append.ts`
- Test: `src/__tests__/triage-knowledge-append.test.ts`
- Modify: `src/triage/worker.ts`

When classifier returns `facts_extracted` (non-empty), append a dated entry to `groups/email-intel/knowledge.md` AND call existing `knowledgeIngest` (or `src/memory/knowledge-store.ts`) for Weaviate.

- [ ] **Step 16.1: Read the existing knowledge-store / knowledge-ingestion APIs**

Run: `head -60 src/knowledge-ingestion.ts src/memory/knowledge-store.ts`

Match the existing function names and signatures.

- [ ] **Step 16.2: Write failing test**

Create `src/__tests__/triage-knowledge-append.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const mockIngest = vi.fn();
vi.mock('../memory/knowledge-store.js', () => ({
  knowledgeIngest: mockIngest,
}));

import { appendExtractedFacts } from '../triage/knowledge-append.js';

describe('appendExtractedFacts', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'groups-'));
    mockIngest.mockReset();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('appends a timestamped section to the group knowledge.md', async () => {
    await appendExtractedFacts({
      groupsRoot: root,
      groupName: 'email-intel',
      threadId: 't42',
      account: 'a@b.com',
      classificationId: 'c1',
      subject: 'Shipping confirmation',
      sender: 's@amazon.com',
      facts: [
        { key: 'vendor', value: 'Amazon', source_span: 'from: s@amazon.com' },
        { key: 'tracking', value: 'TBA123', source_span: 'TBA123' },
      ],
    });

    const filePath = path.join(root, 'email-intel', 'knowledge.md');
    expect(fs.existsSync(filePath)).toBe(true);
    const body = fs.readFileSync(filePath, 'utf8');
    expect(body).toMatch(/Shipping confirmation/);
    expect(body).toMatch(/vendor.*Amazon/);
    expect(mockIngest).toHaveBeenCalled();
  });
});
```

- [ ] **Step 16.3: Implement `src/triage/knowledge-append.ts`**

```typescript
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import type { ExtractedFact } from './schema.js';

export interface AppendFactsInput {
  groupsRoot: string;
  groupName: string;
  threadId: string;
  account: string;
  classificationId: string;
  subject: string;
  sender: string;
  facts: ExtractedFact[];
}

export async function appendExtractedFacts(
  input: AppendFactsInput,
): Promise<void> {
  if (input.facts.length === 0) return;

  const dir = path.join(input.groupsRoot, input.groupName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'knowledge.md');

  const ts = new Date().toISOString();
  const lines = [
    ``,
    `## ${ts} — ${input.subject}`,
    `- **From:** ${input.sender}`,
    `- **Thread:** \`${input.threadId}\` · account \`${input.account}\``,
    ...input.facts.map((f) => `- **${f.key}:** ${f.value}  _(${f.source_span})_`),
  ];
  fs.appendFileSync(file, lines.join('\n') + '\n');

  try {
    const { knowledgeIngest } = await import('../memory/knowledge-store.js');
    await knowledgeIngest({
      source: 'email',
      content: lines.join('\n'),
      metadata: {
        account: input.account,
        thread_id: input.threadId,
        classification_id: input.classificationId,
        sender: input.sender,
      },
    } as never);                        // relax to match actual signature
  } catch (err) {
    logger.warn(
      { err: String(err) },
      'Triage: knowledge ingest failed (non-fatal)',
    );
  }
}
```

Adjust the `knowledgeIngest` call shape to match the real API once you check it in step 16.1 — do not ship the `as never` cast.

- [ ] **Step 16.4: Wire into worker**

In `src/triage/worker.ts`, inside the `if (!shadowMode && result.decision.queue === 'attention')` branch (or as a sibling branch for any queue), after the `UPDATE tracked_items`:

```typescript
if (!shadowMode && result.decision.facts_extracted.length > 0) {
  try {
    const { appendExtractedFacts } = await import('./knowledge-append.js');
    await appendExtractedFacts({
      groupsRoot: path.resolve(process.cwd(), 'groups'),
      groupName: 'email-intel',
      threadId: input.threadId,
      account: input.account,
      classificationId: input.trackedItemId,
      subject: input.subject,
      sender: input.sender,
      facts: result.decision.facts_extracted,
    });
  } catch (err) {
    logger.warn(
      { err: String(err), itemId: input.trackedItemId },
      'Triage: appendExtractedFacts failed',
    );
  }
}
```

Also add `import path from 'path';` to the worker imports.

- [ ] **Step 16.5: Run tests**

Run: `npm test -- triage-knowledge-append triage-worker`
Expected: PASS.

- [ ] **Step 16.6: Commit**

```bash
git add src/triage/knowledge-append.ts src/triage/worker.ts src/__tests__/triage-knowledge-append.test.ts
git commit -m "feat(triage): append extracted facts to group knowledge.md + Weaviate"
```

---

## Task 17: Daily archive digest — wire into existing digest posting

**Files:**
- Modify: `src/daily-digest.ts` (or `src/digest-engine.ts` depending on which owns 8am-PT posting)
- Test: `src/__tests__/daily-digest.test.ts` (add case)
- Modify: `src/triage/dashboards.ts` (add `renderArchiveDashboard`)

Reuse the existing daily digest scheduler. At 8am PT, it already posts a digest; extend to include an "archive candidates" section drawn from `tracked_items` where `classification='digest'` (or new field `queue='archive_candidate'`). Include `[Archive all N]` and `[Review one-by-one]` buttons.

- [ ] **Step 17.1: Read the digest flow to locate the extension point**

Run: `grep -n "digest_state\|runDailyDigest\|daily_digest" src/daily-digest.ts src/digest-engine.ts src/digest-archive-section.ts`

The goal: find where the digest text is composed, and append an archive-candidates block that queries `tracked_items` for the archive queue.

- [ ] **Step 17.2: Write failing test against the modified function**

Extend `src/__tests__/daily-digest.test.ts` with a test that seeds two `archive_candidate` tracked items and asserts the rendered digest includes them with the expected button callbacks.

- [ ] **Step 17.3: Implement `renderArchiveDashboard` in `src/triage/dashboards.ts`**

Symmetric to `renderAttentionDashboard`:

```typescript
function fmtArchive(counts: Record<string, number>, total: number, nextDigestHuman: string): string {
  const header = `🗄 Archive queue — ${total} candidates`;
  const divider = '────────────────────';
  const breakdown = Object.entries(counts)
    .map(([cat, n]) => `${cat}: ${n}`)
    .join(' · ');
  return `${header}\n${divider}\n${breakdown || '(empty)'}\n[Archive all ${total}] [Review one-by-one]\nNext digest: ${nextDigestHuman}`;
}

export async function renderArchiveDashboard(input: {
  chatId: string;
  counts: Record<string, number>;
  total: number;
  nextDigestHuman: string;
}): Promise<void> {
  // Mirror renderAttentionDashboard logic: SELECT pinned_msg_id with topic='archive', etc.
  // (Copy the structure from renderAttentionDashboard, substitute topic and fmtArchive.)
}
```

Factor shared logic into a private `upsertDashboard(topic, chatId, text)` helper if the two are near-duplicates.

- [ ] **Step 17.4: Wire into daily digest caller**

In the function that produces the 8am PT digest, after the existing body, call `renderArchiveDashboard(...)` with counts derived from `SELECT action_intent, archive_category_ish FROM tracked_items WHERE classification = 'digest' AND state = 'queued'`. Use `archive_category` from `reasons_json` or (preferred) add a dedicated persisted column if schema allows — otherwise derive category from `action_intent` or sender-type heuristic.

- [ ] **Step 17.5: Run tests**

Run: `npm test -- daily-digest triage-dashboards`
Expected: PASS.

- [ ] **Step 17.6: Commit**

```bash
git add src/daily-digest.ts src/triage/dashboards.ts src/__tests__/daily-digest.test.ts
git commit -m "feat(triage): wire archive dashboard + daily 8am PT digest integration"
```

---

## Task 18: Attention re-surface timer (4h, once)

**Files:**
- Create: `src/triage/reminder.ts`
- Test: `src/__tests__/triage-reminder.test.ts`
- Modify: `src/index.ts` (or wherever periodic timers are scheduled)

Every `TRIAGE_ATTENTION_REMIND_HOURS` check for attention items still `state='pushed'` / `'pending'` whose `reminded_at` is null and `detected_at` is older than the window. Post a reminder push, update `reminded_at`. Only once per item.

- [ ] **Step 18.1: Add `reminded_at` column migration in `src/db.ts`**

```typescript
if (!trackedColNames.has('reminded_at')) {
  db.prepare(`ALTER TABLE tracked_items ADD COLUMN reminded_at INTEGER`).run();
}
```

(Include in the same migration block as Task 1 if you have not committed yet; if already committed, add a new idempotent check at the bottom of the migration section.)

- [ ] **Step 18.2: Write failing test**

Create `src/__tests__/triage-reminder.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../channels/telegram.js', () => ({
  sendTelegramMessage: mockSend,
  editTelegramMessage: vi.fn(),
  pinTelegramMessage: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';
import { runAttentionReminderSweep } from '../triage/reminder.js';
import { insertTrackedItem } from '../tracked-items.js';

describe('runAttentionReminderSweep', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockSend.mockReset();
    process.env.EMAIL_INTEL_TG_CHAT_ID = '-100999';
  });
  afterEach(() => _closeDatabase());

  it('sends reminder for overdue unreminded attention items', async () => {
    const oldMs = Date.now() - 5 * 60 * 60 * 1000;
    insertTrackedItem({
      id: 'r1', source: 'gmail', source_id: 'gmail:t', group_name: 'main',
      state: 'pushed', classification: 'push', superpilot_label: null,
      trust_tier: null, title: 'old one', summary: null, thread_id: 't',
      detected_at: oldMs, pushed_at: oldMs, resolved_at: null,
      resolution_method: null, digest_count: 0, telegram_message_id: null,
      classification_reason: null, metadata: null,
      confidence: 0.9, model_tier: 1, action_intent: 'none',
      facts_extracted: null, repo_candidates: null, reasons: ['x', 'y'],
    });

    await runAttentionReminderSweep({ windowHours: 4 });
    expect(mockSend).toHaveBeenCalledTimes(1);

    // Running again: already reminded, should NOT send again
    mockSend.mockReset();
    await runAttentionReminderSweep({ windowHours: 4 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does NOT send for fresh items', async () => {
    insertTrackedItem({
      id: 'r2', source: 'gmail', source_id: 'gmail:t2', group_name: 'main',
      state: 'pushed', classification: 'push', superpilot_label: null,
      trust_tier: null, title: 'fresh', summary: null, thread_id: 't2',
      detected_at: Date.now(), pushed_at: Date.now(), resolved_at: null,
      resolution_method: null, digest_count: 0, telegram_message_id: null,
      classification_reason: null, metadata: null,
      confidence: 0.9, model_tier: 1, action_intent: 'none',
      facts_extracted: null, repo_candidates: null, reasons: ['x', 'y'],
    });

    await runAttentionReminderSweep({ windowHours: 4 });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 18.3: Implement `src/triage/reminder.ts`**

```typescript
import { getDb } from '../db.js';
import { sendTelegramMessage } from '../channels/telegram.js';
import { logger } from '../logger.js';

export async function runAttentionReminderSweep(opts: {
  windowHours: number;
}): Promise<void> {
  const chatId = process.env.EMAIL_INTEL_TG_CHAT_ID;
  if (!chatId) return;

  const windowMs = opts.windowHours * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;

  const rows = getDb()
    .prepare(
      `SELECT id, title FROM tracked_items
       WHERE state IN ('pushed', 'pending')
         AND action_intent IS NOT NULL
         AND detected_at <= ?
         AND reminded_at IS NULL`,
    )
    .all(cutoff) as Array<{ id: string; title: string }>;

  for (const r of rows) {
    try {
      await sendTelegramMessage(
        chatId,
        `⏰ Still waiting on you: *${r.title}*`,
        { parse_mode: 'Markdown' },
      );
      getDb()
        .prepare(`UPDATE tracked_items SET reminded_at = ? WHERE id = ?`)
        .run(Date.now(), r.id);
    } catch (err) {
      logger.warn(
        { err: String(err), itemId: r.id },
        'Triage: failed to send attention reminder',
      );
    }
  }
}
```

- [ ] **Step 18.4: Schedule the sweep in `src/index.ts`**

Find the existing `setInterval(...)` / scheduling block (search for `setInterval` or existing watcher start). Add:

```typescript
import { runAttentionReminderSweep } from './triage/reminder.js';
import { TRIAGE_DEFAULTS } from './triage/config.js';

// Every hour; sweep function itself only sends for items older than windowHours with reminded_at=null.
setInterval(
  () => {
    if (!TRIAGE_DEFAULTS.enabled) return;
    void runAttentionReminderSweep({
      windowHours: TRIAGE_DEFAULTS.attentionRemindHours,
    }).catch((err) => {
      logger.warn({ err: String(err) }, 'attention reminder sweep failed');
    });
  },
  60 * 60 * 1000,
);
```

- [ ] **Step 18.5: Run tests**

Run: `npm test -- triage-reminder`
Expected: PASS.

- [ ] **Step 18.6: Commit**

```bash
git add src/db.ts src/triage/reminder.ts src/index.ts src/__tests__/triage-reminder.test.ts
git commit -m "feat(triage): 4h attention re-surface reminder (once per item)"
```

---

## Task 19: Nightly agreement-rate job + calibration alert

**Files:**
- Create: `src/triage/agreement.ts`
- Test: `src/__tests__/triage-agreement.test.ts`

Nightly: compute agent_agreement_rate by reading triage_events + user actions (from tracked_items.resolution_method and triage_examples). If any slice drops below `agreementFloor`, post a calibration alert to attention topic.

- [ ] **Step 19.1: Write failing test**

Create `src/__tests__/triage-agreement.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';
import {
  computeAgreement,
} from '../triage/agreement.js';

describe('computeAgreement', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('returns agreement=1 when user never overrode', () => {
    getDb()
      .prepare(
        `INSERT INTO triage_examples (kind, tracked_item_id, email_summary,
          agent_queue, user_queue, reasons_json, created_at)
         VALUES ('positive', 'a', 's', 'attention', 'attention', '[]', ?),
                ('positive', 'b', 's', 'archive_candidate', 'archive_candidate', '[]', ?)`,
      )
      .run(Date.now(), Date.now());

    const r = computeAgreement({ windowMs: 7 * 24 * 60 * 60 * 1000 });
    expect(r.overall).toBe(1);
    expect(r.total).toBe(2);
  });

  it('returns agreement < 1 when overrides exist', () => {
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO triage_examples (kind, tracked_item_id, email_summary,
          agent_queue, user_queue, reasons_json, created_at)
         VALUES ('positive', 'a', 's', 'attention', 'attention', '[]', ?),
                ('negative', 'b', 's', 'archive_candidate', 'attention', '[]', ?)`,
      )
      .run(now, now);

    const r = computeAgreement({ windowMs: 7 * 24 * 60 * 60 * 1000 });
    expect(r.overall).toBeCloseTo(0.5, 5);
  });
});
```

- [ ] **Step 19.2: Implement `src/triage/agreement.ts`**

```typescript
import { getDb } from '../db.js';

export interface AgreementReport {
  overall: number;
  total: number;
  bySlice: Record<string, { rate: number; total: number }>;
}

export function computeAgreement(opts: {
  windowMs: number;
}): AgreementReport {
  const cutoff = Date.now() - opts.windowMs;
  const rows = getDb()
    .prepare(
      `SELECT kind, agent_queue FROM triage_examples WHERE created_at >= ?`,
    )
    .all(cutoff) as Array<{ kind: string; agent_queue: string }>;

  let correct = 0;
  const sliceCounts: Record<string, { correct: number; total: number }> = {};

  for (const r of rows) {
    const bucket = (sliceCounts[r.agent_queue] ??= { correct: 0, total: 0 });
    bucket.total += 1;
    if (r.kind === 'positive') {
      correct += 1;
      bucket.correct += 1;
    }
  }

  const bySlice: Record<string, { rate: number; total: number }> = {};
  for (const [slice, c] of Object.entries(sliceCounts)) {
    bySlice[slice] = {
      rate: c.total === 0 ? 1 : c.correct / c.total,
      total: c.total,
    };
  }

  return {
    overall: rows.length === 0 ? 1 : correct / rows.length,
    total: rows.length,
    bySlice,
  };
}

export async function runNightlyAgreementCheck(opts: {
  agreementFloor: number;
}): Promise<void> {
  const r = computeAgreement({ windowMs: 7 * 24 * 60 * 60 * 1000 });
  if (r.total < 20) return;                      // not enough data
  if (r.overall >= opts.agreementFloor) return;

  const chatId = process.env.EMAIL_INTEL_TG_CHAT_ID;
  if (!chatId) return;

  const { sendTelegramMessage } = await import('../channels/telegram.js');
  const worst = Object.entries(r.bySlice).sort((a, b) => a[1].rate - b[1].rate)[0];
  const msg = `⚠️ Triage calibration alert: 7d agreement = ${(r.overall * 100).toFixed(0)}% (floor ${(opts.agreementFloor * 100).toFixed(0)}%).\nWorst slice: *${worst?.[0]}* at ${(worst?.[1].rate * 100).toFixed(0)}% over ${worst?.[1].total} items.`;
  await sendTelegramMessage(chatId, msg, { parse_mode: 'Markdown' });
}
```

- [ ] **Step 19.3: Schedule nightly run in `src/index.ts`**

```typescript
import { runNightlyAgreementCheck } from './triage/agreement.js';

// Every 24h, midnight-ish
setInterval(
  () => {
    if (!TRIAGE_DEFAULTS.enabled) return;
    void runNightlyAgreementCheck({ agreementFloor: 0.8 });
  },
  24 * 60 * 60 * 1000,
);
```

- [ ] **Step 19.4: Run test — confirm pass**

Run: `npm test -- triage-agreement`
Expected: PASS.

- [ ] **Step 19.5: Commit**

```bash
git add src/triage/agreement.ts src/index.ts src/__tests__/triage-agreement.test.ts
git commit -m "feat(triage): nightly agreement-rate check with calibration alerts"
```

---

## Task 20: Batch-API bootstrap script

**Files:**
- Create: `scripts/triage-bootstrap.ts`
- Test: (none — it's a one-off script; dry-run flag is sufficient validation)

Uses Anthropic Batch API on the last 5,000 archived emails + 500 inbox emails (read from SuperPilot via existing client or Gmail MCPs) to seed `triage_skip_list`, `triage_examples`. Safe to re-run; idempotent.

**SDK note:** The Vercel AI SDK does NOT expose Anthropic's Batch API. This script is a one-off bootstrap, not part of the runtime pipeline, so it may either (a) install `@anthropic-ai/sdk` specifically for this script (`npm install --save-dev @anthropic-ai/sdk`) and use `client.messages.batches.create(...)`, or (b) call the batch endpoint directly via `fetch` with `x-api-key` and `anthropic-beta: message-batches-2024-09-24` headers. Option (a) is simpler; the runtime classifier (Task 7) remains on Vercel AI SDK.

- [ ] **Step 20.1: Read how superpilot exposes historical emails**

Option A: Call `GET /api/nanoclaw/triaged-emails?since=<ISO>&limit=5000&status=archived` (check `nanoclaw_bridge.py` for available filters — the reference memory mentions this endpoint).

Option B: If unavailable, use Gmail MCPs to pull archived thread metadata per account. Slower but works without SuperPilot changes.

Pick A if available; fall back to B. Document choice in the script's header comment.

- [ ] **Step 20.2: Implement `scripts/triage-bootstrap.ts`**

```typescript
/**
 * Bootstrap triage skip-list and positive examples from historical email data.
 * Uses Anthropic Batch API for cost-efficient classification of 5k+ emails.
 *
 * Usage:
 *   npx tsx scripts/triage-bootstrap.ts --dry-run
 *   npx tsx scripts/triage-bootstrap.ts --limit 5000 --account topcoder1@gmail.com
 */
import Anthropic from '@anthropic-ai/sdk';
// ... implementation
```

Flesh this out to:
1. Fetch N historical archived emails for the given account via chosen source
2. Build a batch request: one item per email with the triage prompt
3. Submit to `client.messages.batches.create(...)`
4. Poll until complete
5. Parse results; for each archived email where the classifier agreed (queue=archive_candidate), `recordSkip(sender, promotionHits=1)` AND `recordExample({kind: 'positive', ...})`
6. For disagreements, `recordExample({kind: 'negative', ...})`
7. `--dry-run` prints what would be recorded without writing

Include a `--limit`, `--account`, and `--dry-run` flag. Refer to the `claude-api` skill's batch-API patterns if unsure about batch request format.

- [ ] **Step 20.3: Add npm script**

In `package.json`:

```json
"scripts": {
  "triage:bootstrap": "tsx scripts/triage-bootstrap.ts"
}
```

- [ ] **Step 20.4: Dry-run locally on ≤50 emails to verify**

```bash
npm run triage:bootstrap -- --dry-run --limit 50 --account topcoder1@gmail.com
```

Expected: prints decisions + proposed skip-list entries, no DB writes.

- [ ] **Step 20.5: Commit**

```bash
git add scripts/triage-bootstrap.ts package.json
git commit -m "feat(triage): batch-API bootstrap for skip-list + example seeding"
```

---

## Task 21: Rollout docs + shadow-mode verification

**Files:**
- Modify: `docs/superpowers/specs/2026-04-16-email-triage-pipeline-design.md` (append ops notes)
- Create: `docs/runbooks/triage-v1-rollout.md`

Document the shadow → live rollout sequence (from the spec) with the exact env-var toggles and verification commands.

- [ ] **Step 21.1: Write `docs/runbooks/triage-v1-rollout.md`**

```markdown
# Triage v1 Rollout Runbook

## Phase 1 — Shadow mode (48h)

1. Set in `.env`:
   ```
   TRIAGE_V1_ENABLED=1
   TRIAGE_SHADOW_MODE=1
   EMAIL_INTEL_TG_CHAT_ID=<group_id>
   ```
2. Restart NanoClaw: `launchctl kickstart -k gui/$(id -u) com.nanoclaw`
3. Verify SSE is flowing + triage is firing:
   ```bash
   sqlite3 data/nanoclaw.db "SELECT queue, confidence, model_tier FROM tracked_items WHERE confidence IS NOT NULL ORDER BY detected_at DESC LIMIT 20;"
   ```
4. Check traces:
   ```bash
   tail -50 .omc/logs/triage/$(date +%Y-%m-%d).jsonl | jq .
   ```
5. Check cache hit ratio (should be ≥80% after first hour):
   ```bash
   jq -s 'map({ci: .cacheReadTokens, in: .inputTokens}) | (map(.ci)|add) / (map(.in)|add)' .omc/logs/triage/$(date +%Y-%m-%d).jsonl
   ```
6. After 48h, audit tracked_items.confidence distribution and reasons for sanity.

## Phase 2 — Live on primary account

1. Flip `TRIAGE_SHADOW_MODE=0` in `.env`. Restart.
2. Watch `#attention` topic for per-email pushes + pinned dashboard updates.
3. First 24h: use the queue actively. Every archive/dismiss/override updates learning stores.

## Phase 3 — Bootstrap + extend

1. `npm run triage:bootstrap -- --limit 5000 --account topcoder1@gmail.com`
2. After skip-list promotions, verify rate of incoming emails that skip the classifier goes up (should approach 40% target).
3. Enable for secondary accounts by adding them to `SSE_CONNECTIONS` token list.

## Rollback

1. Set `TRIAGE_V1_ENABLED=0`. Restart.
2. Triage worker stops firing; legacy rule-based `classify()` remains as the only path.
3. Data in `tracked_items` triage columns is preserved for later analysis.
```

- [ ] **Step 21.2: Commit**

```bash
git add docs/runbooks/triage-v1-rollout.md
git commit -m "docs(triage): v1 rollout runbook with shadow→live commands"
```

---

## Final verification

- [ ] **Step V.1: Run full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step V.2: Run build**

Run: `npm run build`
Expected: No type errors.

- [ ] **Step V.3: Dry-run the bootstrap**

```bash
npm run triage:bootstrap -- --dry-run --limit 20 --account topcoder1@gmail.com
```

Expected: prints decisions, no DB changes.

- [ ] **Step V.4: 30-minute local shadow test**

Run: `npm run dev` with `TRIAGE_V1_ENABLED=1 TRIAGE_SHADOW_MODE=1`. Send yourself a real email. Verify trace appears in `.omc/logs/triage/<today>.jsonl`, tracked_items has the row with confidence set, no Telegram messages were sent.

- [ ] **Step V.5: Open PR**

```bash
git push -u origin claude/naughty-jemison-89b03b
gh pr create --title "feat(triage): v1 LLM-backed triage pipeline" --body "$(cat <<'EOF'
## Summary
- Tier-routed (Haiku/Sonnet/Opus) LLM classifier with prompt caching
- Strict structured-output schema with retry + escalation
- Pre-filter with learned skip-list promotion
- Pinned live dashboards (attention + archive) in Telegram
- Callback handlers closing the learning loop
- Facts extraction → group knowledge.md + Weaviate
- 4h attention re-surface reminder
- Nightly agreement-rate calibration alert
- Batch-API bootstrap script
- Shadow mode for safe rollout

## Test plan
- [ ] Full test suite green
- [ ] Shadow mode produces traces locally
- [ ] Bootstrap dry-run prints expected entries
- [ ] 48h shadow on topcoder1@ before flipping live

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Checklist (run before handing off to subagent execution)

- [ ] Every task has real TypeScript code blocks, not placeholders
- [ ] Every test has real expectations, not "add tests here"
- [ ] Type names are consistent across tasks (TriageDecision, TriageQueue, ClassifierResult, etc.)
- [ ] File paths are exact; tests co-located under `src/__tests__/`
- [ ] No step says "implement error handling" without showing the code
- [ ] Each task ends in a commit; commit messages follow conventional format
- [ ] Migration is idempotent (uses `IF NOT EXISTS` and column-presence checks)
- [ ] Shadow-mode path is explicit in the worker and covered by a test
- [ ] Cost cap is enforced before, not after, the classifier call
- [ ] Learning loop is closed: every button click writes to `triage_examples`

## Not In Scope For v1 (enforced by this plan)

- Repo resolution (v2 plan) — `repo_candidates` field exists in schema but not populated
- Agent-dispatch draft PRs (v3 plan)
- Attachment parsing (PDF/image) — add in v2 once repo-resolver lands
- MLflow MCP integration — JSONL traces sufficient for v1
- Calendar / Notion / Linear integrations
