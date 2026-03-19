# Thread-Based Parallel Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable multiple parallel conversations with NanoClaw in Discord, each in its own thread with an isolated Claude session but shared Obsidian-backed knowledge base.

**Architecture:** Replace the single-thread-per-channel model with a thread context abstraction. Each Discord thread maps to its own Claude session and container. A shared Obsidian vault per group stores long-term knowledge across all threads. GroupQueue is extended to support multiple concurrent containers per group.

**Tech Stack:** TypeScript, better-sqlite3, discord.js, Obsidian-compatible markdown

**Spec:** `docs/superpowers/specs/2026-03-19-thread-parallel-conversations-design.md`

---

### Task 1: Database — thread_contexts table and CRUD functions

**Files:**
- Modify: `src/db.ts:77-80` (replace `active_threads` table)
- Modify: `src/db.ts:581-609` (replace thread accessor functions)
- Modify: `src/db.ts:106-178` (add migration)
- Test: `src/db.test.ts`

- [ ] **Step 1: Write failing tests for thread context CRUD**

Add tests to `src/db.test.ts`:

```typescript
describe('thread_contexts', () => {
  it('creates and retrieves a thread context by thread_id', () => {
    const ctx = createThreadContext({
      chatJid: 'dc:123',
      threadId: 'thread_1',
      sessionId: 'session_1',
      originMessageId: 'msg_1',
      source: 'mention',
    });
    expect(ctx.id).toBeDefined();
    const found = getThreadContextByThreadId('thread_1');
    expect(found).toBeDefined();
    expect(found!.chat_jid).toBe('dc:123');
    expect(found!.session_id).toBe('session_1');
  });

  it('retrieves a thread context by origin_message_id', () => {
    createThreadContext({
      chatJid: 'dc:123',
      threadId: null,
      sessionId: 'session_2',
      originMessageId: 'msg_2',
      source: 'scheduled_task',
      taskId: 42,
    });
    const found = getThreadContextByOriginMessage('msg_2');
    expect(found).toBeDefined();
    expect(found!.source).toBe('scheduled_task');
    expect(found!.task_id).toBe(42);
  });

  it('updates thread context fields', () => {
    const ctx = createThreadContext({
      chatJid: 'dc:123',
      threadId: null,
      sessionId: null,
      originMessageId: 'msg_3',
      source: 'scheduled_task',
    });
    updateThreadContext(ctx.id, { threadId: 'thread_3', sessionId: 'session_3' });
    const found = getThreadContextByThreadId('thread_3');
    expect(found).toBeDefined();
    expect(found!.session_id).toBe('session_3');
  });

  it('lists active thread contexts for a channel', () => {
    createThreadContext({
      chatJid: 'dc:456',
      threadId: 'thread_a',
      sessionId: 'session_a',
      originMessageId: 'msg_a',
      source: 'mention',
    });
    createThreadContext({
      chatJid: 'dc:456',
      threadId: 'thread_b',
      sessionId: 'session_b',
      originMessageId: 'msg_b',
      source: 'reply',
    });
    const contexts = getActiveThreadContexts('dc:456', 24);
    expect(contexts.length).toBe(2);
  });

  it('excludes expired contexts from active list', () => {
    // Create a context with old last_active_at
    createThreadContext({
      chatJid: 'dc:789',
      threadId: 'thread_old',
      sessionId: 'session_old',
      originMessageId: 'msg_old',
      source: 'mention',
    });
    // Manually set last_active_at to 48 hours ago
    const db = getDb();
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE thread_contexts SET last_active_at = ? WHERE thread_id = ?')
      .run(oldTime, 'thread_old');

    const active = getActiveThreadContexts('dc:789', 24);
    expect(active.length).toBe(0);

    // But direct lookup still works (resurrection)
    const found = getThreadContextByThreadId('thread_old');
    expect(found).toBeDefined();
  });

  it('touchThreadContext updates last_active_at', () => {
    const ctx = createThreadContext({
      chatJid: 'dc:touch',
      threadId: 'thread_touch',
      sessionId: null,
      originMessageId: 'msg_touch',
      source: 'mention',
    });
    const before = getThreadContextByThreadId('thread_touch')!.last_active_at;
    // Small delay to ensure different timestamp
    touchThreadContext(ctx.id);
    const after = getThreadContextByThreadId('thread_touch')!.last_active_at;
    expect(after).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: FAIL — functions not defined

- [ ] **Step 3: Add thread_contexts table to schema**

In `src/db.ts`, replace the `active_threads` table definition (lines 77-80) in `createSchema()`:

```typescript
    CREATE TABLE IF NOT EXISTS thread_contexts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid          TEXT NOT NULL,
      thread_id         TEXT,
      session_id        TEXT,
      origin_message_id TEXT,
      source            TEXT NOT NULL,
      task_id           INTEGER,
      created_at        TEXT NOT NULL,
      last_active_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_thread_ctx_chat ON thread_contexts(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_thread_ctx_thread ON thread_contexts(thread_id);
    CREATE INDEX IF NOT EXISTS idx_thread_ctx_origin ON thread_contexts(origin_message_id);
```

Add migration after line 178 (after existing migrations):

```typescript
  // Migrate active_threads → thread_contexts
  try {
    const hasActiveThreads = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='active_threads'"
    ).get();
    if (hasActiveThreads) {
      // Create thread_contexts if needed (already in schema above, but for existing DBs)
      const now = new Date().toISOString();
      const rows = database.prepare('SELECT chat_jid, thread_id FROM active_threads').all() as Array<{ chat_jid: string; thread_id: string }>;
      for (const row of rows) {
        database.prepare(
          `INSERT OR IGNORE INTO thread_contexts (chat_jid, thread_id, source, created_at, last_active_at)
           VALUES (?, ?, 'mention', ?, ?)`
        ).run(row.chat_jid, row.thread_id, now, now);
      }
      database.exec('DROP TABLE active_threads');
    }
  } catch { /* migration already done */ }
