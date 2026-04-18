# Qdrant Vector Memory & Teach Mode Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing Qdrant vector memory code into production paths (store + query), and complete the teach mode loop so procedures are injected into agent context at query time.

**Architecture:** Two independent subsystems. Qdrant memory upgrades the existing FTS5 knowledge store with optional semantic search — the agent's `learn_feedback` IPC already stores facts via `storeFact()`; we upgrade it to call `storeFactWithVector()` when `QDRANT_URL` is set, and add a `search_memory` tool the agent can call for semantic recall. Teach mode is already 90% wired — we just need to inject matched procedure context into the agent's system prompt before invocation, and add a `learn_fact` IPC type so the agent can explicitly store knowledge.

**Tech Stack:** TypeScript, `@qdrant/js-client-rest`, AI SDK `embed()`, Vitest, Docker Compose

---

### Task 1: Export Qdrant functions and add collection initialization

**Files:**
- Modify: `src/memory/index.ts` (add exports)
- Modify: `src/memory/knowledge-store.ts` (add `ensureQdrantCollection`)

- [ ] **Step 1: Write the failing test**

Add to `src/memory/knowledge-store.test.ts`:

```typescript
import {
  storeFactWithVector,
  queryFactsSemantic,
  ensureQdrantCollection,
} from './knowledge-store.js';

describe('ensureQdrantCollection', () => {
  it('is a callable function', () => {
    expect(typeof ensureQdrantCollection).toBe('function');
  });

  it('succeeds silently when QDRANT_URL is not set', async () => {
    // QDRANT_URL is empty in test env, so this should be a no-op
    await expect(ensureQdrantCollection()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/memory/knowledge-store.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `ensureQdrantCollection` not exported

- [ ] **Step 3: Implement `ensureQdrantCollection` and update exports**

In `src/memory/knowledge-store.ts`, add after `getQdrant()`:

```typescript
/**
 * Ensure the Qdrant collection exists with correct vector config.
 * No-op if QDRANT_URL is not set. Safe to call multiple times.
 */
export async function ensureQdrantCollection(): Promise<void> {
  const client = getQdrant();
  if (!client) return;

  try {
    const exists = await client.collectionExists(COLLECTION_NAME);
    if (exists.exists) return;

    await client.createCollection(COLLECTION_NAME, {
      vectors: { size: 1536, distance: 'Cosine' },
    });
    logger.info({ collection: COLLECTION_NAME }, 'Qdrant collection created');
  } catch (err) {
    logger.warn({ err }, 'Qdrant collection init failed (non-fatal)');
  }
}
```

In `src/memory/index.ts`, add to the knowledge-store exports:

```typescript
export {
  initKnowledgeStore,
  storeFact,
  storeFactWithVector,
  queryFacts,
  queryFactsSemantic,
  ensureQdrantCollection,
  deleteFact,
  getAllFacts,
} from './knowledge-store.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/memory/knowledge-store.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/knowledge-store.ts src/memory/index.ts src/memory/knowledge-store.test.ts
git commit -m "feat(memory): export Qdrant functions and add collection initialization"
```

---

### Task 2: Call `ensureQdrantCollection` at startup

**Files:**
- Modify: `src/index.ts` (add collection init call during startup)

- [ ] **Step 1: Find the startup sequence**

In `src/index.ts`, locate where `initKnowledgeStore()` is called. The Qdrant collection init should be called right after it.

- [ ] **Step 2: Add the call**

After the `initKnowledgeStore()` call in the startup sequence, add:

```typescript
import { ensureQdrantCollection } from './memory/knowledge-store.js';
```

And in the startup function, after `initKnowledgeStore()`:

```typescript
// Initialize Qdrant collection if configured (non-blocking, non-fatal)
ensureQdrantCollection().catch((err) =>
  logger.warn({ err }, 'Qdrant collection init failed'),
);
```

- [ ] **Step 3: Build to verify no type errors**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(memory): init Qdrant collection at startup when QDRANT_URL set"
```

---

### Task 3: Add `learn_fact` IPC type and upgrade storage path

