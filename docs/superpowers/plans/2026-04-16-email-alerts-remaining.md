# Email-Alert Session — Remaining Items Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the four deferred items from the "Reduce excessive email alert notifications" session: mini-app UX polish (reply/forward), WhatsApp `/setup` stale-entry auto-remediation, `OPENAI_API_KEY`-based semantic search, and browser-sidecar startup grace period.

**Architecture:** Four independent tracks. Tracks C and D are small and fully specified below (TDD). Tracks A and B are bigger — each begins with a required brainstorming step before writing code, because UX scope (A) and failure-mode classification (B) aren't yet locked down.

**Tech Stack:** TypeScript (Node), Express (mini-app), Playwright CDP (browser sidecar), Qdrant + OpenAI embeddings (semantic search), Baileys (WhatsApp), Docker Compose (sidecar).

---

## Scope Check (read before starting)

The four items live in independent subsystems:

| Track | Item | Subsystem | Est. effort |
|-------|------|-----------|-------------|
| A | 3.1 Mini-app reply/forward | `src/mini-app/` + Gmail MCP | ~1 day (design + build) |
| B | 3.2 WhatsApp stale-Chrome auto-remediate | `setup/` + `src/channels/whatsapp/` | ~3 hr |
| C | `OPENAI_API_KEY` → semantic search | `src/memory/knowledge-store.ts` + `src/llm/utility.ts` | ~2 hr |
| D | Browser sidecar startup grace | `src/container-runtime.ts` + `src/browser/playwright-client.ts` | ~1 hr |

**Recommended execution order:** D → C → B → A (smallest/lowest-risk first, biggest UX last).

**Do not bundle into one PR.** Ship each track as its own PR so revert blast-radius stays tiny.

---

## Track D — Browser Sidecar Startup Grace Period

**Problem:** First health check after `docker compose up -d` occasionally fails because the Chrome CDP port isn't listening yet. Subsequent checks pass. Current behavior is a one-time startup flake logged as an error.

**Files:**
- Modify: `src/container-runtime.ts:123-138` (`ensureBrowserSidecar`)
- Modify: `src/browser/playwright-client.ts:15-27` (`connect`)
- Test: `src/browser/playwright-client.test.ts` (create)

### Task D1: Add `waitForSidecarReady` helper

- [ ] **Step 1: Write the failing test**

```ts
// src/browser/playwright-client.test.ts
import { describe, it, expect, vi } from 'vitest';
import { waitForSidecarReady } from './playwright-client.js';

describe('waitForSidecarReady', () => {
  it('returns true once CDP /json/version responds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ Browser: 'Chromium/1' }) });
    const ok = await waitForSidecarReady('http://localhost:9222', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 5000,
      intervalMs: 50,
    });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns false on timeout', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const ok = await waitForSidecarReady('http://localhost:9222', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 200,
      intervalMs: 50,
    });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/browser/playwright-client.test.ts`
Expected: FAIL — `waitForSidecarReady` is not exported.

- [ ] **Step 3: Implement `waitForSidecarReady`**

Add to `src/browser/playwright-client.ts` (top of file, before the existing class):

```ts
export interface WaitOpts {
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}

export async function waitForSidecarReady(
  cdpUrl: string,
  opts: WaitOpts = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 250;
  const f = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  const url = cdpUrl.replace(/\/$/, '') + '/json/version';
  while (Date.now() < deadline) {
    try {
      const res = await f(url);
      if (res.ok) return true;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/browser/playwright-client.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/browser/playwright-client.ts src/browser/playwright-client.test.ts
git commit -m "feat(browser): add waitForSidecarReady with CDP poll"
```

### Task D2: Wire the grace period into `ensureBrowserSidecar`

- [ ] **Step 1: Modify `ensureBrowserSidecar`**

Replace `src/container-runtime.ts:123-138` with:

