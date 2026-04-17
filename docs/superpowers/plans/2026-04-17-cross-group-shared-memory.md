# Cross-Group Shared Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared cross-group facts layer in `groups/global/memory/` with per-turn Haiku auto-extraction, verifier-gated promotion, and Claude Code auto-memory format compatibility.

**Architecture:** All writes happen host-side. A new `src/memory/shared/` module reads/writes the on-disk store. An extractor listens on the event-bus (`turn.completed` event), runs a Haiku call after each agent reply, and drops candidate facts into `groups/global/memory/candidate/`. A verifier sweeps the candidate queue every 5 minutes (or when 10+ candidates accumulate), dedupes, gates with a Haiku quality check, and promotes to typed fact files. The MEMORY.md index is regenerated on every promotion. Containers see the index via the existing `additionalDirectories` mount.

**Tech Stack:** TypeScript, Node 22, `ai` SDK (Vercel AI), `@ai-sdk/anthropic`, vitest. Reuses existing `src/event-bus.ts`, `src/llm/utility.ts` (`resolveUtilityModel`), `src/task-scheduler.ts`, `src/chat-commands.ts`, `src/container-runner.ts`.

**Spec:** [docs/superpowers/specs/2026-04-17-cross-group-shared-memory-design.md](../specs/2026-04-17-cross-group-shared-memory-design.md)

---

## File Structure

**New:**
- `src/memory/shared/types.ts` — frontmatter & candidate types
- `src/memory/shared/paths.ts` — filesystem path helpers (memory dir, candidate dir, audit log)
- `src/memory/shared/store.ts` — read/write fact files, regenerate MEMORY.md
- `src/memory/shared/audit.ts` — append-only audit log writer
- `src/memory/shared/extractor.ts` — Haiku per-turn extraction
- `src/memory/shared/verifier.ts` — periodic candidate sweep + promotion
- `src/memory/shared/remember-tool.ts` — MCP tool handler for explicit `remember` calls
- `src/memory/shared/commands.ts` — `/memory list|show|forget` chat-command handlers
- `src/memory/shared/__tests__/store.test.ts`
- `src/memory/shared/__tests__/audit.test.ts`
- `src/memory/shared/__tests__/extractor.test.ts`
- `src/memory/shared/__tests__/verifier.test.ts`
- `src/memory/shared/__tests__/remember-tool.test.ts`
- `src/memory/shared/__tests__/commands.test.ts`
- `src/memory/shared/__tests__/flow.integration.test.ts`
- `docs/memory-cc-compat.md`

**Modified:**
- `src/events.ts` — add `TurnCompletedEvent` + register in `EventMap`
- `src/event-bus.ts` — no change (type-safe via EventMap)
- `src/env.ts` — add `NANOCLAW_MEMORY_EXTRACT`, `NANOCLAW_MEMORY_VERIFY` env vars
- `src/index.ts` — wire extractor to `turn.completed`; register verifier interval; emit `turn.completed` after agent reply
- `src/chat-commands.ts` — add `/memory ...` parsing + dispatch
- `src/container-runner.ts` — ensure `groups/global/memory/` exists; regenerate MEMORY.md before container start

---

## Task 1: Filesystem paths & types

**Files:**
- Create: `src/memory/shared/types.ts`
- Create: `src/memory/shared/paths.ts`
- Test: (none — pure types/constants, exercised by later tests)

- [ ] **Step 1: Create `src/memory/shared/types.ts`**

```typescript
// src/memory/shared/types.ts

export type FactType = 'user' | 'feedback' | 'project' | 'reference';

/** Frontmatter persisted to disk for a promoted fact. */
export interface FactFrontmatter {
  name: string;
  description: string;
  type: FactType;
  scopes?: string[];
  count: number;
  first_seen: string; // ISO date
  last_seen: string; // ISO date
  last_value?: string;
  sources: Record<string, number>; // groupName -> count
  history?: string[]; // last 5 prior bodies, newest first
}

/** A promoted fact = frontmatter + body. */
export interface Fact {
  slug: string; // filename stem, e.g. "feedback_terse_responses"
  frontmatter: FactFrontmatter;
  body: string;
}

/** Frontmatter for a candidate (unverified) fact. */
export interface CandidateFrontmatter {
  candidate: true;
  type: FactType;
  name: string;
  description: string;
  scopes?: string[];
  extracted_from: string; // group name
  extracted_at: string; // ISO datetime
  turn_excerpt: string;
  proposed_action: 'create' | `merge:${string}`;
  confidence: number; // 0..1
}

export interface Candidate {
  filename: string; // basename only
  frontmatter: CandidateFrontmatter;
  body: string;
}

/** Output schema from the extractor LLM. */
export interface ExtractedCandidate {
  type: FactType;
  name: string;
  description: string;
  body: string;
  scopes?: string[];
  proposed_action: 'create' | `merge:${string}`;
  confidence: number;
}

export interface ExtractorResult {
  candidates: ExtractedCandidate[];
}
```

- [ ] **Step 2: Create `src/memory/shared/paths.ts`**

```typescript
// src/memory/shared/paths.ts
import path from 'path';
import fs from 'fs';

/**
 * Resolve the host-side root of the shared memory store.
 * Defaults to `<projectRoot>/groups/global/memory`. Override with
 * NANOCLAW_MEMORY_DIR for tests.
 */
export function memoryRoot(): string {
  if (process.env.NANOCLAW_MEMORY_DIR) {
    return process.env.NANOCLAW_MEMORY_DIR;
  }
  // projectRoot = parent of `src/` at runtime (cwd is repo root for `npm run dev`)
  return path.join(process.cwd(), 'groups', 'global', 'memory');
}

export function candidateDir(): string {
  return path.join(memoryRoot(), 'candidate');
}

export function rejectedDir(): string {
  return path.join(candidateDir(), 'rejected');
}

export function archivedDir(): string {
  return path.join(memoryRoot(), '.archived');
}

export function auditLogPath(): string {
  return path.join(memoryRoot(), '.audit.log');
}

export function indexPath(): string {
  return path.join(memoryRoot(), 'MEMORY.md');
}

export function factPath(slug: string): string {
  return path.join(memoryRoot(), `${slug}.md`);
}

/** Create all directories used by the store (idempotent). */
export function ensureMemoryDirs(): void {
  for (const dir of [memoryRoot(), candidateDir(), rejectedDir(), archivedDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/memory/shared/types.ts src/memory/shared/paths.ts
git commit -m "feat(memory): add shared-memory types and path helpers"
```

---

## Task 2: Store (read/write fact files + index regeneration)