**Files:**
- Modify: `src/ipc.ts` (add `learn_fact` case that calls `storeFactWithVector`)
- Modify: `container/agent-runner/src/tool-bridge.ts` (add `learn_fact` tool)

- [ ] **Step 1: Write the agent-side tool**

In `container/agent-runner/src/tool-bridge.ts`, add a `learn_fact` tool alongside the existing `learn_feedback` tool:

```typescript
learn_fact: {
  description: 'Store a fact in long-term memory for future recall. Use for important information worth remembering across sessions.',
  parameters: z.object({
    text: z.string().describe('The fact to remember'),
    domain: z.string().optional().describe('Category: preferences, contacts, workflows, general'),
    source: z.string().optional().describe('Where this fact came from'),
  }),
  execute: async ({ text, domain, source }: { text: string; domain?: string; source?: string }) => {
    writeIpcFile(messagesDir, {
      type: 'learn_fact',
      chatJid,
      groupFolder,
      text,
      domain: domain ?? 'general',
      source: source ?? 'agent',
    });
    return { success: true, stored: text.slice(0, 80) };
  },
},
```

No trust check needed — storing facts is always safe.

- [ ] **Step 2: Add the host-side IPC handler**

In `src/ipc.ts`, add a case for `learn_fact` in the IPC task switch:

```typescript
case 'learn_fact': {
  const { storeFactWithVector } = await import('./memory/knowledge-store.js');
  const text = task.text as string;
  const domain = (task.domain as string) || 'general';
  const source = (task.source as string) || 'agent';
  const groupFolder = task.groupFolder as string;

  await storeFactWithVector({
    text,
    domain,
    groupId: groupFolder,
    source,
  });
  logger.info({ domain, groupFolder, textLen: text.length }, 'Fact stored via IPC');
  break;
}
```

- [ ] **Step 3: Build to verify no type errors**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/ipc.ts container/agent-runner/src/tool-bridge.ts
git commit -m "feat(memory): add learn_fact IPC type with Qdrant vector storage"
```

---

### Task 4: Add `search_memory` IPC tool for semantic recall

**Files:**
- Modify: `container/agent-runner/src/tool-bridge.ts` (add `search_memory` tool)
- Modify: `src/ipc.ts` (add `search_memory` IPC handler with response)

- [ ] **Step 1: Add the agent-side tool**

In `container/agent-runner/src/tool-bridge.ts`, add:

```typescript
search_memory: {
  description: 'Search long-term memory for relevant facts. Uses semantic search when available, falls back to keyword search.',
  parameters: z.object({
    query: z.string().describe('What to search for'),
    domain: z.string().optional().describe('Filter by domain'),
    limit: z.number().optional().describe('Max results (default 5)'),
  }),
  execute: async ({ query, domain, limit }: { query: string; domain?: string; limit?: number }) => {
    writeIpcFile(messagesDir, {
      type: 'search_memory',
      chatJid,
      groupFolder,
      query,
      domain,
      limit: limit ?? 5,
    });
    // IPC is fire-and-forget; the result comes back as a synthetic message.
    // For now, return acknowledgment. Future: use synchronous IPC.
    return { success: true, note: 'Memory search submitted. Results will appear in context if found.' };
  },
},
```

- [ ] **Step 2: Add the host-side IPC handler**

In `src/ipc.ts`, add a case for `search_memory`:

```typescript
case 'search_memory': {
  const { queryFactsSemantic } = await import('./memory/knowledge-store.js');
  const query = task.query as string;
  const domain = task.domain as string | undefined;
  const limit = (task.limit as number) || 5;
  const groupFolder = task.groupFolder as string;

  const facts = await queryFactsSemantic(query, { domain, groupId: groupFolder, limit });
  if (facts.length > 0) {
    const formatted = facts.map((f) => `• ${f.text} [${f.domain}]`).join('\n');
    logger.info({ query, resultCount: facts.length, groupFolder }, 'Memory search results');
    // Write results back as a context injection file the agent can read
    const contextDir = path.join(GROUPS_DIR, groupFolder, 'context');
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(
      path.join(contextDir, 'memory-results.txt'),
      `Memory recall for "${query}":\n${formatted}\n`,
      'utf-8',
    );
  }
  break;
}
```

- [ ] **Step 3: Build to verify no type errors**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/ipc.ts container/agent-runner/src/tool-bridge.ts
git commit -m "feat(memory): add search_memory IPC tool with semantic recall"
```

