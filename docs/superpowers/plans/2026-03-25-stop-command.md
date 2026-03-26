# /stop Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users send `/stop` in chat to immediately kill an in-progress agent container session.

**Architecture:** Three-layer interrupt: orchestrator intercepts `/stop` → GroupQueue writes `_stop` sentinel + schedules hard-kill → agent-runner detects sentinel, aborts SDK query via `AbortController`, and exits.

**Tech Stack:** TypeScript, Node.js, vitest, Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

**Spec:** `docs/superpowers/specs/2026-03-25-stop-command-design.md`

---

### Task 1: Add `stopContainer` method to GroupQueue

**Files:**
- Modify: `src/group-queue.ts` (add `stopContainer` method)
- Create: `src/group-queue.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/group-queue.test.ts
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock config before importing GroupQueue
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-gq',
  MAX_CONCURRENT_CONTAINERS: 5,
  MAX_CONTAINERS_PER_GROUP: 3,
}));

// Mock container-runtime to avoid real docker calls
vi.mock('./container-runtime.js', () => ({
  stopContainerAsync: vi.fn((_name: string, cb: (err: Error | null) => void) => cb(null)),
}));

import { GroupQueue } from './group-queue.js';
import { stopContainerAsync } from './container-runtime.js';

describe('GroupQueue.stopContainer', () => {
  const groupJid = 'test-group@jid';
  const threadId = 'default';
  let queue: GroupQueue;

  beforeEach(() => {
    queue = new GroupQueue();
    fs.mkdirSync('/tmp/nanoclaw-test-gq/ipc/test-folder/default/input', { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync('/tmp/nanoclaw-test-gq', { recursive: true, force: true });
  });

  it('returns { stopped: false } when no active container', () => {
    const result = queue.stopContainer(groupJid, threadId);
    expect(result.stopped).toBe(false);
  });

  it('writes _stop sentinel and returns { stopped: true } for active container', () => {
    // Simulate an active container by registering a process
    const fakeProc = { killed: false, kill: vi.fn() } as any;
    queue.registerProcess(groupJid, fakeProc, 'nanoclaw-test-123', 'test-folder', threadId);
    // Mark thread as active by using internal getThread
    // We need to simulate withContainer having run — use enqueueThreadMessageCheck + processMessagesFn
    // Instead, directly set up state via registerProcess + manually setting active
    // Since registerProcess doesn't set active, we test via the public API path
    // For unit test, we access the thread state directly
    const key = `${groupJid}:${threadId}`;
    (queue as any).threads.get(key).active = true;
    (queue as any).threads.get(key).groupFolder = 'test-folder';
    (queue as any).getGroup(groupJid).activeThreadCount = 1;
    (queue as any).activeCount = 1;

    const result = queue.stopContainer(groupJid, threadId);
    expect(result.stopped).toBe(true);

    // Verify _stop sentinel was written
    const sentinelPath = '/tmp/nanoclaw-test-gq/ipc/test-folder/default/input/_stop';
    expect(fs.existsSync(sentinelPath)).toBe(true);
  });

  it('calls stopContainerAsync after 5s grace period', async () => {
    vi.useFakeTimers();

    const fakeProc = { killed: false, kill: vi.fn() } as any;
    queue.registerProcess(groupJid, fakeProc, 'nanoclaw-test-456', 'test-folder', threadId);
    const key = `${groupJid}:${threadId}`;
    (queue as any).threads.get(key).active = true;
    (queue as any).threads.get(key).groupFolder = 'test-folder';

    queue.stopContainer(groupJid, threadId);

    // Before 5s — no hard kill
    expect(stopContainerAsync).not.toHaveBeenCalled();

    // After 5s — hard kill fires
    vi.advanceTimersByTime(5000);
    expect(stopContainerAsync).toHaveBeenCalledWith('nanoclaw-test-456', expect.any(Function));

    vi.useRealTimers();
  });

  it('skips hard kill if container already exited', async () => {
    vi.useFakeTimers();

    const fakeProc = { killed: false, kill: vi.fn() } as any;
    queue.registerProcess(groupJid, fakeProc, 'nanoclaw-test-789', 'test-folder', threadId);
    const key = `${groupJid}:${threadId}`;
    (queue as any).threads.get(key).active = true;
    (queue as any).threads.get(key).groupFolder = 'test-folder';

    queue.stopContainer(groupJid, threadId);

    // Simulate container exiting before timer fires
    (queue as any).threads.get(key).active = false;
    (queue as any).threads.get(key).process = null;

    vi.advanceTimersByTime(5000);
    expect(stopContainerAsync).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/group-queue.test.ts`
Expected: FAIL — `stopContainer` does not exist on GroupQueue

- [ ] **Step 3: Implement `stopContainer` method**

Add the import at the top of `src/group-queue.ts`:

```typescript
import { stopContainerAsync } from './container-runtime.js';
```

Add the method to the `GroupQueue` class (after `closeStdin`):

```typescript
  /**
   * Immediately stop a container for a specific thread.
   * Writes _stop sentinel for graceful SDK abort, then hard-kills after 5s.
   */
  stopContainer(
    groupJid: string,
    threadId: string = 'default',
  ): { stopped: boolean } {
    const thread = this.threads.get(this.threadKey(groupJid, threadId));
    if (!thread?.active || !thread.groupFolder) {
      return { stopped: false };
    }

    // Write _stop sentinel for agent-runner to detect
    const inputDir = path.join(
      DATA_DIR,
      'ipc',
      thread.groupFolder,
      threadId,
      'input',
    );
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_stop'), '');
    } catch {
      // ignore
    }

    // Hard-kill fallback after 5 seconds
    const containerName = thread.containerName;
    if (containerName) {
      setTimeout(() => {
        // Check if container already exited
        if (!thread.active || !thread.process) return;
        logger.warn(
          { groupJid, threadId, containerName },
          'Stop grace period expired, hard-killing container',
        );
        stopContainerAsync(containerName, (err) => {
          if (err) {
            logger.warn(
              { containerName, err },
              'stopContainerAsync failed during /stop',
            );
          }
        });
      }, 5000).unref();
    }

    logger.info({ groupJid, threadId, containerName }, 'Stop requested');
    return { stopped: true };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/group-queue.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/group-queue.ts src/group-queue.test.ts
git commit -m "feat: add stopContainer method to GroupQueue"
```