**Files:**
- Create: `src/memory/shared/store.ts`
- Test: `src/memory/shared/__tests__/store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/memory/shared/__tests__/store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writeFact,
  readFact,
  listFacts,
  regenerateIndex,
  archiveFact,
} from '../store.js';
import { ensureMemoryDirs, indexPath, factPath } from '../paths.js';
import type { Fact } from '../types.js';

describe('shared memory store', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-store-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
  });

  it('round-trips a fact through write and read', () => {
    const fact: Fact = {
      slug: 'feedback_terse',
      frontmatter: {
        name: 'Prefers terse responses',
        description: 'short answers',
        type: 'feedback',
        count: 3,
        first_seen: '2026-04-01',
        last_seen: '2026-04-15',
        sources: { telegram_main: 3 },
      },
      body: 'User prefers terse responses.',
    };
    writeFact(fact);
    const round = readFact('feedback_terse');
    expect(round).not.toBeNull();
    expect(round!.frontmatter.name).toBe('Prefers terse responses');
    expect(round!.frontmatter.count).toBe(3);
    expect(round!.body.trim()).toBe('User prefers terse responses.');
  });

  it('lists facts by type from disk', () => {
    writeFact({
      slug: 'user_role',
      frontmatter: {
        name: 'role',
        description: 'd',
        type: 'user',
        count: 1,
        first_seen: '2026-04-01',
        last_seen: '2026-04-01',
        sources: { main: 1 },
      },
      body: 'b',
    });
    writeFact({
      slug: 'feedback_terse',
      frontmatter: {
        name: 'terse',
        description: 'd',
        type: 'feedback',
        count: 1,
        first_seen: '2026-04-01',
        last_seen: '2026-04-01',
        sources: { main: 1 },
      },
      body: 'b',
    });
    const all = listFacts();
    expect(all.map((f) => f.slug).sort()).toEqual([
      'feedback_terse',
      'user_role',
    ]);
  });

  it('regenerates a deterministic MEMORY.md index', () => {
    writeFact({
      slug: 'feedback_terse',
      frontmatter: {
        name: 'Prefers terse responses',
        description: 'short answers',
        type: 'feedback',
        count: 12,
        first_seen: '2026-04-01',
        last_seen: '2026-04-15',
        sources: { telegram_main: 8, whatsapp_personal: 4 },
      },
      body: 'b',
    });
    regenerateIndex();
    const indexA = fs.readFileSync(indexPath(), 'utf8');
    regenerateIndex();
    const indexB = fs.readFileSync(indexPath(), 'utf8');
    expect(indexA).toBe(indexB); // idempotent
    expect(indexA).toContain('Prefers terse responses');
    expect(indexA).toContain('feedback_terse.md');
    expect(indexA).toContain('# Shared user memory');
  });

  it('archives a fact (soft-delete)', () => {
    writeFact({
      slug: 'feedback_x',
      frontmatter: {
        name: 'x',
        description: 'd',
        type: 'feedback',
        count: 1,
        first_seen: '2026-04-01',
        last_seen: '2026-04-01',
        sources: { main: 1 },
      },
      body: 'b',
    });
    expect(fs.existsSync(factPath('feedback_x'))).toBe(true);
    archiveFact('feedback_x');
    expect(fs.existsSync(factPath('feedback_x'))).toBe(false);
    expect(readFact('feedback_x')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/shared/__tests__/store.test.ts`
Expected: FAIL with module-not-found for `../store.js`.

- [ ] **Step 3: Implement `src/memory/shared/store.ts`**

```typescript
// src/memory/shared/store.ts
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {
  memoryRoot,
  factPath,
  indexPath,
  archivedDir,
  ensureMemoryDirs,
} from './paths.js';
import type { Fact, FactFrontmatter, FactType } from './types.js';

const FRONTMATTER_DELIM = '---';
const INDEX_PREAMBLE = `# Shared user memory

These facts were learned across all groups. Each fact has metadata:
- \`count\` — times reinforced (higher = more reliable)
- \`last_seen\` — recency
- \`last_value\` — current value if it shifts (e.g. preference changed)
- \`scopes\` — when this applies (empty = always)

Apply the highest-count value by default; override with newer/scoped values when context matches. If two facts conflict and counts are close, surface the tension to the user rather than guessing.

---
`;

export function writeFact(fact: Fact): void {
  ensureMemoryDirs();
  const front = yaml.dump(fact.frontmatter, { lineWidth: 120 }).trimEnd();
  const content = `${FRONTMATTER_DELIM}\n${front}\n${FRONTMATTER_DELIM}\n\n${fact.body.trim()}\n`;
  fs.writeFileSync(factPath(fact.slug), content);
}

export function readFact(slug: string): Fact | null {
  const p = factPath(slug);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  return {
    slug,
    frontmatter: parsed.frontmatter as FactFrontmatter,
    body: parsed.body,
  };
}