---

### Task 5: Add docker-compose for Qdrant

**Files:**
- Create: `docker-compose.qdrant.yml`

- [ ] **Step 1: Create the compose file**

```yaml
# Optional Qdrant service for semantic vector memory.
# Start with: docker compose -f docker-compose.qdrant.yml up -d
# Then set QDRANT_URL=http://localhost:6333 in your .env
version: '3.8'

services:
  qdrant:
    image: qdrant/qdrant:v1.14.0
    container_name: nanoclaw-qdrant
    ports:
      - '6333:6333'  # REST API
      - '6334:6334'  # gRPC
    volumes:
      - qdrant_data:/qdrant/storage
    environment:
      - QDRANT__SERVICE__GRPC_PORT=6334
    restart: unless-stopped

volumes:
  qdrant_data:
```

- [ ] **Step 2: Verify it parses correctly**

Run: `cd /Users/topcoder1/dev/nanoclaw && docker compose -f docker-compose.qdrant.yml config 2>&1 | head -20`
Expected: Valid YAML output showing the service config

- [ ] **Step 3: Commit**

```bash
git add docker-compose.qdrant.yml
git commit -m "infra: add docker-compose for optional Qdrant vector memory"
```

---

### Task 6: Fix `queryFactsSemantic` groupId filter

**Files:**
- Modify: `src/memory/knowledge-store.ts` (add groupId to Qdrant filter)

- [ ] **Step 1: Write the failing test**

Add to `src/memory/knowledge-store.test.ts`:

```typescript
describe('queryFactsSemantic groupId filter', () => {
  it('passes groupId filter to FTS5 fallback when Qdrant unavailable', async () => {
    storeFact({ text: 'Alpha fact for group A', source: 'test', groupId: 'group-a' });
    storeFact({ text: 'Alpha fact for group B', source: 'test', groupId: 'group-b' });

    const results = await queryFactsSemantic('Alpha fact', { groupId: 'group-a' });
    expect(results.every((f) => f.group_id === 'group-a')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (FTS5 fallback already supports groupId)**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/memory/knowledge-store.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS (the FTS5 fallback path already handles groupId)

- [ ] **Step 3: Fix the Qdrant filter to include groupId**

In `src/memory/knowledge-store.ts`, update the `queryFactsSemantic` function's Qdrant filter:

```typescript
const filterConditions: Array<{ key: string; match: { value: string } }> = [];
if (opts?.domain) {
  filterConditions.push({ key: 'domain', match: { value: opts.domain } });
}
if (opts?.groupId) {
  filterConditions.push({ key: 'group_id', match: { value: opts.groupId } });
}

const results = await client.search(COLLECTION_NAME, {
  vector,
  limit: opts?.limit ?? 10,
  filter: filterConditions.length > 0
    ? { must: filterConditions }
    : undefined,
});
```

- [ ] **Step 4: Fix fake rowids — use UUID-based ID from Qdrant**

Replace the results mapping:

```typescript
return results.map((r: any) => ({
  rowid: typeof r.id === 'number' ? r.id : 0,
  text: (r.payload as Record<string, string>).text,
  domain: (r.payload as Record<string, string>).domain,
  group_id: (r.payload as Record<string, string>).group_id,
  source: (r.payload as Record<string, string>).source,
  created_at: (r.payload as Record<string, string>).created_at,
}));
```

- [ ] **Step 5: Build to verify no type errors**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 6: Run all knowledge store tests**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/memory/knowledge-store.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/memory/knowledge-store.ts src/memory/knowledge-store.test.ts
git commit -m "fix(memory): add groupId filter to Qdrant search and fix fake rowids"
```

---

