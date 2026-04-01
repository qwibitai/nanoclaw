# Long-Running Task Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow agent containers to automatically continue interrupted long-running tasks by re-spawning with a continuation prompt when a hard timeout occurs.

**Architecture:** Two changes — (1) expose per-group timeout override via existing `containerConfig.timeout`, and (2) add a host-managed continuation loop in `container-runner.ts` that re-enqueues a continuation message on hard timeout. In-memory state tracks original prompt and start commit across continuations. Chat notifications inform the user of continuation events.

**Tech Stack:** Node.js, TypeScript, Vitest

---

### Task 1: Add Continuation Config Constants

**Files:**
- Modify: `src/config.ts:42-63`
- Test: `src/config.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/config.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('continuation config', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('exports MAX_CONTINUATIONS with default value 2', async () => {
    const { MAX_CONTINUATIONS } = await import('./config.js');
    expect(MAX_CONTINUATIONS).toBe(2);
  });

  it('exports SCHEDULED_TASK_MAX_CONTINUATIONS with default value 5', async () => {
    const { SCHEDULED_TASK_MAX_CONTINUATIONS } = await import('./config.js');
    expect(SCHEDULED_TASK_MAX_CONTINUATIONS).toBe(5);
  });

  it('exports CONTINUATION_COOLDOWN_MS with default value 60000', async () => {
    const { CONTINUATION_COOLDOWN_MS } = await import('./config.js');
    expect(CONTINUATION_COOLDOWN_MS).toBe(60000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — `MAX_CONTINUATIONS` is not exported.

- [ ] **Step 3: Add the constants to config.ts**

Add after the `MAX_CONCURRENT_CONTAINERS` block (after line 63 in `src/config.ts`):

```typescript
export const MAX_CONTINUATIONS = Math.max(
  0,
  parseInt(process.env.MAX_CONTINUATIONS || '2', 10) || 2,
);
export const SCHEDULED_TASK_MAX_CONTINUATIONS = Math.max(
  0,
  parseInt(process.env.SCHEDULED_TASK_MAX_CONTINUATIONS || '5', 10) || 5,
);
export const CONTINUATION_COOLDOWN_MS = parseInt(
  process.env.CONTINUATION_COOLDOWN_MS || '60000',
  10,
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add continuation config constants"
```

---

### Task 2: Add Continuation State Tracker

**Files:**
- Create: `src/continuation.ts`
- Test: `src/continuation.test.ts` (create)

This module manages in-memory state for active continuation chains. It's a standalone unit with no dependencies on container-runner or group-queue.

- [ ] **Step 1: Write the failing test**

Create `src/continuation.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

import { ContinuationTracker } from './continuation.js';

describe('ContinuationTracker', () => {
  let tracker: ContinuationTracker;

  beforeEach(() => {
    tracker = new ContinuationTracker();
  });

  it('starts a chain and retrieves it', () => {
    tracker.start('group1', 'msg1', 'Do the thing', 'abc123', 3);
    const chain = tracker.get('group1', 'msg1');
    expect(chain).toEqual({
      originalPrompt: 'Do the thing',
      startCommit: 'abc123',
      count: 0,
      maxContinuations: 3,
    });
  });

  it('increments count on advance', () => {
    tracker.start('group1', 'msg1', 'Do the thing', 'abc123', 2);
    const result = tracker.advance('group1', 'msg1');
    expect(result).not.toBeNull();
    expect(result!.count).toBe(1);
  });

  it('returns null from advance when max reached', () => {
    tracker.start('group1', 'msg1', 'Do the thing', 'abc123', 1);
    tracker.advance('group1', 'msg1'); // count = 1, max = 1
    const result = tracker.advance('group1', 'msg1');
    expect(result).toBeNull();
  });

  it('clears a chain', () => {
    tracker.start('group1', 'msg1', 'Do the thing', 'abc123', 2);
    tracker.clear('group1', 'msg1');
    expect(tracker.get('group1', 'msg1')).toBeNull();
  });

  it('returns null for unknown chains', () => {
    expect(tracker.get('nope', 'nope')).toBeNull();
    expect(tracker.advance('nope', 'nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/continuation.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement ContinuationTracker**

Create `src/continuation.ts`:

```typescript
export interface ContinuationChain {
  originalPrompt: string;
  startCommit: string;
  count: number;
  maxContinuations: number;
}

export class ContinuationTracker {
  private chains = new Map<string, ContinuationChain>();

  private key(groupFolder: string, messageId: string): string {
    return `${groupFolder}:${messageId}`;
  }

  start(
    groupFolder: string,
    messageId: string,
    originalPrompt: string,
    startCommit: string,
    maxContinuations: number,
  ): void {
    this.chains.set(this.key(groupFolder, messageId), {
      originalPrompt,
      startCommit,
      count: 0,
      maxContinuations,
    });
  }

  get(groupFolder: string, messageId: string): ContinuationChain | null {
    return this.chains.get(this.key(groupFolder, messageId)) ?? null;
  }

  /**
   * Increment the continuation count.
   * Returns the updated chain, or null if max continuations reached.
   */
  advance(groupFolder: string, messageId: string): ContinuationChain | null {
    const chain = this.chains.get(this.key(groupFolder, messageId));
    if (!chain) return null;
    chain.count++;
    if (chain.count > chain.maxContinuations) {
      return null;
    }
    return chain;
  }

  clear(groupFolder: string, messageId: string): void {
    this.chains.delete(this.key(groupFolder, messageId));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/continuation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/continuation.ts src/continuation.test.ts
git commit -m "feat: add ContinuationTracker for in-memory continuation state"
```

---

### Task 3: Build Continuation Prompt

**Files:**
- Modify: `src/continuation.ts`
- Modify: `src/continuation.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/continuation.test.ts`:

```typescript
import { buildContinuationPrompt, ContinuationTracker } from './continuation.js';

describe('buildContinuationPrompt', () => {
  it('builds a prompt with original prompt, commit, and count', () => {
    const prompt = buildContinuationPrompt({
      originalPrompt: 'Refactor the auth module',
      startCommit: 'abc123def',
      count: 1,
      maxContinuations: 3,
    });

    expect(prompt).toContain('Refactor the auth module');
    expect(prompt).toContain('abc123def');
    expect(prompt).toContain('git log abc123def..HEAD');
    expect(prompt).toContain('Continuation 1 of 3');
  });

  it('includes instructions to check if work is complete', () => {
    const prompt = buildContinuationPrompt({
      originalPrompt: 'Do stuff',
      startCommit: 'aaa',
      count: 1,
      maxContinuations: 2,
    });

    expect(prompt).toContain('already complete');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/continuation.test.ts`
Expected: FAIL — `buildContinuationPrompt` is not exported.

- [ ] **Step 3: Implement buildContinuationPrompt**

Add to `src/continuation.ts`:

```typescript
export function buildContinuationPrompt(chain: ContinuationChain): string {
  return [
    'Your previous session was interrupted. You were working on the following task:',
    '',
    '---',
    chain.originalPrompt,
    '---',
    '',
    `Your work started at commit ${chain.startCommit}. Check \`git log ${chain.startCommit}..HEAD\``,
    'and the current repo state to understand what was accomplished. Continue where',
    'you left off. If the task is already complete, confirm and exit.',
    '',
    `(Continuation ${chain.count} of ${chain.maxContinuations})`,
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/continuation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/continuation.ts src/continuation.test.ts
git commit -m "feat: add buildContinuationPrompt for continuation messages"
```

---

### Task 4: Capture Start Commit at Container Launch

**Files:**
- Modify: `src/container-runner.ts:413-468`
- Modify: `src/container-runner.test.ts`

The `runContainerAgent` function needs to capture `git HEAD` at launch time and return it alongside the container output, so callers can use it for continuation prompts.

- [ ] **Step 1: Write the failing test**

Add to `src/container-runner.test.ts`:

```typescript
// At the top, add to the child_process mock:
// Update the exec mock to also handle git rev-parse
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null, result?: { stdout: string }) => void) => {
        if (cb) {
          if (typeof _cmd === 'string' && _cmd.includes('git rev-parse')) {
            cb(null, { stdout: 'abc123def456\n' });
          } else {
            cb(null);
          }
        }
        return new EventEmitter();
      },
    ),
    execSync: vi.fn((cmd: string) => {
      if (cmd.includes('git rev-parse')) return Buffer.from('abc123def456\n');
      return Buffer.from('');
    }),
  };
});
```

Add a new test:

```typescript
describe('container start commit capture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns startCommit in the output', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
    );

    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.startCommit).toBe('abc123def456');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/container-runner.test.ts`
Expected: FAIL — `startCommit` is not a property on `ContainerOutput`.

- [ ] **Step 3: Add startCommit to ContainerOutput and capture it**

In `src/container-runner.ts`, update the `ContainerOutput` interface (line 120):

```typescript
export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  startCommit?: string;
}
```

At the top of `runContainerAgent` (after line 421, before spawning), capture git HEAD for groups with a project path:

```typescript
let startCommit: string | undefined;
if (group.projectPath) {
  try {
    const { execSync } = await import('child_process');
    startCommit = execSync('git rev-parse HEAD', {
      cwd: group.projectPath,
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    // Not a git repo or git not available — skip
  }
}
```

Then include `startCommit` in every `resolve()` call in the function. There are four resolve paths — update each to spread `...(startCommit ? { startCommit } : {})`:

1. Timeout-after-output resolve (line 609-614):
```typescript
resolve({
  status: 'success',
  result: null,
  newSessionId,
  startCommit,
});
```

2. Timeout-no-output resolve (line 624-628):
```typescript
resolve({
  status: 'error',
  result: null,
  error: `Container timed out after ${configTimeout}ms`,
  startCommit,
});
```

3. Streaming-mode success resolve (line 723-728):
```typescript
resolve({
  status: 'success',
  result: null,
  newSessionId,
  startCommit,
});
```

4. Error resolve (line 713-717):
```typescript
resolve({
  status: 'error',
  result: null,
  error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
  startCommit,
});
```

5. Spawn error resolve (line 792-796):
```typescript
resolve({
  status: 'error',
  result: null,
  error: `Container spawn error: ${err.message}`,
  startCommit,
});
```

6. Legacy JSON parse resolve (line ~754-766) and parse error resolve (line ~778-783): add `startCommit` to both.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/container-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat: capture git HEAD as startCommit at container launch"
```

---

### Task 5: Add timedOut Flag to ContainerOutput

**Files:**
- Modify: `src/container-runner.ts`
- Modify: `src/container-runner.test.ts`

The caller needs to know whether the container was killed by hard timeout (continuation candidate) vs clean exit. Add a `timedOut` flag to `ContainerOutput`.

- [ ] **Step 1: Write the failing test**

Add to `src/container-runner.test.ts` in the existing `container-runner timeout behavior` describe block:

```typescript
it('timeout sets timedOut flag to true', async () => {
  const resultPromise = runContainerAgent(
    testGroup,
    testInput,
    () => {},
    vi.fn(async () => {}),
  );

  // Emit output then timeout
  emitOutputMarker(fakeProc, { status: 'success', result: 'partial work' });
  await vi.advanceTimersByTimeAsync(10);
  await vi.advanceTimersByTimeAsync(1830000);
  fakeProc.emit('close', 137);
  await vi.advanceTimersByTimeAsync(10);

  const result = await resultPromise;
  expect(result.timedOut).toBe(true);
});

it('clean exit sets timedOut flag to false', async () => {
  const resultPromise = runContainerAgent(
    testGroup,
    testInput,
    () => {},
    vi.fn(async () => {}),
  );

  emitOutputMarker(fakeProc, { status: 'success', result: 'done' });
  await vi.advanceTimersByTimeAsync(10);
  fakeProc.emit('close', 0);
  await vi.advanceTimersByTimeAsync(10);

  const result = await resultPromise;
  expect(result.timedOut).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/container-runner.test.ts`
Expected: FAIL — `timedOut` is not on the result.

- [ ] **Step 3: Add timedOut to ContainerOutput**

In `src/container-runner.ts`, update the `ContainerOutput` interface:

```typescript
export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  startCommit?: string;
  timedOut?: boolean;
}
```

Add `timedOut: true` to the two timeout resolve paths (timeout-after-output and timeout-no-output), and `timedOut: false` to all other resolve paths.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/container-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat: add timedOut flag to ContainerOutput"
```

---

### Task 6: Wire Continuation into processGroupMessages

**Files:**
- Modify: `src/index.ts:255-373`
- Test: `src/index.test.ts` (create — focused integration test)

This is where the continuation loop actually runs. After `runAgent` returns, if the output indicates a hard timeout, the host enqueues a continuation message.

- [ ] **Step 1: Write the failing test**

Create `src/index.test.ts` with a focused test for the continuation behavior. This requires extracting the continuation logic into a testable helper. Instead, we'll test the continuation wiring through the existing `processGroupMessages` flow by mocking `runContainerAgent`.

However, since `processGroupMessages` is a private function in index.ts, and the continuation logic is tightly coupled to it, the better approach is to test the continuation decision logic as a pure function.

Add to `src/continuation.test.ts`:

```typescript
import {
  buildContinuationPrompt,
  ContinuationTracker,
  shouldContinue,
} from './continuation.js';

describe('shouldContinue', () => {
  let tracker: ContinuationTracker;

  beforeEach(() => {
    tracker = new ContinuationTracker();
  });

  it('returns continuation prompt when timeout and retries available', () => {
    tracker.start('group1', 'msg1', 'Do stuff', 'abc123', 2);
    const result = shouldContinue(tracker, 'group1', 'msg1', true);
    expect(result).not.toBeNull();
    expect(result!.prompt).toContain('Do stuff');
    expect(result!.prompt).toContain('abc123');
    expect(result!.prompt).toContain('Continuation 1 of 2');
  });

  it('returns null when not timed out', () => {
    tracker.start('group1', 'msg1', 'Do stuff', 'abc123', 2);
    const result = shouldContinue(tracker, 'group1', 'msg1', false);
    expect(result).toBeNull();
  });

  it('returns null when no chain exists', () => {
    const result = shouldContinue(tracker, 'group1', 'msg1', true);
    expect(result).toBeNull();
  });

  it('returns null when max continuations exceeded', () => {
    tracker.start('group1', 'msg1', 'Do stuff', 'abc123', 1);
    shouldContinue(tracker, 'group1', 'msg1', true); // count = 1
    const result = shouldContinue(tracker, 'group1', 'msg1', true); // count would be 2 > max 1
    expect(result).toBeNull();
  });

  it('returns exhausted flag when max continuations just exceeded', () => {
    tracker.start('group1', 'msg1', 'Do stuff', 'abc123', 1);
    shouldContinue(tracker, 'group1', 'msg1', true); // uses the one continuation
    const result = shouldContinue(tracker, 'group1', 'msg1', true);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/continuation.test.ts`
Expected: FAIL — `shouldContinue` not exported.

- [ ] **Step 3: Implement shouldContinue**

Add to `src/continuation.ts`:

```typescript
export interface ContinuationResult {
  prompt: string;
  count: number;
  maxContinuations: number;
}

export function shouldContinue(
  tracker: ContinuationTracker,
  groupFolder: string,
  messageId: string,
  timedOut: boolean,
): ContinuationResult | null {
  if (!timedOut) return null;

  const chain = tracker.advance(groupFolder, messageId);
  if (!chain) return null;

  return {
    prompt: buildContinuationPrompt(chain),
    count: chain.count,
    maxContinuations: chain.maxContinuations,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/continuation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/continuation.ts src/continuation.test.ts
git commit -m "feat: add shouldContinue decision function"
```

---

### Task 7: Integrate Continuation into index.ts

**Files:**
- Modify: `src/index.ts`

This wires the continuation tracker into the message processing flow. The key design choice: continuations are enqueued as tasks via `queue.enqueueTask` (not synthetic messages), so they bypass trigger requirements and don't pollute the message DB. A helper function `scheduleContinuation` handles the recursive case where a continuation itself times out.

- [ ] **Step 1: Add imports to index.ts**

At the top of `src/index.ts`, add:

```typescript
import { execSync } from 'child_process';
import {
  ContinuationTracker,
  shouldContinue,
} from './continuation.js';
```

Update the existing config import to include new constants:

```typescript
import {
  ASSISTANT_NAME,
  CONTINUATION_COOLDOWN_MS,
  CREDENTIAL_PROXY_PORT,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_CONTINUATIONS,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
```

Add after the `queue` declaration (around line 80):

```typescript
const continuationTracker = new ContinuationTracker();
```

- [ ] **Step 2: Add scheduleContinuation helper**

Add this helper function before `processGroupMessages`:

```typescript
/**
 * Schedule a continuation container after a timeout.
 * Handles the recursive case where a continuation itself times out.
 */
function scheduleContinuation(
  group: RegisteredGroup,
  chatJid: string,
  chainKey: { groupFolder: string; messageId: string },
  continuation: { prompt: string; count: number; maxContinuations: number },
): void {
  const channel = findChannel(channels, chatJid);
  if (!channel) return;

  setTimeout(() => {
    queue.enqueueTask(
      chatJid,
      `continuation-${chainKey.messageId}-${continuation.count}`,
      async () => {
        await channel.setTyping?.(chatJid, true);

        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const groupIdleTimeout =
          group.containerConfig?.idleTimeout || IDLE_TIMEOUT;
        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            queue.closeStdin(chatJid);
          }, groupIdleTimeout);
        };

        const contOutput = await runAgent(
          group,
          continuation.prompt,
          chatJid,
          async (result) => {
            if (result.result) {
              const raw =
                typeof result.result === 'string'
                  ? result.result
                  : JSON.stringify(result.result);
              const text = raw
                .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                .trim();
              if (text) await channel.sendMessage(chatJid, text);
              resetIdleTimer();
            }
            if (result.status === 'success') queue.notifyIdle(chatJid);
          },
        );

        await channel.setTyping?.(chatJid, false);
        if (idleTimer) clearTimeout(idleTimer);

        // If this continuation also timed out, try the next one
        if (contOutput === 'timedOut') {
          const next = shouldContinue(
            continuationTracker,
            chainKey.groupFolder,
            chainKey.messageId,
            true,
          );
          if (next) {
            logger.info(
              {
                group: group.name,
                continuation: next.count,
                max: next.maxContinuations,
              },
              'Scheduling follow-up continuation after timeout',
            );
            await channel.sendMessage(
              chatJid,
              `Task timed out, continuing automatically (${next.count}/${next.maxContinuations})`,
            );
            scheduleContinuation(group, chatJid, chainKey, next);
          } else {
            await channel.sendMessage(
              chatJid,
              'Task reached maximum continuations. Check progress and re-prompt if needed.',
            );
            continuationTracker.clear(
              chainKey.groupFolder,
              chainKey.messageId,
            );
          }
        } else {
          continuationTracker.clear(chainKey.groupFolder, chainKey.messageId);
        }
      },
    );
  }, CONTINUATION_COOLDOWN_MS);
}
```

- [ ] **Step 3: Start continuation chain in processGroupMessages**

In `processGroupMessages` (around line 287, after `const prompt = formatMessages(...)`), add:

```typescript
// Continuation chain tracking
const messageId = missedMessages[missedMessages.length - 1].timestamp;

let startCommit = '';
if (group.projectPath) {
  try {
    startCommit = execSync('git rev-parse HEAD', {
      cwd: group.projectPath,
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    // Not a git repo — continuation works without commit tracking
  }
}

continuationTracker.start(
  group.folder,
  messageId,
  prompt,
  startCommit,
  MAX_CONTINUATIONS,
);
```

- [ ] **Step 4: Add continuation check after runAgent**

After the existing error handling block (around line 370, before `return true`), add:

```typescript
// Check if the container timed out and should be continued
if (output === 'timedOut') {
  const continuation = shouldContinue(
    continuationTracker,
    group.folder,
    messageId,
    true,
  );

  if (continuation) {
    logger.info(
      {
        group: group.name,
        continuation: continuation.count,
        max: continuation.maxContinuations,
      },
      'Scheduling continuation after timeout',
    );
    await channel.sendMessage(
      chatJid,
      `Task timed out, continuing automatically (${continuation.count}/${continuation.maxContinuations})`,
    );
    scheduleContinuation(group, chatJid, { groupFolder: group.folder, messageId }, continuation);
  } else {
    await channel.sendMessage(
      chatJid,
      'Task reached maximum continuations. Check progress and re-prompt if needed.',
    );
    continuationTracker.clear(group.folder, messageId);
  }
} else {
  // Clean exit — clear continuation chain
  continuationTracker.clear(group.folder, messageId);
}
```

- [ ] **Step 5: Update runAgent to return 'timedOut' status**

Change the return type of `runAgent`:

```typescript
async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error' | 'timedOut'> {
```

In the try block, add a `timedOut` check before the error check:

```typescript
if (output.timedOut) {
  return 'timedOut';
}

if (output.status === 'error') {
  logger.error(
    { group: group.name, error: output.error },
    'Container agent error',
  );
  return 'error';
}
```

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: All existing tests pass. No regressions.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire continuation loop into message processing"
```

---

### Task 8: Integrate Continuation into Task Scheduler

**Files:**
- Modify: `src/task-scheduler.ts`

Scheduled tasks also need continuation support, using `SCHEDULED_TASK_MAX_CONTINUATIONS`.

- [ ] **Step 1: Add imports**

Add to `src/task-scheduler.ts`:

```typescript
import {
  ContinuationTracker,
  shouldContinue,
  buildContinuationPrompt,
} from './continuation.js';
import {
  CONTINUATION_COOLDOWN_MS,
  SCHEDULED_TASK_MAX_CONTINUATIONS,
} from './config.js';
```

- [ ] **Step 2: Add continuation tracker and update SchedulerDependencies**

Add a module-level continuation tracker:

```typescript
const continuationTracker = new ContinuationTracker();
```

- [ ] **Step 3: Wire continuation into runTask**

In `runTask`, after the container completes (after line 226 in the current code, after the try/catch block), before computing next run:

```typescript
// Check for continuation on timeout
if (error?.includes('timed out') || output?.timedOut) {
  const taskMessageId = `task-${task.id}-${startTime}`;

  // Start chain on first timeout for this task run
  if (!continuationTracker.get(task.group_folder, taskMessageId)) {
    continuationTracker.start(
      task.group_folder,
      taskMessageId,
      task.prompt,
      '', // No git tracking for scheduled tasks by default
      SCHEDULED_TASK_MAX_CONTINUATIONS,
    );
  }

  const continuation = shouldContinue(
    continuationTracker,
    task.group_folder,
    taskMessageId,
    true,
  );

  if (continuation) {
    logger.info(
      {
        taskId: task.id,
        continuation: continuation.count,
        max: continuation.maxContinuations,
      },
      'Scheduling task continuation after timeout',
    );

    // Re-enqueue the task with the continuation prompt after cooldown
    setTimeout(() => {
      deps.queue.enqueueTask(task.chat_jid, `${task.id}-cont-${continuation.count}`, async () => {
        // Run with continuation prompt instead of original
        const contTask = { ...task, prompt: continuation.prompt };
        await runTask(contTask, deps);
      });
    }, CONTINUATION_COOLDOWN_MS);

    // Don't compute next_run yet — continuation is in progress
    return;
  } else {
    // Max continuations exhausted — notify user
    await deps.sendMessage(
      task.chat_jid,
      'Scheduled task reached maximum continuations. Check progress and re-prompt if needed.',
    );
    continuationTracker.clear(task.group_folder, taskMessageId);
  }
}
```

Note: This requires capturing the `output` variable from `runContainerAgent`. The current code doesn't store it directly in a way that's accessible after the try/catch. Refactor the try/catch to capture `output`:

Replace the existing try/catch block with:

```typescript
let output: ContainerOutput | null = null;

try {
  // ... existing code ...
  output = await runContainerAgent(/* ... existing args ... */);

  if (output.status === 'error') {
    error = output.error || 'Unknown error';
  } else if (output.result) {
    result = output.result;
  }

  logger.info(
    { taskId: task.id, durationMs: Date.now() - startTime },
    'Task completed',
  );
} catch (err) {
  if (closeTimer) clearTimeout(closeTimer);
  error = err instanceof Error ? err.message : String(err);
  logger.error({ taskId: task.id, error }, 'Task failed');
}
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/task-scheduler.ts
git commit -m "feat: wire continuation into scheduled task runner"
```

---

### Task 9: Verify End-to-End and Run Full Test Suite

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 2: Run TypeScript compiler check**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Compiles successfully.

- [ ] **Step 4: Final commit if any cleanup needed**

If any type errors or test failures were found and fixed, commit the fixes:

```bash
git add -A
git commit -m "fix: resolve type errors and test failures from continuation feature"
```