export function listFacts(filter?: { type?: FactType }): Fact[] {
  ensureMemoryDirs();
  const root = memoryRoot();
  const out: Fact[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (!entry.endsWith('.md') || entry === 'MEMORY.md') continue;
    if (entry.startsWith('.')) continue;
    const slug = entry.replace(/\.md$/, '');
    const fact = readFact(slug);
    if (!fact) continue;
    if (filter?.type && fact.frontmatter.type !== filter.type) continue;
    out.push(fact);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function regenerateIndex(): void {
  ensureMemoryDirs();
  const facts = listFacts();
  const lines = facts.map((f) => {
    const sourcesSummary = summarizeSources(f.frontmatter.sources);
    const hook = `${f.frontmatter.count} reinforcement${
      f.frontmatter.count === 1 ? '' : 's'
    }${sourcesSummary ? ` across ${sourcesSummary}` : ''}`;
    return `- [${f.frontmatter.name}](${f.slug}.md) — ${hook}`;
  });
  const content = INDEX_PREAMBLE + '\n' + lines.join('\n') + '\n';
  fs.writeFileSync(indexPath(), content);
}

export function archiveFact(slug: string): boolean {
  const src = factPath(slug);
  if (!fs.existsSync(src)) return false;
  ensureMemoryDirs();
  const dest = path.join(archivedDir(), `${slug}-${Date.now()}.md`);
  fs.renameSync(src, dest);
  regenerateIndex();
  return true;
}

function parseFrontmatter(raw: string):
  | {
      frontmatter: Record<string, unknown>;
      body: string;
    }
  | null {
  if (!raw.startsWith(FRONTMATTER_DELIM)) return null;
  const end = raw.indexOf(`\n${FRONTMATTER_DELIM}`, FRONTMATTER_DELIM.length);
  if (end < 0) return null;
  const front = raw.slice(FRONTMATTER_DELIM.length, end).trim();
  const body = raw.slice(end + FRONTMATTER_DELIM.length + 1).trim();
  const fm = yaml.load(front) as Record<string, unknown>;
  return { frontmatter: fm, body };
}

function summarizeSources(sources: Record<string, number>): string {
  const groups = Object.keys(sources);
  if (groups.length === 0) return '';
  if (groups.length <= 2) return groups.join(' + ');
  return `${groups.slice(0, 2).join(' + ')} +${groups.length - 2}`;
}
```

- [ ] **Step 4: Install `js-yaml` if not present**

```bash
npm ls js-yaml || npm install js-yaml @types/js-yaml
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/memory/shared/__tests__/store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/memory/shared/store.ts src/memory/shared/__tests__/store.test.ts package.json package-lock.json
git commit -m "feat(memory): add fact store with idempotent index regeneration"
```

---

## Task 3: Audit log

**Files:**
- Create: `src/memory/shared/audit.ts`
- Test: `src/memory/shared/__tests__/audit.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/memory/shared/__tests__/audit.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logAudit, readAudit } from '../audit.js';
import { ensureMemoryDirs } from '../paths.js';

describe('audit log', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-audit-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
  });

  it('appends entries and reads them back in order', () => {
    logAudit({ action: 'create', slug: 'feedback_a', source: 'main', reason: 'x' });
    logAudit({ action: 'merge', slug: 'feedback_a', source: 'tg', reason: 'reinforced' });
    const lines = readAudit();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ action: 'create', slug: 'feedback_a' });
    expect(lines[1]).toMatchObject({ action: 'merge', slug: 'feedback_a' });
  });

  it('returns empty array if log does not exist', () => {
    expect(readAudit()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/shared/__tests__/audit.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `src/memory/shared/audit.ts`**

```typescript
// src/memory/shared/audit.ts
import fs from 'fs';
import { auditLogPath, ensureMemoryDirs } from './paths.js';

export type AuditAction = 'create' | 'merge' | 'reject' | 'archive';

export interface AuditEntry {
  ts: string; // ISO datetime
  action: AuditAction;
  slug: string;
  source: string;
  reason: string;
}

export function logAudit(entry: Omit<AuditEntry, 'ts'>): void {
  ensureMemoryDirs();
  const line: AuditEntry = { ts: new Date().toISOString(), ...entry };
  fs.appendFileSync(auditLogPath(), JSON.stringify(line) + '\n');
}

export function readAudit(): AuditEntry[] {
  const p = auditLogPath();
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEntry);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/memory/shared/__tests__/audit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/memory/shared/audit.ts src/memory/shared/__tests__/audit.test.ts
git commit -m "feat(memory): add audit log for promotion/merge/reject events"
```

---

## Task 4: `turn.completed` event type

**Files:**
- Modify: `src/events.ts`

- [ ] **Step 1: Add the event interface and EventMap entry**

In `src/events.ts`, after the `MessageOutboundEvent` interface (around line 45), add:

```typescript
export interface TurnCompletedEvent extends NanoClawEvent {
  type: 'turn.completed';
  source: 'orchestrator';
  groupId: string;
  payload: {
    groupName: string; // e.g. "telegram_main"
    userMessage: string;
    agentReply: string;
    durationMs: number;
  };
}
```

In the `EventMap` interface at the bottom of the file, add:

```typescript
'turn.completed': TurnCompletedEvent;
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/events.ts
git commit -m "feat(events): add turn.completed event for memory extraction"
```

---

## Task 5: Extractor (Haiku per-turn)

**Files:**
- Create: `src/memory/shared/extractor.ts`
- Test: `src/memory/shared/__tests__/extractor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/memory/shared/__tests__/extractor.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractCandidates, isTrivialTurn } from '../extractor.js';
import { ensureMemoryDirs, candidateDir } from '../paths.js';

vi.mock('../../../llm/utility.js', () => ({
  resolveUtilityModel: vi.fn(() => ({ id: 'mock' })),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

describe('extractor', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-ext-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
    vi.clearAllMocks();
  });

  it('skips trivial turns', () => {
    expect(isTrivialTurn('hi', 'hello!')).toBe(true);
    expect(isTrivialTurn('thanks', 'np')).toBe(true);
  });

  it('does not skip substantive turns', () => {
    expect(
      isTrivialTurn(
        'I prefer short answers, please be terse from now on',
        'Got it, I will be terse.',
      ),
    ).toBe(false);
  });

  it('writes candidate files when LLM returns candidates', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        candidates: [
          {
            type: 'feedback',
            name: 'Prefers terse',
            description: 'd',
            body: 'User prefers terse.',
            scopes: ['chat'],
            proposed_action: 'create',
            confidence: 0.9,
          },
        ],
      }),
    });
    await extractCandidates({
      groupName: 'telegram_main',
      userMessage: 'be terse from now on',
      agentReply: 'OK, will keep it short.',
    });
    const files = fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/telegram_main/);
    const raw = fs.readFileSync(path.join(candidateDir(), files[0]), 'utf8');
    expect(raw).toContain('Prefers terse');
    expect(raw).toContain('candidate: true');
  });

  it('writes nothing when LLM returns empty candidates', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ candidates: [] }),
    });
    await extractCandidates({
      groupName: 'tg',
      userMessage: 'random question',
      agentReply: 'random answer',
    });
    expect(fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md')))
      .toHaveLength(0);
  });

  it('does not throw on malformed LLM output (fail closed)', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'not json at all',
    });
    await expect(
      extractCandidates({
        groupName: 'tg',
        userMessage: 'x',
        agentReply: 'y',
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/shared/__tests__/extractor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/memory/shared/extractor.ts`**

```typescript
// src/memory/shared/extractor.ts
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import crypto from 'crypto';
import { generateText } from 'ai';
import { resolveUtilityModel } from '../../llm/utility.js';
import { logger } from '../../logger.js';
import { candidateDir, ensureMemoryDirs, indexPath } from './paths.js';
import type {
  CandidateFrontmatter,
  ExtractedCandidate,
  ExtractorResult,
} from './types.js';

const TRIVIAL_PATTERNS = [
  /^(hi|hey|hello|yo|sup|thanks|thank you|ty|np|ok|okay|cool|got it|nice|great|done|sure|yes|no|nope|yep|yeah)[!.?\s]*$/i,
];

const MIN_TURN_TOKENS = 30; // approx by char count / 4

export function isTrivialTurn(userMessage: string, agentReply: string): boolean {
  const total = userMessage.length + agentReply.length;
  if (total < MIN_TURN_TOKENS * 4) return true;
  for (const pattern of TRIVIAL_PATTERNS) {
    if (pattern.test(userMessage.trim())) return true;
  }
  return false;
}

export interface ExtractInput {
  groupName: string;
  userMessage: string;
  agentReply: string;
}

export async function extractCandidates(input: ExtractInput): Promise<void> {
  if (process.env.NANOCLAW_MEMORY_EXTRACT === '0') return;
  if (isTrivialTurn(input.userMessage, input.agentReply)) return;

  ensureMemoryDirs();
  const indexSnippet = readIndexSnippet();

  let result: ExtractorResult;
  try {
    const model = resolveUtilityModel(
      process.env.MEMORY_EXTRACT_MODEL ?? 'anthropic:claude-haiku-4-5-20251001',
    );
    const llm = await generateText({
      model,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildPrompt(input, indexSnippet),
        },
      ],
      maxOutputTokens: 800,
    });
    result = parseLLMOutput(llm.text);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'memory extractor: LLM call failed, skipping',
    );
    return;
  }

  for (const cand of result.candidates) {
    writeCandidate(cand, input);
  }
}

function buildPrompt(input: ExtractInput, indexSnippet: string): string {
  return `Group: ${input.groupName}

Existing memory index (so you can propose merges, not duplicates):
${indexSnippet || '(empty)'}

Last user message:
${input.userMessage}

Agent reply:
${input.agentReply}

Extract any durable facts about the user, their preferences, ongoing projects, or external references that would be useful in future conversations across other groups. Return zero candidates if there is nothing durable to learn.`;
}

const SYSTEM_PROMPT = `You extract durable user facts from chat turns.

Output strict JSON only: { "candidates": [...] }

Each candidate has:
- type: one of "user" (identity facts), "feedback" (preferences/corrections), "project" (ongoing work state), "reference" (external pointers)
- name: short title (under 60 chars)
- description: one-line summary used in the index
- body: 1-3 paragraphs explaining the fact, including a "Why:" and "How to apply:" line for feedback/project types
- scopes: optional array. Use sparingly. Common values: "personal", "chat", "coding", "research", "work:whoisxml", "work:attaxion", "work:dev"
- proposed_action: "create" for a new fact, or "merge:<existing-slug>" if an entry in the index covers the same thing
- confidence: 0.0-1.0 — how sure are you this is durable signal, not transient state

Skip ephemeral things (current task progress, one-off questions, agent confusion). Skip facts already represented in the index unless you have a merge proposal that adds information.

Return { "candidates": [] } if nothing qualifies. Output JSON ONLY, no prose.`;

function parseLLMOutput(text: string): ExtractorResult {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const parsed = JSON.parse(trimmed) as ExtractorResult;
  if (!parsed.candidates || !Array.isArray(parsed.candidates)) {
    return { candidates: [] };
  }
  return parsed;
}

function readIndexSnippet(): string {
  if (!fs.existsSync(indexPath())) return '';
  const raw = fs.readFileSync(indexPath(), 'utf8');
  // Skip preamble; return only bullet entries (≤ 50 lines)
  return raw
    .split('\n')
    .filter((line) => line.startsWith('- ['))
    .slice(0, 50)
    .join('\n');
}

function writeCandidate(cand: ExtractedCandidate, input: ExtractInput): void {
  const slug = slugify(cand.name);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(3).toString('hex');
  const filename = `${ts}-${input.groupName}-${slug}-${rand}.md`;

  const frontmatter: CandidateFrontmatter = {
    candidate: true,
    type: cand.type,
    name: cand.name,
    description: cand.description,
    scopes: cand.scopes,
    extracted_from: input.groupName,
    extracted_at: new Date().toISOString(),
    turn_excerpt: truncate(`USER: ${input.userMessage}\nAGENT: ${input.agentReply}`, 600),
    proposed_action: cand.proposed_action,
    confidence: cand.confidence,
  };

  const front = yaml.dump(frontmatter, { lineWidth: 120 }).trimEnd();
  const content = `---\n${front}\n---\n\n${cand.body.trim()}\n`;
  fs.writeFileSync(path.join(candidateDir(), filename), content);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'fact';
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/memory/shared/__tests__/extractor.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/memory/shared/extractor.ts src/memory/shared/__tests__/extractor.test.ts
git commit -m "feat(memory): add per-turn Haiku extractor for candidate facts"
```

---

## Task 6: Verifier (sweep + promote/merge/reject)

**Files:**
- Create: `src/memory/shared/verifier.ts`
- Test: `src/memory/shared/__tests__/verifier.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/memory/shared/__tests__/verifier.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { runVerifierSweep } from '../verifier.js';
import {
  ensureMemoryDirs,
  candidateDir,
  rejectedDir,
  factPath,
} from '../paths.js';
import { writeFact } from '../store.js';
import type { CandidateFrontmatter } from '../types.js';

vi.mock('../../../llm/utility.js', () => ({
  resolveUtilityModel: vi.fn(() => ({ id: 'mock' })),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

function writeCandFile(
  filename: string,
  fm: CandidateFrontmatter,
  body: string,
): void {
  const front = yaml.dump(fm).trimEnd();
  fs.writeFileSync(
    path.join(candidateDir(), filename),
    `---\n${front}\n---\n\n${body}\n`,
  );
}

describe('verifier sweep', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-verify-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
    vi.clearAllMocks();
  });

  it('promotes a passing candidate to a typed fact file', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ verdict: 'pass', reason: 'durable preference' }),
    });
    writeCandFile(
      '2026-04-17-tg-prefers_terse-abc.md',
      {
        candidate: true,
        type: 'feedback',
        name: 'Prefers terse',
        description: 'd',
        extracted_from: 'telegram_main',
        extracted_at: '2026-04-17T15:00:00Z',
        turn_excerpt: 'x',
        proposed_action: 'create',
        confidence: 0.9,
      },
      'User prefers terse.',
    );

    await runVerifierSweep();

    expect(fs.existsSync(factPath('feedback_prefers_terse'))).toBe(true);
    expect(fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md')))
      .toHaveLength(0);
  });

  it('merges into existing fact, incrementing count and source', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ verdict: 'pass', reason: 'reinforcement' }),
    });
    writeFact({
      slug: 'feedback_prefers_terse',
      frontmatter: {
        name: 'Prefers terse',
        description: 'd',
        type: 'feedback',
        count: 3,
        first_seen: '2026-04-01',
        last_seen: '2026-04-10',
        sources: { telegram_main: 3 },
      },
      body: 'old body',
    });
    writeCandFile(
      '2026-04-17-wa-prefers_terse-def.md',
      {
        candidate: true,
        type: 'feedback',
        name: 'Prefers terse',
        description: 'd',
        extracted_from: 'whatsapp_personal',
        extracted_at: '2026-04-17T15:00:00Z',
        turn_excerpt: 'x',
        proposed_action: 'merge:feedback_prefers_terse',
        confidence: 0.8,
      },
      'User prefers terse responses, reinforced.',
    );

    await runVerifierSweep();

    const raw = fs.readFileSync(factPath('feedback_prefers_terse'), 'utf8');
    expect(raw).toContain('count: 4');
    expect(raw).toContain('whatsapp_personal: 1');
    expect(raw).toContain('telegram_main: 3');
    // Body replaced; old body in history
    expect(raw).toContain('User prefers terse responses, reinforced.');
    expect(raw).toContain('old body');
  });

  it('rejects a failing candidate', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ verdict: 'fail', reason: 'transient' }),
    });
    writeCandFile(
      '2026-04-17-tg-noise-xyz.md',
      {
        candidate: true,
        type: 'project',
        name: 'noise',
        description: 'd',
        extracted_from: 'tg',
        extracted_at: '2026-04-17T15:00:00Z',
        turn_excerpt: 'x',
        proposed_action: 'create',
        confidence: 0.4,
      },
      'b',
    );

    await runVerifierSweep();

    expect(fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md')))
      .toHaveLength(0);
    expect(fs.readdirSync(rejectedDir()).filter((f) => f.endsWith('.md')))
      .toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/shared/__tests__/verifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/memory/shared/verifier.ts`**

```typescript
// src/memory/shared/verifier.ts
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { generateText } from 'ai';
import { resolveUtilityModel } from '../../llm/utility.js';
import { logger } from '../../logger.js';
import {
  candidateDir,
  rejectedDir,
  ensureMemoryDirs,
} from './paths.js';
import { readFact, writeFact, regenerateIndex } from './store.js';
import { logAudit } from './audit.js';
import type {
  Candidate,
  CandidateFrontmatter,
  Fact,
  FactFrontmatter,
} from './types.js';

const MAX_HISTORY = 5;

export async function runVerifierSweep(): Promise<void> {
  if (process.env.NANOCLAW_MEMORY_VERIFY === '0') return;

  ensureMemoryDirs();
  const candidates = listCandidates();
  if (candidates.length === 0) return;

  let mutated = false;
  for (const cand of candidates) {
    try {
      const handled = await processCandidate(cand);
      if (handled) mutated = true;
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          file: cand.filename,
        },
        'memory verifier: candidate processing failed',
      );
    }
  }

  if (mutated) regenerateIndex();
}

async function processCandidate(cand: Candidate): Promise<boolean> {
  // Merge path: existing fact named in proposed_action
  const action = cand.frontmatter.proposed_action;
  if (action.startsWith('merge:')) {
    const existing = readFact(action.slice('merge:'.length));
    if (existing) {
      mergeFact(existing, cand);
      removeCandidate(cand);
      logAudit({
        action: 'merge',
        slug: existing.slug,
        source: cand.frontmatter.extracted_from,
        reason: 'merge proposed_action',
      });
      return true;
    }
    // existing not found → fall through to create with quality gate
  }

  // Quality gate (Haiku)
  const verdict = await qualityGate(cand);
  if (!verdict.pass) {
    rejectCandidate(cand, verdict.reason);
    logAudit({
      action: 'reject',
      slug: slugFor(cand),
      source: cand.frontmatter.extracted_from,
      reason: verdict.reason,
    });
    return false;
  }

  // Implicit-merge: name collision with existing fact
  const slug = slugFor(cand);
  const existing = readFact(slug);
  if (existing) {
    mergeFact(existing, cand);
    removeCandidate(cand);
    logAudit({
      action: 'merge',
      slug,
      source: cand.frontmatter.extracted_from,
      reason: 'name collision',
    });
    return true;
  }

  // Promote new fact
  const now = new Date().toISOString().slice(0, 10);
  const newFact: Fact = {
    slug,
    frontmatter: {
      name: cand.frontmatter.name,
      description: cand.frontmatter.description,
      type: cand.frontmatter.type,
      scopes: cand.frontmatter.scopes,
      count: 1,
      first_seen: now,
      last_seen: now,
      sources: { [cand.frontmatter.extracted_from]: 1 },
    },
    body: cand.body,
  };
  writeFact(newFact);
  removeCandidate(cand);
  logAudit({
    action: 'create',
    slug,
    source: cand.frontmatter.extracted_from,
    reason: verdict.reason,
  });
  return true;
}

function mergeFact(existing: Fact, cand: Candidate): void {
  const fm: FactFrontmatter = { ...existing.frontmatter };
  fm.count += 1;
  fm.last_seen = new Date().toISOString().slice(0, 10);
  if (cand.frontmatter.scopes) {
    const merged = new Set([...(fm.scopes ?? []), ...cand.frontmatter.scopes]);
    fm.scopes = Array.from(merged);
  }
  const src = cand.frontmatter.extracted_from;
  fm.sources = { ...fm.sources, [src]: (fm.sources[src] ?? 0) + 1 };

  const newBody = cand.body.trim();
  if (newBody && newBody !== existing.body.trim()) {
    fm.history = [existing.body.trim(), ...(fm.history ?? [])].slice(0, MAX_HISTORY);
    fm.last_value = newBody.split('\n')[0].slice(0, 80);
  }

  writeFact({ slug: existing.slug, frontmatter: fm, body: newBody || existing.body });
}

interface Verdict {
  pass: boolean;
  reason: string;
}

async function qualityGate(cand: Candidate): Promise<Verdict> {
  const model = resolveUtilityModel(
    process.env.MEMORY_VERIFY_MODEL ?? 'anthropic:claude-haiku-4-5-20251001',
  );
  const prompt = `Candidate fact:
Name: ${cand.frontmatter.name}
Type: ${cand.frontmatter.type}
Body: ${cand.body}
Source group: ${cand.frontmatter.extracted_from}
Confidence (extractor): ${cand.frontmatter.confidence}

Extracted from this turn excerpt:
${cand.frontmatter.turn_excerpt}

Is this a real, durable fact about the user, their preferences, ongoing work, or external references that would be useful in future conversations across other groups?

Return strict JSON: { "verdict": "pass" | "fail", "reason": "<one short sentence>" }
Reject if: transient state (current task progress), agent confusion, hallucination, or trivially derivable from the chat platform itself.`;

  let text: string;
  try {
    const llm = await generateText({
      model,
      system: 'You are a careful gatekeeper for a long-term memory store. Output JSON only.',
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: 200,
    });
    text = llm.text;
  } catch (err) {
    return { pass: false, reason: `verifier LLM error: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const parsed = JSON.parse(
      text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''),
    ) as Verdict & { verdict: 'pass' | 'fail' };
    return { pass: parsed.verdict === 'pass', reason: parsed.reason };
  } catch {
    return { pass: false, reason: 'unparseable verifier output' };
  }
}