### Task 7: Inject matched procedure context into agent system prompt

**Files:**
- Modify: `src/index.ts` (inject procedure hints into the agent prompt)

- [ ] **Step 1: Understand current flow**

In `src/index.ts`, `processGroupMessages` calls `handleMessageWithProcedureCheck()` which returns `true` if a procedure matched (and either auto-executes or sends an offer message). If it returns `false`, the normal `runAgent()` path runs.

The gap: when a procedure matches but ISN'T auto-execute, the user gets an offer but the agent doesn't know about the procedure. Also, partial matches (fuzzy) are never surfaced.

- [ ] **Step 2: Add procedure context injection to `runAgent`**

In `src/index.ts`, find the `runAgent` function. Before the container is spawned, look up relevant procedures and add them to the prompt:

```typescript
// Inside runAgent, before container invocation:
const { listProcedures } = await import('./memory/procedure-store.js');
const groupProcs = listProcedures(group.folder);

let procedureContext = '';
if (groupProcs.length > 0) {
  const relevant = groupProcs
    .filter((p) => p.success_count > 0)
    .sort((a, b) => b.success_count - a.success_count)
    .slice(0, 5);

  if (relevant.length > 0) {
    procedureContext = '\n\n<learned_procedures>\n' +
      relevant.map((p) =>
        `- "${p.trigger}": ${p.description || p.steps.map(s => s.action).join(' → ')} (${p.success_count} successes)`
      ).join('\n') +
      '\n</learned_procedures>';
  }
}
```

Then append `procedureContext` to the system prompt or CLAUDE.md content that gets mounted into the container.

- [ ] **Step 3: Write procedure context to the group's context directory**

Instead of modifying the prompt string (which is complex), write procedure context to a file the agent reads:

```typescript
if (procedureContext) {
  const contextDir = path.join(GROUPS_DIR, group.folder, 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(
    path.join(contextDir, 'procedures.txt'),
    procedureContext,
    'utf-8',
  );
}
```

The container's CLAUDE.md can reference `context/procedures.txt` if it exists.