```ts
/** Start the browser sidecar via docker compose and wait for CDP to respond. */
export async function ensureBrowserSidecar(): Promise<void> {
  const composePath = path.join(process.cwd(), 'docker-compose.browser.yml');
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} compose -f ${composePath} up -d`, {
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch (err) {
    logger.error(
      { err },
      'Failed to start browser sidecar (non-fatal, continuing without it)',
    );
    return;
  }
  const { waitForSidecarReady } = await import('./browser/playwright-client.js');
  const cdpUrl = process.env.BROWSER_CDP_URL ?? 'http://localhost:9222';
  const ready = await waitForSidecarReady(cdpUrl, { timeoutMs: 15_000, intervalMs: 250 });
  if (ready) {
    logger.info('Browser sidecar started and CDP is ready');
  } else {
    logger.warn({ cdpUrl }, 'Browser sidecar started but CDP did not respond within 15s');
  }
}
```

- [ ] **Step 2: Update all callers to `await ensureBrowserSidecar()`**

Run: `grep -rn "ensureBrowserSidecar" src/`
For each caller, confirm it's in an `async` function and prefix the call with `await`. Commit only call-site changes that are actually sync→async conversions.

- [ ] **Step 3: Type-check and run full test suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 4: Manual smoke**

Run: `npm run dev` and confirm log sequence shows `Browser sidecar started and CDP is ready` on fresh start, and no `ECONNREFUSED` error on the first subsequent browser use.

- [ ] **Step 5: Commit**

```bash
git add src/container-runtime.ts src/
git commit -m "feat(browser): gate sidecar start on CDP readiness (eliminates first-use flake)"
```

---

## Track C — Enable Semantic Search via `OPENAI_API_KEY`

**Problem:** `src/memory/knowledge-store.ts` uses SQLite FTS5. `QdrantClient` is imported but unused. The "Add `OPENAI_API_KEY`" follow-up wants vector search available when the key is present, with FTS5 as the fallback.

**Scope guard:** Do NOT replace FTS5. Add a *parallel* semantic path that is used only when both (a) `OPENAI_API_KEY` is set and (b) Qdrant is reachable. Otherwise the existing FTS5 path is used.

**Files:**
- Modify: `src/memory/knowledge-store.ts` (add `queryFactsSemantic`, gate in `queryFacts`)
- Modify: `src/llm/utility.ts` (export a reusable `embedText(text)` helper)
- Test: `src/memory/knowledge-store.semantic.test.ts` (create)

### Task C1: Export `embedText` helper

- [ ] **Step 1: Read the current embed usage**

Run: `grep -n "embed(" src/llm/utility.ts`
Confirm the existing `embed(...)` call shape before adding the helper.

- [ ] **Step 2: Write the failing test**

```ts
// src/llm/utility.test.ts (append; create if missing)
import { describe, it, expect } from 'vitest';
import { embedText, isEmbeddingAvailable } from './utility.js';