function listCandidates(): Candidate[] {
  ensureMemoryDirs();
  const out: Candidate[] = [];
  for (const entry of fs.readdirSync(candidateDir())) {
    if (!entry.endsWith('.md')) continue;
    const full = path.join(candidateDir(), entry);
    if (!fs.statSync(full).isFile()) continue;
    const raw = fs.readFileSync(full, 'utf8');
    const parsed = parseFront(raw);
    if (!parsed) continue;
    out.push({
      filename: entry,
      frontmatter: parsed.frontmatter as CandidateFrontmatter,
      body: parsed.body,
    });
  }
  return out;
}

function parseFront(raw: string): { frontmatter: Record<string, unknown>; body: string } | null {
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return null;
  const front = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  return { frontmatter: yaml.load(front) as Record<string, unknown>, body };
}

function removeCandidate(cand: Candidate): void {
  fs.unlinkSync(path.join(candidateDir(), cand.filename));
}

function rejectCandidate(cand: Candidate, reason: string): void {
  const dest = path.join(rejectedDir(), cand.filename);
  const raw = fs.readFileSync(path.join(candidateDir(), cand.filename), 'utf8');
  fs.writeFileSync(dest, `# Rejected: ${reason}\n\n${raw}`);
  fs.unlinkSync(path.join(candidateDir(), cand.filename));
}