- [ ] **Step 4: Build to verify no type errors**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(learning): inject learned procedures into agent context"
```

---

### Task 8: Scope teach command to current group

**Files:**
- Modify: `src/memory/cost-dashboard.ts` (accept groupId in teach handler)
- Modify: `src/index.ts` (pass groupId when executing assistant command)

- [ ] **Step 1: Update `handleTeachCommand` to accept groupId**

In `src/memory/cost-dashboard.ts`, change the function signature:

```typescript
function handleTeachCommand(description: string, groupId?: string): string {
```

And pass `groupId` to `saveProcedure`:

```typescript
saveProcedure({
  name,
  trigger,
  description,
  steps,
  success_count: 0,
  failure_count: 0,
  auto_execute: false,
  created_at: now,
  updated_at: now,
  groupId,   // <-- add this
});
```

- [ ] **Step 2: Update `executeAssistantCommand` signature**

```typescript
export function executeAssistantCommand(command: AssistantCommand, groupId?: string): string {
  switch (command.type) {
    case 'cost_report':
      return formatCostReport(command.days);
    case 'teach':
      return handleTeachCommand(command.description, groupId);
  }
}
```

- [ ] **Step 3: Update the call site in `src/index.ts`**

Find where `executeAssistantCommand(assistantCmd)` is called and pass the group folder:

```typescript
const response = executeAssistantCommand(assistantCmd, group.folder);
```

- [ ] **Step 4: Build to verify no type errors**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 5: Update the test**

In `src/memory/cost-dashboard.test.ts`, update the teach test to verify groupId is passed:

```typescript
it('teaches a procedure scoped to a group', () => {
  const cmd = parseAssistantCommand('teach: check PR status');
  expect(cmd).toEqual({ type: 'teach', description: 'check PR status' });
  const result = executeAssistantCommand(cmd!, 'test-group');
  expect(result).toContain('Learned');
  // Verify it's retrievable by group
  const { findProcedure } = require('./procedure-store.js');
  const proc = findProcedure('check PR status', 'test-group');
  expect(proc).not.toBeNull();
});
```

- [ ] **Step 6: Run tests**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/memory/cost-dashboard.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/memory/cost-dashboard.ts src/memory/cost-dashboard.test.ts src/index.ts
git commit -m "feat(learning): scope teach command to current group"
```

---

### Task 9: Add `findProcedure` fuzzy matching

**Files:**
- Modify: `src/memory/procedure-store.ts` (add fuzzy trigger matching)
- Modify: `src/memory/procedure-store.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/memory/procedure-store.test.ts`:

```typescript
describe('fuzzy matching', () => {
  it('matches procedures by keyword overlap', () => {
    saveProcedure({
      name: 'check-pr-status',
      trigger: 'check PR status',
      description: 'Check GitHub PR status',
      steps: [{ action: 'github_api', details: 'list PRs' }],
      success_count: 3,
      failure_count: 0,
      auto_execute: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Exact match works
    expect(findProcedure('check PR status')).not.toBeNull();

    // Fuzzy match: subset of trigger words
    expect(findProcedure('check PR')).not.toBeNull();
    expect(findProcedure('PR status check')).not.toBeNull();

    // Non-match: no overlapping keywords
    expect(findProcedure('deploy to production')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/memory/procedure-store.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — fuzzy match returns null

- [ ] **Step 3: Implement fuzzy matching**

In `src/memory/procedure-store.ts`, update `findProcedure`:

```typescript
export function findProcedure(
  trigger: string,
  groupId?: string,
): Procedure | null {
  const normalizedTrigger = trigger.toLowerCase().trim();
  const triggerWords = normalizedTrigger.split(/\s+/).filter(Boolean);

  function scoreMatch(proc: Procedure): number {
    const procWords = proc.trigger.toLowerCase().trim().split(/\s+/).filter(Boolean);
    // Exact match
    if (proc.trigger.toLowerCase().trim() === normalizedTrigger) return 1.0;
    // Word overlap score
    const matchingWords = triggerWords.filter((w) => procWords.includes(w));
    if (matchingWords.length === 0) return 0;
    return matchingWords.length / Math.max(triggerWords.length, procWords.length);
  }

  const FUZZY_THRESHOLD = 0.5;
  let bestMatch: Procedure | null = null;
  let bestScore = 0;

  // Search group-specific first
  if (groupId) {
    for (const p of listProceduresFromDir(groupProceduresDir(groupId))) {
      const score = scoreMatch(p);
      if (score > bestScore && score >= FUZZY_THRESHOLD) {
        bestScore = score;
        bestMatch = p;
      }
    }
    if (bestMatch) return bestMatch;
  }

  // Then global
  for (const p of listProceduresFromDir(globalProceduresDir())) {
    const score = scoreMatch(p);
    if (score > bestScore && score >= FUZZY_THRESHOLD) {
      bestScore = score;
      bestMatch = p;
    }
  }

  return bestMatch;
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/memory/procedure-store.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/procedure-store.ts src/memory/procedure-store.test.ts
git commit -m "feat(learning): add fuzzy trigger matching for procedures"
```

---

### Task 10: Full integration test

**Files:**
- Run existing tests to verify nothing broke

- [ ] **Step 1: Run all memory tests**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/memory/ --reporter=verbose 2>&1 | tail -30`
Expected: All PASS

- [ ] **Step 2: Run all learning tests**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx vitest run src/learning/ --reporter=verbose 2>&1 | tail -30`
Expected: All PASS

- [ ] **Step 3: Run full build**

Run: `cd /Users/topcoder1/dev/nanoclaw && npm run build 2>&1 | tail -10`
Expected: Clean build

- [ ] **Step 4: Run full test suite**

Run: `cd /Users/topcoder1/dev/nanoclaw && npx vitest run --reporter=verbose 2>&1 | tail -40`
Expected: All PASS (or pre-existing failures only)

- [ ] **Step 5: Final commit if any fixups needed**

```bash
git add -A
git commit -m "test: verify Qdrant memory and teach mode integration"
```
