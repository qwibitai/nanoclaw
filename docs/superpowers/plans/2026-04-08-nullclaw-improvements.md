# NullClaw-Inspired Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Borrow two reliability/UX improvements from NullClaw: per-group inbound message debouncing (prevents agent firing on partial multi-message input) and error classification in the Qwen runner (avoids wasted retries on non-retryable failures).

**Architecture:** Debounce lives in a new `src/inbound-debounce.ts` module integrated into the message loop in `src/index.ts`. Error classification is added to `ContainerOutput` in `src/qwen-runner.ts` and consumed by `src/index.ts` to decide whether to clear the session before the `GroupQueue` retry kicks in. No changes to the database schema or channel interface.

**Tech Stack:** TypeScript, Node.js, vitest — no new dependencies.

---

## File Map

| File | Change |
|---|---|
| `src/inbound-debounce.ts` | **Create** — per-group debounce timer logic |
| `src/inbound-debounce.test.ts` | **Create** — unit tests for debouncer |
| `src/index.ts` | **Modify** — integrate debounce into message loop |
| `src/qwen-runner.ts` | **Modify** — add `errorType` field to `ContainerOutput` and classify errors |
| `src/config.ts` | **Modify** — add `DEBOUNCE_MS` export |

---

## Task 1: Inbound message debouncer module

**Files:**
- Create: `src/inbound-debounce.ts`
- Create: `src/inbound-debounce.test.ts`

The problem: when a user sends two messages within a few hundred milliseconds (e.g. "hey" then immediately "can you help me with X?") and no agent is active, the first poll cycle dispatches "hey" alone, starting an agent that never sees the follow-up message as part of the same first turn.

The fix: per-group debounce — delay dispatch by `DEBOUNCE_MS` after the last message. If another message arrives within the window, reset the timer.

- [ ] **Step 1: Write the failing test**

```typescript
// src/inbound-debounce.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InboundDebouncer } from './inbound-debounce.js';

describe('InboundDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not dispatch immediately when debounce > 0', () => {
    const dispatched: string[] = [];
    const db = new InboundDebouncer(500, (jid) => dispatched.push(jid));

    db.push('group-a');
    expect(dispatched).toEqual([]);
  });

  it('dispatches after debounce window expires', () => {
    const dispatched: string[] = [];
    const db = new InboundDebouncer(500, (jid) => dispatched.push(jid));

    db.push('group-a');
    vi.advanceTimersByTime(500);
    expect(dispatched).toEqual(['group-a']);
  });

  it('resets timer on second push within window', () => {
    const dispatched: string[] = [];
    const db = new InboundDebouncer(500, (jid) => dispatched.push(jid));

    db.push('group-a');
    vi.advanceTimersByTime(300);
    db.push('group-a');       // resets the 500ms window
    vi.advanceTimersByTime(300);
    expect(dispatched).toEqual([]);  // still waiting
    vi.advanceTimersByTime(200);
    expect(dispatched).toEqual(['group-a']);
  });

  it('dispatches each group independently', () => {
    const dispatched: string[] = [];
    const db = new InboundDebouncer(500, (jid) => dispatched.push(jid));

    db.push('group-a');
    db.push('group-b');
    vi.advanceTimersByTime(500);
    expect(dispatched.sort()).toEqual(['group-a', 'group-b']);
  });

  it('dispatches immediately when debounceMs is 0', () => {
    const dispatched: string[] = [];
    const db = new InboundDebouncer(0, (jid) => dispatched.push(jid));

    db.push('group-a');
    expect(dispatched).toEqual(['group-a']);
  });

  it('cancels pending timer on cancel()', () => {
    const dispatched: string[] = [];
    const db = new InboundDebouncer(500, (jid) => dispatched.push(jid));

    db.push('group-a');
    db.cancel('group-a');
    vi.advanceTimersByTime(500);
    expect(dispatched).toEqual([]);
  });

  it('dispatches only once even if pushed multiple times', () => {
    const dispatched: string[] = [];
    const db = new InboundDebouncer(500, (jid) => dispatched.push(jid));

    db.push('group-a');
    db.push('group-a');
    db.push('group-a');
    vi.advanceTimersByTime(500);
    expect(dispatched).toEqual(['group-a']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/inbound-debounce.test.ts
```

Expected: `FAIL` — `Cannot find module './inbound-debounce.js'`

- [ ] **Step 3: Implement `InboundDebouncer`**