describe('embedText', () => {
  it('returns null when OPENAI_API_KEY is unset', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(isEmbeddingAvailable()).toBe(false);
    const vec = await embedText('hello');
    expect(vec).toBeNull();
    if (prev) process.env.OPENAI_API_KEY = prev;
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/llm/utility.test.ts`
Expected: FAIL — imports are undefined.

- [ ] **Step 4: Implement `embedText` + `isEmbeddingAvailable`**

Append to `src/llm/utility.ts`:

```ts
export function isEmbeddingAvailable(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function embedText(text: string): Promise<number[] | null> {
  if (!isEmbeddingAvailable()) return null;
  const provider = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const result = await embed({
    model: provider.embedding('text-embedding-3-small'),
    value: text,
  });
  return result.embedding;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/llm/utility.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/llm/utility.ts src/llm/utility.test.ts
git commit -m "feat(llm): add embedText helper gated on OPENAI_API_KEY"
```

### Task C2: Wire semantic query path into `knowledge-store`

- [ ] **Step 1: Write the failing test**

```ts
// src/memory/knowledge-store.semantic.test.ts
import { describe, it, expect, vi } from 'vitest';
import { queryFacts } from './knowledge-store.js';

describe('queryFacts (semantic fallback)', () => {
  it('falls back to FTS5 when no OPENAI_API_KEY is set', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // Seed a fact via FTS5 path and expect it to be found.
    // ... (mirror existing FTS5 test setup if present)
    const results = await queryFacts('needle', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    if (prev) process.env.OPENAI_API_KEY = prev;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/knowledge-store.semantic.test.ts`
Expected: FAIL — `queryFacts` is currently synchronous and returns FTS5 rows only; the test requires an `async` signature.

- [ ] **Step 3: Refactor `queryFacts` to async with semantic branch**

In `src/memory/knowledge-store.ts`:

```ts
import { embedText, isEmbeddingAvailable } from '../llm/utility.js';

export async function queryFacts(q: string, opts: QueryFactsOpts = {}): Promise<Fact[]> {
  if (isEmbeddingAvailable()) {
    try {
      const vec = await embedText(q);
      if (vec) return await queryFactsSemantic(vec, opts);
    } catch (err) {
      logger.warn({ err }, 'Semantic query failed, falling back to FTS5');
    }
  }
  return queryFactsFts(q, opts);
}
```

Then rename the existing body of `queryFacts` to `queryFactsFts` and add a new `queryFactsSemantic` that calls `QdrantClient.search(...)`. Collection name: `knowledge_facts`. Upsert on `storeFact` in a parallel task if that collection doesn't exist yet — keep this task's scope to *query* only; if the collection is empty, Qdrant returns `[]` and the caller still sees FTS5 results via the catch.

Actually — to keep the fallback clean, make the semantic branch catch "collection not found" and fall through to FTS5.

- [ ] **Step 4: Update all callers of `queryFacts` to `await` it**

Run: `grep -rn "queryFacts(" src/ | grep -v "\.test\."`
Add `await` to each caller and widen caller signatures to `async` if needed.

- [ ] **Step 5: Run full test suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/memory/knowledge-store.ts src/memory/knowledge-store.semantic.test.ts src/
git commit -m "feat(memory): add semantic-search branch gated on OPENAI_API_KEY with FTS5 fallback"
```

### Task C3: Backfill `storeFact` to also upsert to Qdrant

- [ ] **Step 1:** Add a `storeFactSemantic(fact, vec)` helper that upserts `{ id, vector, payload }` into Qdrant collection `knowledge_facts`. Create the collection on first write with dimension 1536 (matches `text-embedding-3-small`).

- [ ] **Step 2:** Call it from `storeFact` in a fire-and-forget pattern (don't block the FTS5 write on the network call; log semantic errors at `warn`).

- [ ] **Step 3:** Add one integration test against a local Qdrant if `QDRANT_URL` is reachable; skip otherwise (`it.skipIf`).

- [ ] **Step 4:** Commit:

```bash
git add src/memory/knowledge-store.ts src/memory/knowledge-store.semantic.test.ts
git commit -m "feat(memory): upsert facts to Qdrant when embeddings are available"
```

---

## Track B — WhatsApp `/setup` Auto-Remediate Stale Chrome Entries

**Problem:** When `/setup` pairs WhatsApp, stale Chrome entries in Baileys state can silently poison pairing (user ends up with repeated QR regeneration or a zombie session). Remediation is manual today. We want `/setup` to *detect* staleness and either auto-clean or prompt the user.

### Task B1 (REQUIRED): Brainstorm staleness criteria

- [ ] **Step 1:** Use `superpowers:brainstorming` to answer, in writing at `docs/superpowers/plans/notes/2026-04-16-wa-stale-detect.md`:
  - What **defines** a stale Chrome entry? (e.g. `creds.json` exists but `noiseKey` is missing, or last modified > N days, or an SSL cert expired, or the paired device list is empty when `creds.registered === true`.)
  - What is the **remediation action**? (Auto-`rm -rf` the auth dir? Back it up first? Prompt the user?)
  - What is the **detection point**? Before the QR prompt, or at `service.ts:178` alongside `checkDockerGroupStale`, or both?

- [ ] **Step 2:** Land the notes file in a doc-only commit before writing any code:

```bash
git add docs/superpowers/plans/notes/2026-04-16-wa-stale-detect.md
git commit -m "docs: brainstorm notes for WA stale-Chrome detection"
```

### Task B2: Implement `detectStaleWhatsAppState`

Once B1 produces concrete criteria, add `detectStaleWhatsAppState()` to `setup/whatsapp-auth.ts`, call it before the auth flow (around line 159 where the existing `fs.rmSync` lives), and prompt for cleanup when stale. Expand this task with full TDD steps **after** B1 is done — don't predict the check shape now.

---

## Track A — Mini-App UX Polish: Reply / Forward

**Problem:** The mini-app's email viewer currently has two buttons: `Archive` and `Open in Gmail` ([email-full.ts:54-55](src/mini-app/templates/email-full.ts:54)). Phase 3 wants *Reply* and *Forward* working inline, not as a redirect to Gmail.

### Task A1 (REQUIRED): Design brainstorm

- [ ] **Step 1:** Use `superpowers:brainstorming` to produce a mini design doc at `docs/superpowers/plans/notes/2026-04-16-miniapp-reply-forward.md` covering:
  - **Reply UX:** inline textarea below the email? Full-page composer? Quoted-body default or blank?
  - **Forward UX:** how is the recipient entered? Autocomplete from contacts? Plain input?
  - **Send path:** does the mini-app POST to the nanoclaw server, which then uses `gmail-{alias}` MCP? Or does it piggyback on an existing send endpoint?
  - **Auth:** how does the mini-app know *which* Gmail account to send from? (Route from the email's `to:` back to the alias.)
  - **Errors:** network failure, send rejection, rate-limit — what does the user see?
  - **Draft autosave:** out of scope for v1 — confirm deferred.

- [ ] **Step 2:** Land the design doc before writing code:

```bash
git add docs/superpowers/plans/notes/2026-04-16-miniapp-reply-forward.md
git commit -m "docs: design notes for mini-app reply/forward"
```

### Task A2: Implement the UI + send endpoint

Expand with full TDD steps after A1 is landed. Skeleton:

- Modify `src/mini-app/templates/email-full.ts` to add Reply + Forward buttons and a composer panel (hidden by default).
- Add `POST /api/email/:messageId/reply` and `POST /api/email/:messageId/forward` to `src/mini-app/server.ts`.
- Add a small `sendEmail(alias, payload)` wrapper in `src/channels/gmail/send.ts` that routes to the correct `gmail-{alias}` MCP.
- Add integration tests that mock the MCP layer and assert the right alias is selected.
- Add a Playwright test that loads the mini-app in a headless browser and clicks Reply → types → Send → expects a 200.

---

## Self-Review

- [ ] Every required deferred item (3.1, 3.2, OPENAI_API_KEY, sidecar grace) has at least one named task.
- [ ] Tracks D and C have complete bite-sized TDD steps with real code.
- [ ] Tracks A and B are explicitly flagged as needing brainstorming first, with the brainstorm captured as a doc commit before implementation.
- [ ] Types used in later tasks (`embedText`, `isEmbeddingAvailable`, `waitForSidecarReady`) are defined in earlier tasks.
- [ ] No placeholders remain in Tracks C and D.

---

## Execution Notes

- **Landing order:** D → C → B → A. Each track is its own PR.
- **Do not** start Track A or B without first landing the brainstorm notes commit.
- **Do not** bundle Track C with a refactor to *replace* FTS5; that's a separate, bigger migration.
- **Visual verification** (Telegram buttons test from the previous session) is user-side and not blocked by this plan — proceed in parallel.