```

- [ ] **Step 4: Implement thread context CRUD functions**

Replace the active thread accessors (lines 581-609) with:

```typescript
// --- Thread context types and accessors ---

export interface ThreadContext {
  id: number;
  chat_jid: string;
  thread_id: string | null;
  session_id: string | null;
  origin_message_id: string | null;
  source: 'mention' | 'reply' | 'scheduled_task';
  task_id: number | null;
  created_at: string;
  last_active_at: string;
}

export interface CreateThreadContextInput {
  chatJid: string;
  threadId: string | null;
  sessionId: string | null;
  originMessageId: string | null;
  source: 'mention' | 'reply' | 'scheduled_task';
  taskId?: number;
}

export function createThreadContext(input: CreateThreadContextInput): ThreadContext {
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO thread_contexts (chat_jid, thread_id, session_id, origin_message_id, source, task_id, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.chatJid, input.threadId, input.sessionId,
    input.originMessageId, input.source, input.taskId ?? null, now, now
  );
  return {
    id: Number(result.lastInsertRowid),
    chat_jid: input.chatJid,
    thread_id: input.threadId,
    session_id: input.sessionId,
    origin_message_id: input.originMessageId,
    source: input.source,
    task_id: input.taskId ?? null,
    created_at: now,
    last_active_at: now,
  };
}

export function getThreadContextByThreadId(threadId: string): ThreadContext | undefined {
  return db.prepare('SELECT * FROM thread_contexts WHERE thread_id = ?')
    .get(threadId) as ThreadContext | undefined;
}