```typescript
// src/inbound-debounce.ts

/**
 * Per-group inbound message debouncer.
 *
 * Delays dispatch of `enqueueMessageCheck` by `debounceMs` after the most
 * recent push for a group. If debounceMs is 0, dispatches synchronously.
 *
 * Inspired by NullClaw's InboundDebouncer (src/inbound_debounce.zig).
 */
export class InboundDebouncer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly debounceMs: number,
    private readonly dispatch: (groupJid: string) => void,
  ) {}

  /** Record a new message for a group and (re)start its debounce timer. */
  push(groupJid: string): void {
    if (this.debounceMs === 0) {
      this.dispatch(groupJid);
      return;
    }

    const existing = this.timers.get(groupJid);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(groupJid);
      this.dispatch(groupJid);
    }, this.debounceMs);

    this.timers.set(groupJid, timer);
  }

  /** Cancel any pending debounce for a group (e.g. when message was piped to active agent). */
  cancel(groupJid: string): void {
    const timer = this.timers.get(groupJid);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(groupJid);
    }
  }

  /** Cancel all pending timers (used on shutdown). */
  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/inbound-debounce.test.ts
```

Expected: all 7 tests PASS, 0 leaks.

- [ ] **Step 5: Add `DEBOUNCE_MS` to config**

In `src/config.ts`, add after the `IDLE_TIMEOUT` line:

```typescript
export const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '800', 10);
```

- [ ] **Step 6: Integrate debouncer into the message loop**

In `src/index.ts`, add the import at the top with other local imports:

```typescript
import { InboundDebouncer } from './inbound-debounce.js';
import { DEBOUNCE_MS } from './config.js';   // DEBOUNCE_MS is already in the config import block
```

(Move `DEBOUNCE_MS` into the existing `./config.js` import destructure.)

Add the debouncer instance near the top of the module, alongside the `queue` declaration:

```typescript
const debouncer = new InboundDebouncer(DEBOUNCE_MS, (chatJid) =>
  queue.enqueueMessageCheck(chatJid),
);
```

In `startMessageLoop`, in the section where messages are dispatched per group, replace the bare `queue.enqueueMessageCheck(chatJid)` call:

```typescript
          // Previously: queue.enqueueMessageCheck(chatJid);
          // Now: debounce before enqueuing so rapid multi-message sequences
          // land in a single agent turn instead of multiple.
          if (queue.sendMessage(chatJid, formatted)) {
            // ... existing pipe path unchanged ...
            debouncer.cancel(chatJid); // message piped — no need to enqueue
          } else {
            debouncer.push(chatJid);
          }
```

The full block in context (replace the existing `if (queue.sendMessage(...)) { ... } else { queue.enqueueMessageCheck(chatJid); }` block):

```typescript
          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
            debouncer.cancel(chatJid);
          } else {
            debouncer.push(chatJid);
          }
```

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 8: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/inbound-debounce.ts src/inbound-debounce.test.ts src/index.ts src/config.ts
git commit -m "feat: add per-group inbound message debouncer (800ms default)"
```

---

## Task 2: Error classification in qwen-runner

**Files:**
- Modify: `src/qwen-runner.ts`

**Problem:** All Qwen errors are treated identically — they all trigger exponential-backoff retries in `GroupQueue`. But some errors are non-retryable (e.g. a syntactically invalid session ID format) and some indicate context exhaustion (should clear the session and retry fresh immediately rather than with backoff). Without classification, we waste 5 retry cycles on pointless work.

**Approach:** Add an `errorType` field to `ContainerOutput`. The runner classifies stderr/stdout patterns. `runAgent()` in `index.ts` uses this to decide whether to clear the session before returning `'error'` (the `GroupQueue` already handles backoff; we just need to prevent it from resuming a broken session).

- [ ] **Step 1: Write the failing test**

Create `src/qwen-runner.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyQwenError } from './qwen-runner.js';