function slugFor(cand: Candidate): string {
  const base = cand.frontmatter.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'fact';
  return `${cand.frontmatter.type}_${base}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/memory/shared/__tests__/verifier.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/memory/shared/verifier.ts src/memory/shared/__tests__/verifier.test.ts
git commit -m "feat(memory): add verifier sweep with quality gate, merge, and reject"
```

---

## Task 7: `remember` MCP tool

**Files:**
- Create: `src/memory/shared/remember-tool.ts`
- Test: `src/memory/shared/__tests__/remember-tool.test.ts`

The `remember` tool is host-side; it writes a candidate file with `confidence: 1.0` and the calling group as the source. Wiring it into the actual MCP server happens in Task 9 (orchestrator wiring) — this task ships the pure handler.

- [ ] **Step 1: Write the failing test**

```typescript
// src/memory/shared/__tests__/remember-tool.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { rememberTool } from '../remember-tool.js';
import { ensureMemoryDirs, candidateDir } from '../paths.js';

describe('remember tool', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-rem-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
  });

  it('writes a candidate with confidence 1.0 and proposed_action create', async () => {
    await rememberTool({
      groupName: 'telegram_main',
      type: 'feedback',
      name: 'No auto-archive',
      body: 'Never auto-archive emails.',
      scopes: ['personal'],
    });
    const files = fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const raw = fs.readFileSync(path.join(candidateDir(), files[0]), 'utf8');
    expect(raw).toContain('confidence: 1');
    expect(raw).toContain('proposed_action: create');
    expect(raw).toContain('extracted_from: telegram_main');
    expect(raw).toContain('No auto-archive');
  });

  it('rejects unknown type', async () => {
    await expect(
      rememberTool({
        groupName: 'tg',
        type: 'invalid' as never,
        name: 'x',
        body: 'y',
      }),
    ).rejects.toThrow(/type/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/shared/__tests__/remember-tool.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/memory/shared/remember-tool.ts`**

```typescript
// src/memory/shared/remember-tool.ts
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import crypto from 'crypto';
import { candidateDir, ensureMemoryDirs } from './paths.js';
import type { CandidateFrontmatter, FactType } from './types.js';

const VALID_TYPES: FactType[] = ['user', 'feedback', 'project', 'reference'];

export interface RememberInput {
  groupName: string;
  type: FactType;
  name: string;
  body: string;
  description?: string;
  scopes?: string[];
}

export async function rememberTool(input: RememberInput): Promise<{ slug: string }> {
  if (!VALID_TYPES.includes(input.type)) {
    throw new Error(`Invalid type: ${input.type}. Must be one of ${VALID_TYPES.join(', ')}`);
  }
  if (!input.name?.trim() || !input.body?.trim()) {
    throw new Error('name and body are required');
  }

  ensureMemoryDirs();
  const slug = `${input.type}_${slugify(input.name)}`;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(3).toString('hex');
  const filename = `${ts}-${input.groupName}-${slugify(input.name)}-${rand}.md`;

  const fm: CandidateFrontmatter = {
    candidate: true,
    type: input.type,
    name: input.name.trim(),
    description: input.description?.trim() ?? input.name.trim(),
    scopes: input.scopes,
    extracted_from: input.groupName,
    extracted_at: new Date().toISOString(),
    turn_excerpt: '(explicit save via remember tool)',
    proposed_action: 'create',
    confidence: 1.0,
  };

  const front = yaml.dump(fm).trimEnd();
  const content = `---\n${front}\n---\n\n${input.body.trim()}\n`;
  fs.writeFileSync(path.join(candidateDir(), filename), content);
  return { slug };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'fact';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/memory/shared/__tests__/remember-tool.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/memory/shared/remember-tool.ts src/memory/shared/__tests__/remember-tool.test.ts
git commit -m "feat(memory): add remember tool handler for explicit fact saves"
```

---

## Task 8: Chat commands (`/memory list|show|forget`)

**Files:**
- Create: `src/memory/shared/commands.ts`
- Test: `src/memory/shared/__tests__/commands.test.ts`
- Modify: `src/chat-commands.ts` — add parsing + dispatch

- [ ] **Step 1: Write the failing test**

```typescript
// src/memory/shared/__tests__/commands.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleMemoryCommand } from '../commands.js';
import { writeFact } from '../store.js';
import { ensureMemoryDirs, factPath } from '../paths.js';

describe('memory commands', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cmd-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
  });

  it('lists facts', () => {
    writeFact({
      slug: 'feedback_terse',
      frontmatter: {
        name: 'Prefers terse',
        description: 'd',
        type: 'feedback',
        count: 3,
        first_seen: '2026-04-01',
        last_seen: '2026-04-15',
        sources: { tg: 3 },
      },
      body: 'b',
    });
    const out = handleMemoryCommand({ action: 'list' });
    expect(out).toContain('Prefers terse');
    expect(out).toContain('feedback_terse');
  });

  it('shows a specific fact body', () => {
    writeFact({
      slug: 'feedback_terse',
      frontmatter: {
        name: 'Prefers terse',
        description: 'd',
        type: 'feedback',
        count: 1,
        first_seen: '2026-04-01',
        last_seen: '2026-04-01',
        sources: { tg: 1 },
      },
      body: 'Body of the fact.',
    });
    const out = handleMemoryCommand({ action: 'show', slug: 'feedback_terse' });
    expect(out).toContain('Body of the fact.');
    expect(out).toContain('count: 1');
  });

  it('returns helpful message when fact does not exist for show', () => {
    const out = handleMemoryCommand({ action: 'show', slug: 'nope' });
    expect(out).toMatch(/not found/i);
  });

  it('forgets (archives) a fact', () => {
    writeFact({
      slug: 'feedback_x',
      frontmatter: {
        name: 'x',
        description: 'd',
        type: 'feedback',
        count: 1,
        first_seen: '2026-04-01',
        last_seen: '2026-04-01',
        sources: { tg: 1 },
      },
      body: 'b',
    });
    const out = handleMemoryCommand({ action: 'forget', slug: 'feedback_x' });
    expect(out).toMatch(/archived/i);
    expect(fs.existsSync(factPath('feedback_x'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/shared/__tests__/commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/memory/shared/commands.ts`**

```typescript
// src/memory/shared/commands.ts
import { listFacts, readFact, archiveFact } from './store.js';
import yaml from 'js-yaml';

export type MemoryCommand =
  | { action: 'list' }
  | { action: 'show'; slug: string }
  | { action: 'forget'; slug: string };

/** Parse `/memory ...` or `memory ...` into a MemoryCommand. Returns null if not a memory command. */
export function parseMemoryCommand(text: string): MemoryCommand | null {
  const t = text.trim().replace(/^\//, '');
  const parts = t.split(/\s+/);
  if (parts[0]?.toLowerCase() !== 'memory') return null;
  const action = parts[1]?.toLowerCase();
  if (action === 'list') return { action: 'list' };
  if (action === 'show' && parts[2]) return { action: 'show', slug: parts[2] };
  if (action === 'forget' && parts[2]) return { action: 'forget', slug: parts[2] };
  return null;
}

export function handleMemoryCommand(cmd: MemoryCommand): string {
  switch (cmd.action) {
    case 'list': {
      const facts = listFacts();
      if (facts.length === 0) return '_No memory yet._';
      const lines = facts.map(
        (f) =>
          `• *${f.frontmatter.name}* (${f.slug}) — count ${f.frontmatter.count}, last seen ${f.frontmatter.last_seen}`,
      );
      return `*Shared memory* (${facts.length} fact${facts.length === 1 ? '' : 's'})\n${lines.join('\n')}`;
    }
    case 'show': {
      const f = readFact(cmd.slug);
      if (!f) return `_Fact not found: ${cmd.slug}_`;
      const front = yaml.dump(f.frontmatter, { lineWidth: 100 }).trimEnd();
      return `*${f.frontmatter.name}*\n\`\`\`\n${front}\n\`\`\`\n${f.body}`;
    }
    case 'forget': {
      const ok = archiveFact(cmd.slug);
      return ok ? `_Archived: ${cmd.slug}_` : `_Fact not found: ${cmd.slug}_`;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/memory/shared/__tests__/commands.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire `/memory ...` into `src/chat-commands.ts`**

Read [src/chat-commands.ts](../../../src/chat-commands.ts). After the existing `parseCommand` function, before the existing handler, add memory parsing:

In the import section at the top:

```typescript
import {
  parseMemoryCommand,
  handleMemoryCommand,
  type MemoryCommand,
} from './memory/shared/commands.js';
```

In the `ChatCommand` union (around line 25), add:

```typescript
export type ChatCommand =
  | ConfigListCommand
  | ConfigSetCommand
  | ConfigResetCommand
  | SmokeTestCommand
  | (MemoryCommand & { type: 'memory' });
```

In `parseCommand` (around line 31), before the `config`-specific block, add:

```typescript
  const mem = parseMemoryCommand(trimmed);
  if (mem) return { type: 'memory', ...mem };
```

Add a new exported handler near `handleConfigCommand`:

```typescript
export function handleMemoryChatCommand(cmd: ChatCommand): string {
  if (cmd.type !== 'memory') return '';
  // strip the discriminator before passing to inner handler
  const { type: _t, ...inner } = cmd;
  return handleMemoryCommand(inner as MemoryCommand);
}
```

- [ ] **Step 6: Verify typecheck and tests still pass**

```bash
npx tsc --noEmit
npx vitest run src/memory/shared/__tests__/commands.test.ts src/__tests__/chat-commands.test.ts
```

Expected: PASS for both.

- [ ] **Step 7: Commit**

```bash
git add src/memory/shared/commands.ts src/memory/shared/__tests__/commands.test.ts src/chat-commands.ts
git commit -m "feat(memory): add /memory list|show|forget chat commands"
```

---

## Task 9: Orchestrator wiring

**Files:**
- Modify: `src/env.ts` — add kill-switch env vars
- Modify: `src/index.ts` — register extractor + verifier; emit `turn.completed`
- Modify: `src/container-runner.ts` — ensure `groups/global/memory/` exists, regenerate index before each container start

- [ ] **Step 1: Add env vars to `src/env.ts`**

Read [src/env.ts](../../../src/env.ts). Add to whichever schema/object exports env keys:

```typescript
NANOCLAW_MEMORY_EXTRACT: process.env.NANOCLAW_MEMORY_EXTRACT ?? '1',
NANOCLAW_MEMORY_VERIFY: process.env.NANOCLAW_MEMORY_VERIFY ?? '1',
NANOCLAW_MEMORY_DIR: process.env.NANOCLAW_MEMORY_DIR, // optional override
```

If `env.ts` uses a strict schema (e.g. zod), add the keys with sensible defaults (`'1'` strings). The kill-switch convention used elsewhere in the file: `'0'` disables.

- [ ] **Step 2: Wire extractor in `src/index.ts`**

Read [src/index.ts](../../../src/index.ts) to find:
1. Where `eventBus` is imported (probably already is).
2. Where the agent reply is sent back to the user (this is the natural place to emit `turn.completed`).
3. Where startup-time event subscriptions are registered.

Add at startup (near other `eventBus.on(...)` registrations):

```typescript
import { extractCandidates } from './memory/shared/extractor.js';
import { runVerifierSweep } from './memory/shared/verifier.js';
import { regenerateIndex } from './memory/shared/store.js';
import { ensureMemoryDirs } from './memory/shared/paths.js';

// On startup
ensureMemoryDirs();
regenerateIndex(); // ensure MEMORY.md exists before first container starts

eventBus.on('turn.completed', (event) => {
  // Fire-and-forget; failures are logged inside extractCandidates
  void extractCandidates({
    groupName: event.payload.groupName,
    userMessage: event.payload.userMessage,
    agentReply: event.payload.agentReply,
  });
});

// Periodic verifier sweep (every 5 min)
const verifierInterval = setInterval(
  () => {
    void runVerifierSweep();
  },
  5 * 60 * 1000,
);
// Clean up on shutdown:
process.on('SIGTERM', () => clearInterval(verifierInterval));
process.on('SIGINT', () => clearInterval(verifierInterval));
```

After the agent reply is dispatched to the user (find the call site by searching for `'message.outbound'` emission or the location where the agent's text is forwarded to the channel), add:

```typescript
eventBus.emit('turn.completed', {
  type: 'turn.completed',
  source: 'orchestrator',
  groupId: group.id, // use whatever local variable holds the group id
  timestamp: Date.now(),
  payload: {
    groupName: group.folder, // e.g. "telegram_main"
    userMessage,             // local variable holding the inbound user text
    agentReply,              // local variable holding the agent's reply text
    durationMs: Date.now() - startedAt,
  },
});
```

If the exact local variable names differ, substitute the equivalent. The contract: the event must carry the user message, the agent reply, and the group folder name.

- [ ] **Step 3: Wire `container-runner.ts`**

Read [src/container-runner.ts:147-154](../../../src/container-runner.ts) (where `globalDir` mount is set up). Just before the `mounts.push` for the global directory (in both the `main` branch around line 147 and the non-main branch around line 165), add a call to ensure the memory subdir exists and regenerate the index:

```typescript
// At the top of the function, ensure shared memory store is initialized.
import { ensureMemoryDirs } from './memory/shared/paths.js';
import { regenerateIndex } from './memory/shared/store.js';

// ... inside the function, before mount setup:
try {
  ensureMemoryDirs();
  regenerateIndex();
} catch (err) {
  logger.warn(
    { err: err instanceof Error ? err.message : String(err) },
    'shared memory init failed (continuing without it)',
  );
}
```

This ensures:
1. `groups/global/memory/` always exists when a container starts.
2. The mounted `MEMORY.md` is fresh (in case promotions happened since last container start).

- [ ] **Step 4: Wire the `remember` MCP tool**

Find the existing MCP tool registration site by searching for the `send_message` tool registration:

```bash
grep -rn "send_message" src/ --include="*.ts" | grep -i "tool\|mcp\|register" | head
```

In the same registration flow, add a new tool:

```typescript
import { rememberTool } from './memory/shared/remember-tool.js';

// register tool with the same shape used by send_message:
{
  name: 'remember',
  description: 'Save a durable fact to shared cross-group memory. Use sparingly for facts that should persist across conversations and groups.',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['user', 'feedback', 'project', 'reference'],
        description: 'Fact category',
      },
      name: { type: 'string', description: 'Short title (under 60 chars)' },
      body: { type: 'string', description: '1-3 paragraphs explaining the fact' },
      description: { type: 'string', description: 'One-line summary for the index (defaults to name)' },
      scopes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional scope tags: personal, chat, coding, research, work:whoisxml, etc.',
      },
    },
    required: ['type', 'name', 'body'],
  },
  handler: async (args, ctx) => {
    const result = await rememberTool({
      groupName: ctx.groupFolder, // however groupFolder is exposed by the tool ctx
      type: args.type,
      name: args.name,
      body: args.body,
      description: args.description,
      scopes: args.scopes,
    });
    return { content: [{ type: 'text', text: `Saved candidate: ${result.slug}` }] };
  },
}
```

The exact registration shape will match the existing `send_message` registration; mirror it.

- [ ] **Step 5: Typecheck and run unit tests**

```bash
npx tsc --noEmit
npx vitest run src/memory/shared/__tests__/
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/env.ts src/index.ts src/container-runner.ts
git commit -m "feat(memory): wire extractor, verifier, and remember tool into orchestrator"
```

---

## Task 10: Integration test (end-to-end flow)

**Files:**
- Create: `src/memory/shared/__tests__/flow.integration.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// src/memory/shared/__tests__/flow.integration.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractCandidates } from '../extractor.js';
import { runVerifierSweep } from '../verifier.js';
import { listFacts } from '../store.js';
import {
  ensureMemoryDirs,
  candidateDir,
  indexPath,
} from '../paths.js';

vi.mock('../../../llm/utility.js', () => ({
  resolveUtilityModel: vi.fn(() => ({ id: 'mock' })),
}));

vi.mock('ai', () => {
  const generateText = vi.fn();
  return { generateText };
});

describe('memory flow integration', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-flow-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
    vi.clearAllMocks();
  });

  it('end-to-end: turn → extractor → candidate → verifier → promoted fact → indexed', async () => {
    const { generateText } = await import('ai');
    const mock = generateText as unknown as ReturnType<typeof vi.fn>;

    // First call: extractor returns one candidate
    mock.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [
          {
            type: 'feedback',
            name: 'Prefers terse responses',
            description: 'short answers without preamble',
            body: 'User prefers terse responses with no preamble.',
            scopes: ['chat'],
            proposed_action: 'create',
            confidence: 0.9,
          },
        ],
      }),
    });

    // Second call: verifier passes it
    mock.mockResolvedValueOnce({
      text: JSON.stringify({ verdict: 'pass', reason: 'durable preference' }),
    });

    await extractCandidates({
      groupName: 'telegram_main',
      userMessage: 'Be terse from now on, please skip the preamble.',
      agentReply: 'Got it, I will keep replies short.',
    });

    expect(fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md'))).toHaveLength(1);

    await runVerifierSweep();

    const facts = listFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].slug).toBe('feedback_prefers_terse_responses');
    expect(facts[0].frontmatter.count).toBe(1);
    expect(facts[0].frontmatter.sources).toEqual({ telegram_main: 1 });

    const index = fs.readFileSync(indexPath(), 'utf8');
    expect(index).toContain('Prefers terse responses');
    expect(index).toContain('feedback_prefers_terse_responses.md');

    expect(fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md'))).toHaveLength(0);
  });

  it('reinforcement from a second group merges and updates count + sources', async () => {
    const { generateText } = await import('ai');
    const mock = generateText as unknown as ReturnType<typeof vi.fn>;

    // Round 1
    mock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          candidates: [
            {
              type: 'feedback',
              name: 'Prefers terse responses',
              description: 'd',
              body: 'User prefers terse.',
              proposed_action: 'create',
              confidence: 0.9,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ verdict: 'pass', reason: 'r' }),
      });

    await extractCandidates({
      groupName: 'telegram_main',
      userMessage: 'be terse from now on',
      agentReply: 'OK',
    });
    await runVerifierSweep();

    // Round 2: same fact name, different group, propose merge by name collision
    mock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          candidates: [
            {
              type: 'feedback',
              name: 'Prefers terse responses',
              description: 'd',
              body: 'Reinforced — short answers preferred.',
              proposed_action: 'create',
              confidence: 0.85,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ verdict: 'pass', reason: 'r' }),
      });

    await extractCandidates({
      groupName: 'whatsapp_personal',
      userMessage: 'please keep it short going forward',
      agentReply: 'Will do.',
    });
    await runVerifierSweep();

    const facts = listFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].frontmatter.count).toBe(2);
    expect(facts[0].frontmatter.sources).toEqual({
      telegram_main: 1,
      whatsapp_personal: 1,
    });
    expect(facts[0].body).toContain('Reinforced');
    expect(facts[0].frontmatter.history?.[0]).toContain('User prefers terse.');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/memory/shared/__tests__/flow.integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit**

```bash
git add src/memory/shared/__tests__/flow.integration.test.ts
git commit -m "test(memory): end-to-end integration test for extract→verify→promote flow"
```

---

## Task 11: CC compatibility documentation

**Files:**
- Create: `docs/memory-cc-compat.md`

- [ ] **Step 1: Write the doc**

```markdown
# Cross-group memory ↔ Claude Code compatibility

NanoClaw's shared memory store at `groups/global/memory/` uses the same
file format as Claude Code's auto-memory feature. This means you can mount
NanoClaw's memory into your laptop CC sessions (or vice versa) for "one
shared brain."

## Current state

- NanoClaw containers see `groups/global/memory/` mounted at
  `/workspace/global/memory/`. The agent reads `MEMORY.md` automatically
  via `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.
- All writes to the store happen host-side via the extractor, the
  verifier, and the `remember` MCP tool. Containers never write the store
  directly.

## File format

Each fact is a markdown file with YAML frontmatter:

\`\`\`markdown
---
name: <short title>
description: <one-line summary>
type: user | feedback | project | reference
scopes: [optional, scope, tags]
count: <int>
first_seen: <ISO date>
last_seen: <ISO date>
last_value: <optional>
sources: { <groupName>: <count>, ... }
history: [<prior bodies, newest first, capped at 5>]
---

<body — 1-3 paragraphs>
\`\`\`

This matches CC's auto-memory expectations. CC ignores fields it does not
recognize (`count`, `sources`, etc.) and uses `name`, `description`,
`type`, and the body.

## Mounting NanoClaw memory into CC

When you're ready to make NanoClaw and CC share one store, add the path
to your CC settings. In `~/.claude/settings.json`:

\`\`\`json
{
  "additionalDirectories": [
    "/path/to/nanoclaw/groups/global/memory"
  ]
}
\`\`\`

CC will load `MEMORY.md` from that directory in addition to its own
auto-memory.

## Mounting CC memory into NanoClaw containers

To go the other direction (NanoClaw containers see CC's auto-memory),
change the mount source in `src/container-runner.ts`. Find the block that
mounts `groups/global/`:

\`\`\`typescript
const globalDir = path.join(GROUPS_DIR, 'global');
\`\`\`

Add a second mount for the host CC memory dir:

\`\`\`typescript
const ccMemDir = path.join(
  os.homedir(),
  '.claude/projects/-Users-<you>-dev-nanoclaw/memory',
);
if (fs.existsSync(ccMemDir)) {
  mounts.push({
    hostPath: ccMemDir,
    containerPath: '/workspace/cc-memory',
    readonly: true,
  });
}
\`\`\`

Then enable CC inside the container to read it via the same
`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` mechanism.

## Reconciliation

Both stores can drift independently. To reconcile (e.g. before enabling
the cross-mount), copy or symlink one into the other and let the verifier
dedupe by name collision on its next sweep.
\`\`\`
```

- [ ] **Step 2: Commit**

```bash
git add docs/memory-cc-compat.md
git commit -m "docs(memory): document Claude Code auto-memory compatibility"
```

---

## Task 12: Manual smoke verification

This task is a manual checklist, not automated. Run after Task 9 lands and the service is restarted.

- [ ] **Step 1: Restart the NanoClaw service**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 2: Verify memory dir is created**

```bash
ls -la groups/global/memory/
```

Expected: directory exists with at least `MEMORY.md` (may be just the preamble) and `candidate/` subdir.

- [ ] **Step 3: Trigger extraction from `telegram_main`**

Send to the Telegram group: "From now on, please be terse — no preamble, no trailing summary."

Wait ~30s. Check:

```bash
ls groups/global/memory/candidate/
```

Expected: at least one `.md` file appears within 30s.

- [ ] **Step 4: Wait for verifier sweep (≤5 min) or trigger manually**

If you don't want to wait, restart the service or expose a debug endpoint to call `runVerifierSweep()` directly. After the sweep:

```bash
ls groups/global/memory/
cat groups/global/memory/MEMORY.md
```

Expected: a `feedback_*.md` file exists; `MEMORY.md` references it.

- [ ] **Step 5: Cross-group verification**

From a different group (Slack, Discord, or any group whose container restarted after Step 4), ask: "How long should your replies be by default?"

Expected: agent acknowledges the terse preference without being told in this group.

- [ ] **Step 6: Verify chat commands**

In any group, send: `/memory list`. Expected: list includes the terse-preference fact.

Send: `/memory show feedback_prefers_terse_responses` (or whatever the slug is). Expected: full body + frontmatter.

- [ ] **Step 7: Document any deviations**

If anything didn't behave as expected, append a note to `docs/memory-cc-compat.md` under a new "Known issues" section.

---

## Task 13: Phase 2/3 rollout config

This task does not change code — it documents the env-var sequence for the rollout phases described in the spec.

- [ ] **Step 1: Phase 1 (infra-only) — both kill switches off**

Set in the launchd plist or systemd unit:

```
NANOCLAW_MEMORY_EXTRACT=0
NANOCLAW_MEMORY_VERIFY=0
```

Restart the service. Verify `/memory list` returns "_No memory yet._" and no candidates accumulate.

- [ ] **Step 2: Phase 2 (single-group pilot) — both on, but pilot in `telegram_main` only**

Remove the kill switches:

```
NANOCLAW_MEMORY_EXTRACT=1
NANOCLAW_MEMORY_VERIFY=1
```

(Note: the v1 design does not implement per-group extraction toggling. To pilot in `telegram_main` only without code changes, restrict your real conversations to that group during the pilot window.)

Run for ~3 days. Inspect `groups/global/memory/.audit.log` daily:

```bash
tail -f groups/global/memory/.audit.log | jq .
```

Tune if rejection rate exceeds 30% (revisit extractor/verifier prompts) or extraction rate is < 1 candidate/day (loosen `isTrivialTurn` threshold).

- [ ] **Step 3: Phase 3 (all groups) — no config change**

Resume normal use across all groups. Monitor `.audit.log` for week 1.

- [ ] **Step 4: Document rollout outcomes**

After 2 weeks, append a brief summary to `docs/memory-cc-compat.md` under "Rollout notes" with: facts promoted, rejection rate, observed cross-group benefit, any tuning applied.

---

## Self-review checklist (executor)

Before declaring the plan complete, run:

```bash
# Full test suite touching shared memory
npx vitest run src/memory/shared/

# Typecheck
npx tsc --noEmit

# Lint (if configured)
npm run lint --if-present
```

Expected: all green.