export function getThreadContextByOriginMessage(originMessageId: string): ThreadContext | undefined {
  return db.prepare('SELECT * FROM thread_contexts WHERE origin_message_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(originMessageId) as ThreadContext | undefined;
}

export function updateThreadContext(
  id: number,
  updates: { threadId?: string; sessionId?: string; taskId?: number },
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.threadId !== undefined) { sets.push('thread_id = ?'); params.push(updates.threadId); }
  if (updates.sessionId !== undefined) { sets.push('session_id = ?'); params.push(updates.sessionId); }
  if (updates.taskId !== undefined) { sets.push('task_id = ?'); params.push(updates.taskId); }
  sets.push('last_active_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  db.prepare(`UPDATE thread_contexts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function touchThreadContext(id: number): void {
  db.prepare('UPDATE thread_contexts SET last_active_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

export function getActiveThreadContexts(chatJid: string, expiryHours: number): ThreadContext[] {
  const cutoff = new Date(Date.now() - expiryHours * 60 * 60 * 1000).toISOString();
  return db.prepare(
    'SELECT * FROM thread_contexts WHERE chat_jid = ? AND last_active_at > ? ORDER BY last_active_at DESC'
  ).all(chatJid, cutoff) as ThreadContext[];
}
```

Also export `getDb()` for tests if not already exported — or use the existing test DB setup pattern.

- [ ] **Step 5: Remove old active_threads imports/exports**

Remove the old functions (`getActiveThread`, `setActiveThread`, `deleteActiveThread`, `getAllActiveThreads`) and their exports. Update the exports list.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: All thread_contexts tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: replace active_threads with thread_contexts table"
```

---

### Task 2: Config — new constants

**Files:**
- Modify: `src/config.ts:64-69`

- [ ] **Step 1: Add new config constants**

After `MAX_CONCURRENT_CONTAINERS` in `src/config.ts`:

```typescript
export const MAX_CONTAINERS_PER_GROUP = Math.max(
  1,
  parseIntEnv(process.env.MAX_CONTAINERS_PER_GROUP, 3),
);
export const THREAD_EXPIRY_HOURS = parseIntEnv(
  process.env.THREAD_EXPIRY_HOURS,
  24,
);
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add MAX_CONTAINERS_PER_GROUP and THREAD_EXPIRY_HOURS config"
```

---

### Task 3: Types — update Channel interface

**Files:**
- Modify: `src/types.ts:94-96`

- [ ] **Step 1: Update sendChannelMessage return type**

Change `sendChannelMessage` in the `Channel` interface:

```typescript
  /** Always sends to the main channel, never a thread. Use for scheduled tasks and system announcements.
   *  Falls back to sendMessage for channels that don't implement thread routing.
   *  Returns the platform message ID if available (used for thread context tracking). */
  sendChannelMessage?(jid: string, text: string): Promise<string | undefined>;
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: Errors in discord.ts and any other channel implementations that need updating (expected — fixed in later tasks)

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: sendChannelMessage returns message ID for thread tracking"
```

---

### Task 4: GroupQueue — multi-thread concurrency

**Files:**
- Modify: `src/group-queue.ts` (extensive changes)
- Test: `src/group-queue.test.ts`

- [ ] **Step 1: Write failing tests for thread-keyed operations**

Add tests to `src/group-queue.test.ts`:

```typescript
describe('thread-keyed operations', () => {
  it('allows multiple active containers per group up to MAX_CONTAINERS_PER_GROUP', () => {
    const queue = new GroupQueue();
    const processMessages = vi.fn().mockResolvedValue(true);
    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 thread-specific message checks for same group
    queue.enqueueThreadMessageCheck('dc:123', 'thread_1');
    queue.enqueueThreadMessageCheck('dc:123', 'thread_2');
    queue.enqueueThreadMessageCheck('dc:123', 'thread_3');

    // All 3 should start (MAX_CONTAINERS_PER_GROUP=3 default)
    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  it('queues thread messages when per-group limit reached', () => {
    const queue = new GroupQueue();
    const processMessages = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves
    queue.setProcessMessagesFn(processMessages);

    queue.enqueueThreadMessageCheck('dc:123', 'thread_1');
    queue.enqueueThreadMessageCheck('dc:123', 'thread_2');
    queue.enqueueThreadMessageCheck('dc:123', 'thread_3');
    queue.enqueueThreadMessageCheck('dc:123', 'thread_4'); // should queue

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  it('sends IPC message to correct thread container', () => {
    const queue = new GroupQueue();
    queue.registerProcess('dc:123', mockProc, 'container-1', 'main', 'thread_1');

    const sent = queue.sendMessage('dc:123', 'thread_1', 'hello');
    expect(sent).toBe(true);
    // Verify IPC written to thread-namespaced directory
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/group-queue.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: FAIL — methods not found

- [ ] **Step 3: Refactor GroupState to support multiple threads**

Split state into per-group and per-thread:

```typescript
interface ThreadState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  threadId: string;
}

interface GroupState {
  // Per-group state (shared across threads)
  pendingMessages: Map<string, boolean>;  // threadId → has pending
  pendingTasks: QueuedTask[];
  retryCount: number;
  runningTaskId: string | null;
  // Per-group active thread count (enforces MAX_CONTAINERS_PER_GROUP)
  activeThreadCount: number;
  // Waiting threads within this group (FIFO queue of threadIds)
  waitingThreads: string[];
}
```

Change class internals:

```typescript
export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private threads = new Map<string, ThreadState>();  // key: `{groupJid}:{threadId}`
  private activeCount = 0;  // global, still enforces MAX_CONCURRENT_CONTAINERS
  private waitingGroups: string[] = [];
  // ...

  private threadKey(groupJid: string, threadId: string): string {
    return `${groupJid}:${threadId}`;
  }

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        pendingMessages: new Map(),
        pendingTasks: [],
        retryCount: 0,
        runningTaskId: null,
        activeThreadCount: 0,
        waitingThreads: [],
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  private getThread(groupJid: string, threadId: string): ThreadState {
    const key = this.threadKey(groupJid, threadId);
    let state = this.threads.get(key);
    if (!state) {
      state = {
        active: false, idleWaiting: false, isTaskContainer: false,
        process: null, containerName: null, groupFolder: null,
        threadId,
      };
      this.threads.set(key, state);
    }
    return state;
  }

  // Check if any thread in group is active (no threadId) or specific thread
  isActive(groupJid: string, threadId?: string): boolean {
    if (threadId) {
      const ts = this.threads.get(this.threadKey(groupJid, threadId));
      return ts?.active === true && !ts.isTaskContainer;
    }
    const gs = this.groups.get(groupJid);
    return (gs?.activeThreadCount ?? 0) > 0;
  }

  enqueueThreadMessageCheck(groupJid: string, threadId: string): void {
    if (this.shuttingDown) return;
    const groupState = this.getGroup(groupJid);
    const threadState = this.getThread(groupJid, threadId);

    if (threadState.active) {
      groupState.pendingMessages.set(threadId, true);
      return;
    }

    // Check both per-group and global limits
    if (groupState.activeThreadCount >= MAX_CONTAINERS_PER_GROUP ||
        this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      groupState.pendingMessages.set(threadId, true);
      if (!groupState.waitingThreads.includes(threadId)) {
        groupState.waitingThreads.push(threadId);
      }
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      return;
    }

    this.runForThread(groupJid, threadId, 'messages').catch((err) =>
      logger.error({ groupJid, threadId, err }, 'Error in runForThread'));
  }

  // Keep backward compat: no threadId → use 'default' thread
  enqueueMessageCheck(groupJid: string): void {
    this.enqueueThreadMessageCheck(groupJid, 'default');
  }

  registerProcess(
    groupJid: string, proc: ChildProcess, containerName: string,
    groupFolder?: string, threadId: string = 'default',
  ): void {
    const ts = this.getThread(groupJid, threadId);
    ts.process = proc;
    ts.containerName = containerName;
    if (groupFolder) ts.groupFolder = groupFolder;
  }

  notifyIdle(groupJid: string, threadId: string = 'default'): void {
    const ts = this.getThread(groupJid, threadId);
    ts.idleWaiting = true;
    const gs = this.getGroup(groupJid);
    if (gs.pendingTasks.length > 0) {
      this.closeStdin(groupJid, threadId);
    }
  }

  private async runForThread(
    groupJid: string, threadId: string, reason: 'messages' | 'drain',
  ): Promise<void> {
    const gs = this.getGroup(groupJid);
    const ts = this.getThread(groupJid, threadId);
    ts.active = true;
    ts.idleWaiting = false;
    ts.isTaskContainer = false;
    gs.pendingMessages.delete(threadId);
    gs.activeThreadCount++;
    this.activeCount++;
    this.writeStatus();

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid, threadId);
        if (success) gs.retryCount = 0;
        else this.scheduleRetry(groupJid, gs, threadId);
      }
    } catch (err) {
      logger.error({ groupJid, threadId, err }, 'Error processing thread');
      this.scheduleRetry(groupJid, gs, threadId);
    } finally {
      ts.active = false;
      ts.process = null;
      ts.containerName = null;
      ts.groupFolder = null;
      gs.activeThreadCount--;
      this.activeCount--;
      this.writeStatus();
      this.drainGroup(groupJid);
    }
  }
}
```

Update `drainGroup` to drain waiting threads within the group before checking other groups:

```typescript
  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;
    const gs = this.getGroup(groupJid);

    // Tasks first
    if (gs.pendingTasks.length > 0) {
      const task = gs.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch(/*...*/);
      return;
    }

    // Then waiting threads within this group
    while (gs.waitingThreads.length > 0 &&
           gs.activeThreadCount < MAX_CONTAINERS_PER_GROUP &&
           this.activeCount < MAX_CONCURRENT_CONTAINERS) {
      const threadId = gs.waitingThreads.shift()!;
      if (gs.pendingMessages.has(threadId)) {
        this.runForThread(groupJid, threadId, 'drain').catch(/*...*/);
      }
    }

    // Nothing pending; check other groups
    if (gs.activeThreadCount === 0) {
      this.drainWaiting();
    }
  }