describe('classifyQwenError', () => {
  it('returns stale-session for missing session message', () => {
    expect(classifyQwenError('No saved session found with ID abc123', 1))
      .toBe('stale-session');
  });

  it('returns context-exhausted for context window errors', () => {
    expect(classifyQwenError('context length exceeded maximum token limit', 1))
      .toBe('context-exhausted');
    expect(classifyQwenError('Context window is full', 1))
      .toBe('context-exhausted');
    expect(classifyQwenError('maximum context length', 1))
      .toBe('context-exhausted');
  });

  it('returns non-retryable for 4xx client errors (not 429)', () => {
    expect(classifyQwenError('HTTP 400 Bad Request', 1)).toBe('non-retryable');
    expect(classifyQwenError('HTTP 401 Unauthorized', 1)).toBe('non-retryable');
    expect(classifyQwenError('HTTP 403 Forbidden', 1)).toBe('non-retryable');
  });

  it('returns retryable for 429 rate limit', () => {
    expect(classifyQwenError('HTTP 429 Too Many Requests', 1)).toBe('retryable');
  });

  it('returns retryable for timeout (exit code 0 edge case)', () => {
    expect(classifyQwenError('', 1)).toBe('retryable');
  });

  it('returns retryable for unknown errors', () => {
    expect(classifyQwenError('something went wrong', 1)).toBe('retryable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/qwen-runner.test.ts
```

Expected: FAIL — `classifyQwenError` is not exported.

- [ ] **Step 3: Add `errorType` to `ContainerOutput` and implement `classifyQwenError`**

In `src/qwen-runner.ts`, update `ContainerOutput`:

```typescript
export type QwenErrorType =
  | 'stale-session'
  | 'context-exhausted'
  | 'non-retryable'
  | 'retryable';

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  errorType?: QwenErrorType;
}
```

Add the classifier function (export it so it's testable in isolation):

```typescript
/**
 * Classify a Qwen error from stdout/stderr text and exit code.
 * Used to decide retry strategy in the caller.
 */
export function classifyQwenError(text: string, _exitCode: number | null): QwenErrorType {
  const lower = text.toLowerCase();

  if (text.includes('No saved session found with ID')) return 'stale-session';

  // Context window exhaustion — clear session and let GroupQueue retry fresh
  if (
    (lower.includes('context') &&
      (lower.includes('length') || lower.includes('window') || lower.includes('maximum') || lower.includes('exceed'))) ||
    (lower.includes('token') &&
      (lower.includes('limit') || lower.includes('too many') || lower.includes('maximum') || lower.includes('exceed')))
  ) {
    return 'context-exhausted';
  }

  // Non-retryable 4xx (except 429 rate-limit and 408 timeout)
  const match = text.match(/\b(4\d\d)\b/);
  if (match) {
    const code = parseInt(match[1], 10);
    if (code >= 400 && code < 500 && code !== 429 && code !== 408) {
      return 'non-retryable';
    }
  }

  return 'retryable';
}
```

In the `spawnQwen` resolve paths, attach `errorType` when resolving with `status: 'error'`. There are three such paths — update each:

**Stale session path** (already detected separately, keep as-is):
```typescript
          } else if (
            code !== 0 &&
            stdout.includes('No saved session found with ID')
          ) {
            resolve({ status: 'error', result: null, error: 'stale-session', errorType: 'stale-session' });
```

**Generic error path** (non-zero exit, no output):
```typescript
          } else if (code !== 0) {
            const errText = stdout.slice(-2000);
            resolve({
              status: 'error',
              result: null,
              error: `Qwen exited with code ${code}`,
              errorType: classifyQwenError(errText, code),
            });
```

**Timeout with no output path**:
```typescript
            resolve({
              status: 'error',
              result: null,
              error: `Qwen agent timed out after ${Math.round(duration / 1000)}s`,
              errorType: 'retryable',
            });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/qwen-runner.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Use `errorType` in `runAgent` in `index.ts`**

In `src/index.ts` in the `runAgent` function, extend the error handling block that already handles stale sessions to also handle `context-exhausted` and `non-retryable`:

```typescript
    if (output.status === 'error') {
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(output.error);

      // Context exhaustion: clear session so the retry (handled by GroupQueue
      // backoff) starts a fresh conversation instead of hitting the same limit.
      const isContextExhausted = output.errorType === 'context-exhausted';

      if (isStaleSession || isContextExhausted) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error, reason: isContextExhausted ? 'context-exhausted' : 'stale-session' },
          'Clearing session before retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      // Non-retryable errors: return success so GroupQueue doesn't retry.
      // The user already got an error response (or silence), retrying is pointless.
      if (output.errorType === 'non-retryable') {
        logger.warn(
          { group: group.name, error: output.error },
          'Non-retryable Qwen error, skipping retry',
        );
        return 'success';
      }

      logger.error(
        { group: group.name, error: output.error, errorType: output.errorType },
        'Container agent error',
      );
      return 'error';
    }
```

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 7: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/qwen-runner.ts src/qwen-runner.test.ts src/index.ts
git commit -m "feat: classify Qwen errors to skip retries for non-retryable/context-exhausted cases"
```

---

## Self-Review

**Spec coverage:**
- Inbound debouncer: Task 1 covers the module, config export, and integration. ✓
- Error classification: Task 2 covers classifier, `ContainerOutput` extension, and caller integration. ✓
- No stale session regression: `stale-session` path in qwen-runner is unchanged; the `classifyQwenError` only runs on the generic error path where the old `stdout.includes(...)` check is not present. ✓

**Placeholder scan:** No TBDs. All code blocks are complete. ✓

**Type consistency:**
- `QwenErrorType` defined once in `qwen-runner.ts`, referenced by string literals in `index.ts` (no import needed — checked against literals, not the type). ✓
- `InboundDebouncer` constructor takes `(debounceMs: number, dispatch: (jid: string) => void)` — matches usage in `index.ts`. ✓
- `DEBOUNCE_MS` added to `config.ts` and imported in `index.ts`. ✓