---

### Task 2: Intercept `/stop` in orchestrator

**Files:**
- Modify: `src/index.ts` (add `/stop` intercept in `onMessage`, add `handleStop` function)

- [ ] **Step 1: Add `handleStop` function**

Add this function inside `main()`, right after the `handleRemoteControl` function (around line 833):

```typescript
  async function handleStop(
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const threadId = msg.thread_context_id
      ? `ctx-${msg.thread_context_id}`
      : 'default';

    const result = queue.stopContainer(chatJid, threadId);
    const reply = result.stopped
      ? 'Session stopped.'
      : 'No active session to stop.';
    await channel.sendMessage(chatJid, reply, msg.thread_context_id);
  }
```

- [ ] **Step 2: Add `/stop` intercept in `onMessage`**

In the `onMessage` callback (around line 839), add the `/stop` check right after the `/remote-control` block:

```typescript
      // Stop command — intercept before storage
      if (trimmed === '/stop') {
        handleStop(chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Stop command error'),
        );
        return;
      }
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Compiles with no errors

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: intercept /stop command in orchestrator"
```

---

### Task 3: Add `_stop` sentinel handling in agent-runner

**Files:**
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: Add `_stop` sentinel constant**

At line 89 (after the `_resume` sentinel), add:

```typescript
const IPC_INPUT_STOP_SENTINEL = path.join(IPC_INPUT_DIR, '_stop');
```

- [ ] **Step 2: Add `shouldStop` function**

After the `shouldClose` function (around line 481), add:

```typescript
/**
 * Check for _stop sentinel — immediate abort requested.
 */
function shouldStop(): boolean {
  if (fs.existsSync(IPC_INPUT_STOP_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_STOP_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}
```

- [ ] **Step 3: Add `_stop` check in `waitForIpcMessage`**

In the `waitForIpcMessage` function's `poll` callback, add a `shouldStop()` check right after the `shouldClose()` check:

```typescript
      if (shouldStop()) {
        resolve(null);
        return;
      }
```

- [ ] **Step 4: Wire `AbortController` into `runTurn`**

Modify the `runTurn` function to accept and use an `AbortController`:

a. Add `abortController` parameter to the function signature:
```typescript
async function runTurn(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  images: ImageAttachment[] | undefined,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
  abortController?: AbortController,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string }> {
```

b. Start a `_stop` watcher interval before the `query()` call (after the `extraDirs` setup, before `for await`):

```typescript
  // Watch for _stop sentinel to abort mid-turn
  const stopWatcher = setInterval(() => {
    if (shouldStop()) {
      log('Stop sentinel detected, aborting query');
      abortController?.abort();
      clearInterval(stopWatcher);
    }
  }, 500);
```

c. Pass `abortController` in the query options (add to the options object):
```typescript
  abortController,
```

d. Wrap the `for await` loop in a `try/finally` to clean up the watcher:
```typescript
  try {
    for await (const message of query({ ... })) {
      // ... existing message handling ...
    }
  } finally {
    clearInterval(stopWatcher);
  }
```

- [ ] **Step 5: Create and pass `AbortController` from `main`**

In the `main` function's `while(true)` loop:

a. Create a new `AbortController` each turn and pass it to `runTurn`:

```typescript
      const abortController = new AbortController();
      // ... (existing try block)
      turnResult = await runTurn(prompt, sessionId, mcpServerPath, containerInput, initialImages, sdkEnv, resumeAt, abortController);
```

Also update the retry path (fresh session retry) to pass a new `AbortController`:
```typescript
          turnResult = await runTurn(prompt, undefined, mcpServerPath, containerInput, initialImages, sdkEnv, undefined, new AbortController());
```

b. After `runTurn` returns, check for `_stop` before waiting for next message:

```typescript
      // Check if stop was requested during or after the turn
      if (shouldStop()) {
        log('Stop sentinel detected after turn, exiting');
        break;
      }
```

c. Clean up stale `_stop` sentinel at startup (near line 745, after the `_close` cleanup):

```typescript
  try { fs.unlinkSync(IPC_INPUT_STOP_SENTINEL); } catch { /* ignore */ }
```

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: Compiles with no errors

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat: add _stop sentinel + AbortController in agent-runner"
```

---

### Task 4: Rebuild container and integration test

**Files:**
- None (build + manual test)

- [ ] **Step 1: Rebuild agent container**

Run: `./container/build.sh`
Expected: Container builds successfully with the new agent-runner code

- [ ] **Step 2: Run all existing tests**

Run: `npx vitest run`
Expected: All tests pass (no regressions)

- [ ] **Step 3: Manual integration test**

1. Start nanoclaw: `systemctl restart nanoclaw`
2. Send a message that triggers a long response (e.g., a complex coding task)
3. While the agent is responding, send `/stop` in the same thread
4. Verify: agent stops, "Session stopped." message appears
5. Send `/stop` when no session is active
6. Verify: "No active session to stop." message appears

- [ ] **Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: address integration test issues for /stop command"
```