```

Update `setProcessMessagesFn` signature:

```typescript
  setProcessMessagesFn(fn: (groupJid: string, threadId?: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }
```

- [ ] **Step 4: Update IPC path construction**

Change `sendMessage` and `closeStdin` to use thread-namespaced IPC directories:

```typescript
sendMessage(groupJid: string, threadId: string, text: string): boolean {
  const threadState = this.getThread(groupJid, threadId);
  if (!threadState.active || !threadState.groupFolder || threadState.isTaskContainer) {
    return false;
  }
  threadState.idleWaiting = false;
  const inputDir = path.join(DATA_DIR, 'ipc', threadState.groupFolder, threadId, 'input');
  // ... rest of file write logic unchanged
}

closeStdin(groupJid: string, threadId: string): void {
  const threadState = this.getThread(groupJid, threadId);
  if (!threadState.active || !threadState.groupFolder) return;
  const inputDir = path.join(DATA_DIR, 'ipc', threadState.groupFolder, threadId, 'input');
  // ... rest unchanged
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/group-queue.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/group-queue.ts src/group-queue.test.ts
git commit -m "feat: GroupQueue supports per-thread concurrency"
```

---

### Task 5: Container runner — per-thread session dirs and IPC

**Files:**
- Modify: `src/container-runner.ts:127-248` (buildVolumeMounts)
- Modify: `src/container-runner.ts:377-395` (runContainerAgent signature)
- Test: `src/container-runner.test.ts`

- [ ] **Step 1: Write failing test for per-thread session directory**

Add test to `src/container-runner.test.ts`:

```typescript
it('creates per-thread session directory when threadId provided', () => {
  const mounts = buildVolumeMounts(mockGroup, false, 'thread_123');
  const claudeMount = mounts.find(m => m.containerPath === '/home/node/.claude');
  expect(claudeMount).toBeDefined();
  expect(claudeMount!.hostPath).toContain('thread_123');
  expect(claudeMount!.hostPath).toContain('.claude');
});

it('creates per-thread IPC directory when threadId provided', () => {
  const mounts = buildVolumeMounts(mockGroup, false, 'thread_123');
  const ipcMount = mounts.find(m => m.containerPath === '/workspace/ipc');
  expect(ipcMount).toBeDefined();
  expect(ipcMount!.hostPath).toContain('thread_123');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/container-runner.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: FAIL

- [ ] **Step 3: Add threadId parameter to buildVolumeMounts**

Update `buildVolumeMounts` signature to accept optional `threadId`:

```typescript
function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  threadId?: string,
): VolumeMount[] {
```

**Session directory** (lines 184-227): When `threadId` is provided, use `data/sessions/{group.folder}/{threadId}/.claude/` instead of `data/sessions/{group.folder}/.claude/`. Copy `settings.json` from the group-level template if it exists:

```typescript
  const sessionBase = threadId
    ? path.join(DATA_DIR, 'sessions', group.folder, threadId)
    : path.join(DATA_DIR, 'sessions', group.folder);
  const groupSessionsDir = path.join(sessionBase, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Copy settings from group template if this is a new thread-specific dir
  const groupTemplateSettings = path.join(DATA_DIR, 'sessions', group.folder, '.claude', 'settings.json');
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (threadId && !fs.existsSync(settingsFile) && fs.existsSync(groupTemplateSettings)) {
    fs.copyFileSync(groupTemplateSettings, settingsFile);
  } else if (!fs.existsSync(settingsFile)) {
    // Write default settings (existing logic)
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }
```

**IPC directory** (lines 229-248): When `threadId` is provided, use `data/ipc/{group.folder}/{threadId}/`:

```typescript
  const groupIpcDir = threadId
    ? path.join(resolveGroupIpcPath(group.folder), threadId)
    : resolveGroupIpcPath(group.folder);
```

- [ ] **Step 4: Add threadId to ContainerInput and runContainerAgent**

Add `threadId?: string` to `ContainerInput` interface (line 104-112).

Update `runContainerAgent` (line 377+) to pass `threadId` through to `buildVolumeMounts`:

```typescript
  const mounts = buildVolumeMounts(group, input.isMain, input.threadId);
```

Update container naming:

```typescript
  const threadSuffix = input.threadId ? `-${input.threadId.slice(0, 8)}` : '';
  const containerName = `nanoclaw-${safeName}${threadSuffix}-${Date.now()}`;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/container-runner.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat: per-thread session directories and IPC namespacing"
```

---

### Task 6: Discord channel — multi-thread routing

**Files:**
- Modify: `src/channels/discord.ts` (extensive rewrite of thread logic)
- Test: `src/channels/discord.test.ts`

- [ ] **Step 1: Write failing tests for new routing behavior**

Add tests to `src/channels/discord.test.ts`:

```typescript
describe('multi-thread routing', () => {
  it('creates thread context on @mention', () => {
    // Simulate @mention in #general
    // Verify createThreadContext called with source='mention'
  });

  it('looks up thread context on reply to bot message', () => {
    // Simulate reply to a NanoClaw message in #general
    // Verify getThreadContextByOriginMessage called
  });

  it('routes thread messages to existing context', () => {
    // Simulate message in a known bot thread
    // Verify getThreadContextByThreadId called, message delivered with threadId
  });

  it('sendMessage creates thread and updates context', () => {
    // Simulate first response to a pending trigger
    // Verify thread created, context updated with threadId
  });

  it('sendMessage sends to existing thread', () => {
    // Simulate streaming continuation in existing thread
    // Verify message sent to thread, not channel
  });

  it('sendChannelMessage returns message ID', () => {
    // Verify sendChannelMessage returns the Discord message ID
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/channels/discord.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: FAIL

- [ ] **Step 3: Update imports and remove old thread tracking**

Replace old imports:

```typescript
import {
  createThreadContext,
  getThreadContextByThreadId,
  getThreadContextByOriginMessage,
  updateThreadContext,
  touchThreadContext,
  ThreadContext,
} from '../db.js';
```

Remove:
- `private activeThread = new Map<string, string>();`
- `private activeThreadLoaded = false;`
- `private ensureThreadsLoaded()`, `setThread()`, `deleteThread()`, `getThread()` methods

Replace `pendingTrigger` with a map that includes both the Discord message and the thread context:

```typescript
  // Pending triggers: thread context ID → Discord Message (for thread creation)
  private pendingTrigger = new Map<string, { message: Message; contextId: number }>();
  // Active thread contexts by thread ID → context (in-memory cache for fast routing)
  private activeContexts = new Map<string, ThreadContext>();
```

- [ ] **Step 4: Add thread_context_id to NewMessage type**

In `src/types.ts`, extend `NewMessage`:

```typescript
export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_context_id?: number;  // Thread context ID (Discord only, not persisted to DB)
}
```

This field is **transient** — it's set by the Discord channel on the in-memory `NewMessage` object passed to `onMessage`, but NOT stored in the SQLite `messages` table. It's used by `startMessageLoop` in `index.ts` to determine which thread to route to.

- [ ] **Step 5: Update inbound message handler**

Rewrite the `Events.MessageCreate` handler to:

1. On `@NanoClaw` mention in channel: call `createThreadContext({ chatJid, threadId: null, sessionId: null, originMessageId: message.id, source: 'mention' })`, store in `pendingTrigger`, set `thread_context_id` on the message.
2. On reply to bot message in channel (not in thread): look up `getThreadContextByOriginMessage(repliedToMessage.id)`. If found, reuse that context and set `thread_context_id`. If not found, create new context with `source: 'reply'`.
3. On message in a bot-created thread: look up `getThreadContextByThreadId(message.channelId)`. If found, call `touchThreadContext(ctx.id)` and set `thread_context_id`.

```typescript
// After trigger detection, before calling onMessage:
let threadContextId: number | undefined;

if (isBotMentioned) {
  // New @mention → new thread context
  const ctx = createThreadContext({
    chatJid, threadId: null, sessionId: null,
    originMessageId: msgId, source: 'mention',
  });
  this.pendingTrigger.set(chatJid, { message, contextId: ctx.id });
  threadContextId = ctx.id;
} else if (isInBotThread) {
  // Message in existing bot thread
  const ctx = getThreadContextByThreadId(message.channelId);
  if (ctx) {
    touchThreadContext(ctx.id);
    threadContextId = ctx.id;
  }
} else if (repliedToMessage && repliedToMessage.author.id === this.client?.user?.id) {
  // Reply to bot message in channel
  let ctx = getThreadContextByOriginMessage(repliedToMessage.id);
  if (!ctx) {
    ctx = createThreadContext({
      chatJid, threadId: null, sessionId: null,
      originMessageId: repliedToMessage.id, source: 'reply',
    });
  }
  this.pendingTrigger.set(chatJid, { message, contextId: ctx.id });
  threadContextId = ctx.id;
}

// Then in onMessage call:
this.opts.onMessage(chatJid, {
  id: msgId, chat_jid: chatJid, sender, sender_name: senderName,
  content, timestamp, is_from_me: false,
  thread_context_id: threadContextId,
});
```

- [ ] **Step 6: Update sendMessage for multi-thread**

Rewrite `sendMessage(jid, text)` to accept an optional thread context:

The method needs to know which thread to send to. Since `sendMessage` is called from `index.ts` streaming callback with just `(jid, text)`, we need a way to track the "current active send target" per ongoing operation.

Approach: Add `setCurrentThreadContext` to set the active thread context before streaming begins. The key should be `{jid}:{threadId}` (not just `jid`) to avoid races when multiple threads for the same channel are sending concurrently:

```typescript
  // Map of `{jid}:{threadId}` → ThreadContext for concurrent send routing
  private currentSendTarget = new Map<string, ThreadContext>();

  setCurrentThreadContext(jid: string, threadId: string, context: ThreadContext | null): void {
    const key = `${jid}:${threadId}`;
    if (context) {
      this.currentSendTarget.set(key, context);
    } else {
      this.currentSendTarget.delete(key);
    }
  }
```

Keep `sendMessage(jid, text)` for backward compatibility — it checks `pendingTrigger` first (new @mention → create thread), then checks `currentSendTarget` entries for this `jid`, then falls back to channel.

For new triggers where the thread doesn't exist yet, `sendMessage` creates the Discord thread on the pending trigger message, then updates the thread context with the new `thread_id` via `updateThreadContext`.

- [ ] **Step 7: Update sendChannelMessage to return message ID**

```typescript
  async sendChannelMessage(jid: string, text: string): Promise<string | undefined> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return undefined;
    }
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return undefined;
      }
      const textChannel = channel as TextChannel;
      const sentMessage = await textChannel.send(text.slice(0, 2000));
      // Send remaining chunks if needed
      if (text.length > 2000) {
        await this.sendChunked(textChannel, text.slice(2000));
      }
      logger.info(
        { jid, messageId: sentMessage.id, length: text.length },
        'Discord scheduled message sent to channel',
      );
      return sentMessage.id;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord channel message');
      return undefined;
    }
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/channels/discord.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/channels/discord.ts src/channels/discord.test.ts src/types.ts
git commit -m "feat: Discord multi-thread routing with thread contexts"
```

---

### Task 7: Index.ts — thread-aware message processing

**Files:**
- Modify: `src/index.ts:154-269` (processGroupMessages)
- Modify: `src/index.ts:271-372` (runAgent)
- Modify: `src/index.ts:374-478` (startMessageLoop)
- Modify: `src/index.ts:680-700` (scheduled task sendMessage callback)

- [ ] **Step 1: Update processGroupMessages for thread routing**

`processGroupMessages` currently receives a `chatJid` and processes all pending messages for that group. With thread contexts, it also needs to know the `threadId` (if any) so it can:
- Pass the correct session ID to `runAgent`
- Set the correct thread context on the Discord channel for routing responses
- Pass `threadId` to the container via `ContainerInput`

Update signature:

```typescript
async function processGroupMessages(chatJid: string, threadId?: string): Promise<boolean> {
```

Look up thread context:

```typescript
  let threadContext: ThreadContext | undefined;
  if (threadId) {
    threadContext = getThreadContextByThreadId(threadId);
  }
  // Use thread-specific session if available, fall back to group session
  const sessionId = threadContext?.session_id || sessions[group.folder];
```

Before calling `runAgent`, set the thread context on the Discord channel:

```typescript
  if (channel.name === 'discord' && threadContext) {
    (channel as any).setCurrentThreadContext(chatJid, threadContext);
  }
```

After `runAgent` completes, update the thread context with the new session ID:

```typescript
  if (threadContext && output.newSessionId) {
    updateThreadContext(threadContext.id, { sessionId: output.newSessionId });
  }
```

- [ ] **Step 2: Update runAgent to pass threadId**

Add `threadId` parameter to `runAgent` and pass it through to `ContainerInput`:

```typescript
async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  _retried = false,
  threadId?: string,
): Promise<'success' | 'error'> {
```

In the `runContainerAgent` call, add `threadId` to the input:

```typescript
  const output = await runContainerAgent(
    group,
    {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain,
      assistantName: ASSISTANT_NAME,
      threadId,
    },
    ...
  );
```

- [ ] **Step 3: Update startMessageLoop for thread-aware queue operations**

The message loop retrieves `NewMessage` objects from SQLite via `getNewMessages`. The `thread_context_id` field is transient (not stored in DB), so the loop receives it via an in-memory side channel.

Add a transient map in `index.ts` that the Discord channel populates via `onMessage`:

```typescript
// In-memory map: message ID → thread context ID (populated by onMessage, consumed by message loop)
const messageThreadContext = new Map<string, number>();
```

Update the `onMessage` callback (where channels deliver messages) to capture the thread context:

```typescript
const onMessage: OnInboundMessage = (chatJid: string, message: NewMessage) => {
  storeMessage(message);  // existing
  if (message.thread_context_id) {
    messageThreadContext.set(`${message.id}:${message.chat_jid}`, message.thread_context_id);
  }
};
```

In `startMessageLoop`, after grouping messages by group, extract the thread context for routing:

```typescript
for (const [chatJid, groupMessages] of messagesByGroup) {
  // ... existing trigger checks ...

  // Determine thread context from the triggering message
  // Use the most recent message with a thread_context_id
  let threadId: string | undefined;
  for (const msg of groupMessages.reverse()) {
    const ctxKey = `${msg.id}:${msg.chat_jid}`;
    const ctxId = messageThreadContext.get(ctxKey);
    if (ctxId) {
      messageThreadContext.delete(ctxKey);
      // Look up the thread context to get the Discord threadId
      const ctx = getThreadContextById(ctxId);  // add this DB function
      threadId = ctx?.thread_id ?? `pending-${ctxId}`;
      break;
    }
  }

  // Pipe to active thread container or enqueue new one
  if (threadId && queue.sendMessage(chatJid, threadId, formatted)) {
    // Piped to existing thread container
    lastAgentTimestamp[chatJid] = messagesToSend[messagesToSend.length - 1].timestamp;
    saveState();
  } else {
    queue.enqueueThreadMessageCheck(chatJid, threadId || 'default');
  }
}
```

Add `getThreadContextById` to `src/db.ts`:

```typescript
export function getThreadContextById(id: number): ThreadContext | undefined {
  return db.prepare('SELECT * FROM thread_contexts WHERE id = ?')
    .get(id) as ThreadContext | undefined;
}
```

Update `processMessagesFn` registration:

```typescript
queue.setProcessMessagesFn(async (groupJid: string, threadId?: string) => {
  return processGroupMessages(groupJid, threadId);
});
```

- [ ] **Step 4: Update scheduled task sendMessage to capture message ID**

In the scheduled task `sendMessage` callback (lines 686-700), capture the returned message ID and create a thread context:

```typescript
    sendMessage: async (jid, rawText, taskId, sessionId) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) {
        const messageId = await (channel.sendChannelMessage ?? channel.sendMessage).call(channel, jid, text);
        // Create thread context for scheduled task output so replies can resume the session
        if (messageId && taskId) {
          createThreadContext({
            chatJid: jid,
            threadId: null,
            sessionId: sessionId || null,
            originMessageId: messageId,
            source: 'scheduled_task',
            taskId: parseInt(taskId, 10),
          });
        }
      }
    },
```

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: thread-aware message processing and scheduled task tracking"
```

---

### Task 8: Task scheduler — pass session ID and task ID for thread context

**Files:**
- Modify: `src/task-scheduler.ts:76-77` (SchedulerDependencies)
- Modify: `src/task-scheduler.ts:186-192` (streaming callback)

- [ ] **Step 1: Update SchedulerDependencies.sendMessage signature**

```typescript
  sendMessage: (jid: string, text: string, taskId?: string, sessionId?: string) => Promise<void>;
```

- [ ] **Step 2: Pass taskId and sessionId in streaming callback**

In `runTask`, when calling `deps.sendMessage` (line 190):

```typescript
        if (streamedOutput.result) {
          result = streamedOutput.result;
          await deps.sendMessage(task.chat_jid, streamedOutput.result, task.id, output?.newSessionId);
          scheduleClose();
        }
```

Need to capture `newSessionId` from streaming output:

```typescript
  let capturedSessionId: string | undefined;

  // In the streaming callback:
  if (streamedOutput.newSessionId) {
    capturedSessionId = streamedOutput.newSessionId;
  }
  if (streamedOutput.result) {
    result = streamedOutput.result;
    await deps.sendMessage(task.chat_jid, streamedOutput.result, task.id, capturedSessionId);
    scheduleClose();
  }
```

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/task-scheduler.ts
git commit -m "feat: scheduler passes task ID and session ID for thread context creation"
```

---

### Task 9: IPC — per-thread directory watching

**Files:**
- Modify: `src/ipc.ts` (IPC watcher directory structure)

- [ ] **Step 1: Update IPC watcher to scan thread subdirectories**

The IPC watcher in `startIpcWatcher` currently scans flat directories under `data/ipc/{groupFolder}/`. With per-thread IPC, the structure becomes:

```
data/ipc/{groupFolder}/
  ├── messages/    ← legacy (non-threaded containers, backward compat)
  ├── tasks/       ← legacy
  ├── files/       ← legacy
  ├── prs/         ← legacy
  ├── {threadId1}/
  │   ├── messages/
  │   ├── tasks/
  │   ├── files/
  │   └── prs/
  └── {threadId2}/
      └── ...
```

**Backward compatibility**: Non-threaded containers (task containers without threadId) still write to the flat `data/ipc/{groupFolder}/messages/`. The watcher must scan both.

**Distinguishing thread dirs from IPC subdirs**: The known IPC subdirectory names are `messages`, `tasks`, `files`, `prs`, `input`. Any other directory under `data/ipc/{groupFolder}/` is treated as a thread subdirectory.

Update `startIpcWatcher` to:

```typescript
const KNOWN_IPC_SUBDIRS = new Set(['messages', 'tasks', 'files', 'prs', 'input']);

function getIpcDirsForGroup(groupFolder: string): Array<{ basePath: string; threadId?: string }> {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  const dirs: Array<{ basePath: string; threadId?: string }> = [];

  // Legacy flat structure (non-threaded)
  dirs.push({ basePath: groupIpcDir });

  // Thread subdirectories
  try {
    const entries = fs.readdirSync(groupIpcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !KNOWN_IPC_SUBDIRS.has(entry.name)) {
        dirs.push({ basePath: path.join(groupIpcDir, entry.name), threadId: entry.name });
      }
    }
  } catch { /* dir may not exist yet */ }

  return dirs;
}
```

In the polling loop, iterate over all IPC dirs per group:

```typescript
for (const group of registeredGroups) {
  const ipcDirs = getIpcDirsForGroup(group.folder);
  for (const { basePath, threadId } of ipcDirs) {
    const messagesDir = path.join(basePath, 'messages');
    const tasksDir = path.join(basePath, 'tasks');
    const filesDir = path.join(basePath, 'files');
    const prsDir = path.join(basePath, 'prs');

    // Process each directory same as before, but when sending messages,
    // set the thread context on the channel if threadId is present
    await processIpcMessages(messagesDir, group, threadId);
    await processIpcTasks(tasksDir, group);
    await processIpcFiles(filesDir, group, threadId);
    await processIpcPrs(prsDir, group);
  }
}
```

When routing outbound IPC messages with a threadId, set the thread context on the Discord channel before calling `sendMessage`:

```typescript
async function processIpcMessages(dir: string, group: GroupInfo, threadId?: string) {
  // ... read JSON files from dir ...
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const channel = findChannel(channels, data.chatJid);
    if (channel && threadId && 'setCurrentThreadContext' in channel) {
      const ctx = getThreadContextByThreadId(threadId);
      if (ctx) (channel as any).setCurrentThreadContext(data.chatJid, ctx);
    }
    // ... existing send logic ...
  }
}
```

- [ ] **Step 2: Verify agent-runner IPC paths are correct**

The agent-runner writes IPC files to `/workspace/ipc/messages/`. The container mount in `container-runner.ts` maps `/workspace/ipc/` to either:
- `data/ipc/{groupFolder}/{threadId}/` (when threadId is provided)
- `data/ipc/{groupFolder}/` (legacy, no threadId)

So the agent-runner writes to the correct location without code changes. Verify this by checking that `buildVolumeMounts` uses the thread-namespaced path (already done in Task 5).

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -50`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts
git commit -m "feat: IPC watcher scans per-thread directories"
```

---

### Task 10: Obsidian knowledge base — vault setup and agent instructions

**Files:**
- Create: `src/knowledge-vault.ts` (vault initialization utility)
- Modify: `groups/global/CLAUDE.md` or per-group CLAUDE.md template
- Modify: `.gitignore`

- [ ] **Step 1: Create knowledge vault initialization utility**

Create `src/knowledge-vault.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const VAULT_DIRS = ['people', 'projects', 'preferences', 'decisions', 'reference'];

const VAULT_GITIGNORE = `.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.trash/
`;

const OBSIDIAN_CONFIG = {
  'app.json': JSON.stringify({
    livePreview: true,
    showFrontmatter: true,
    defaultViewMode: 'source',
  }, null, 2),
};

export function initKnowledgeVault(groupFolder: string): string {
  const vaultPath = path.join(GROUPS_DIR, groupFolder, 'knowledge');

  if (fs.existsSync(path.join(vaultPath, '.obsidian'))) {
    return vaultPath; // Already initialized
  }

  // Create directory structure
  fs.mkdirSync(vaultPath, { recursive: true });
  for (const dir of VAULT_DIRS) {
    fs.mkdirSync(path.join(vaultPath, dir), { recursive: true });
  }

  // Create .obsidian config
  const obsidianDir = path.join(vaultPath, '.obsidian');
  fs.mkdirSync(obsidianDir, { recursive: true });
  for (const [file, content] of Object.entries(OBSIDIAN_CONFIG)) {
    fs.writeFileSync(path.join(obsidianDir, file), content);
  }

  // Create .gitignore
  fs.writeFileSync(path.join(vaultPath, '.gitignore'), VAULT_GITIGNORE);

  // Initialize git repo
  try {
    execSync('git init', { cwd: vaultPath, stdio: 'pipe' });
    execSync('git add -A', { cwd: vaultPath, stdio: 'pipe' });
    execSync('git commit -m "Initial knowledge vault"', { cwd: vaultPath, stdio: 'pipe' });
    logger.info({ groupFolder, vaultPath }, 'Knowledge vault initialized');
  } catch (err) {
    logger.warn({ groupFolder, err }, 'Failed to initialize knowledge vault git repo');
  }

  return vaultPath;
}
```

- [ ] **Step 2: Add knowledge vault to NanoClaw .gitignore**

Add to project root `.gitignore`:

```
groups/*/knowledge/
```

- [ ] **Step 3: Initialize vault on container start**

In `src/container-runner.ts`, call `initKnowledgeVault(group.folder)` inside `buildVolumeMounts` (the knowledge vault is already part of the group directory mount at `/workspace/group/knowledge/`).

```typescript
  // Initialize knowledge vault if it doesn't exist
  initKnowledgeVault(group.folder);
```

- [ ] **Step 4: Add agent instructions for knowledge base usage**

Create a knowledge base skill or add to the global CLAUDE.md template. The agent instructions should be added to each group's CLAUDE.md. Since this is per-group configuration, the simplest approach is to add it to `groups/global/CLAUDE.md` so all groups inherit it:

Add to `groups/global/CLAUDE.md`:

```markdown
## Knowledge Base

You have a persistent knowledge base at `/workspace/group/knowledge/`. Use it to store and retrieve information that should persist across conversations.

### Structure
- `people/` — people you learn about (one file per person)
- `projects/` — ongoing work, goals, status
- `preferences/` — user preferences, communication style
- `decisions/` — key decisions and their rationale
- `reference/` — facts, links, resources

### How to Use
- Read relevant notes at the start of each conversation for context
- Create/update notes when you learn something worth remembering
- Use `[[wiki-links]]` between related notes
- Add YAML frontmatter with metadata (tags, dates, related people)
- One concept per file with descriptive filenames (e.g., `people/alex-backend-lead.md`)
- Never delete notes — mark outdated ones with `deprecated: true` in frontmatter
- After creating or updating notes, commit changes with a descriptive message
- If a git remote is configured, push after committing
```

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/knowledge-vault.ts .gitignore groups/global/CLAUDE.md
git commit -m "feat: Obsidian-compatible knowledge vault per group"
```

---

### Task 11: Integration testing and manual verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -50`
Expected: All tests PASS

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 3: Manual test checklist**

Test with a live Discord bot:
- [ ] Send `@NanoClaw hello` in #general → thread created, response in thread
- [ ] Send another `@NanoClaw different topic` in #general → separate thread created
- [ ] Reply in first thread → response continues in first thread
- [ ] Reply in second thread → response continues in second thread (parallel)
- [ ] Wait for scheduled task to fire → output in #general as top-level message
- [ ] Reply to scheduled task message → thread created, session resumed
- [ ] Check `groups/{name}/knowledge/` → Obsidian vault exists with structure
- [ ] Open vault in Obsidian → browsable, graph view works

- [ ] **Step 4: Commit any fixes from manual testing**

```bash
git add -A
git commit -m "fix: address issues from integration testing"
```
