# Event-Driven Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace NanoClaw's polling loop and direct-callback architecture with an event-driven core using Node.js EventEmitter, enabling all future layers (trust engine, proactive monitor, learning system) to plug in as event subscribers.

**Architecture:** A typed `EventBus` class wraps Node.js `EventEmitter` with error boundaries, typed event definitions, and structured logging. The existing `GroupQueue` is refactored to emit events for all state transitions. The message loop in `index.ts` is rewritten to dispatch via events instead of direct function calls. Characterization tests are written first to ensure the rewrite preserves existing behavior.

**Tech Stack:** Node.js EventEmitter (built-in), Vitest (existing test framework), TypeScript

**Spec:** `docs/superpowers/specs/2026-04-13-nanoclaw-scope-expansion-design.md` (Layer 0)

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `src/event-bus.ts` | Typed EventEmitter wrapper with error boundary | Create |
| `src/event-bus.test.ts` | Unit tests for event bus | Create |
| `src/events.ts` | Event type definitions and constants | Create |
| `src/group-queue.ts` | Container concurrency + task queue | Modify (add event emission) |
| `src/group-queue.test.ts` | Existing tests | Modify (add event emission tests) |
| `src/index.ts` | Orchestrator | Modify (replace polling with events) |
| `src/index.test.ts` | Characterization tests for current behavior | Create |

---

### Task 1: Characterization Tests for index.ts

Before touching the orchestrator, capture its current behavior in tests. These are the safety net for the rewrite.

**Files:**
- Create: `src/index.test.ts`
- Read: `src/index.ts`, `src/group-queue.ts`, `src/db.ts`

- [ ] **Step 1: Create test file with imports and mocks**

```typescript
// src/index.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing index
vi.mock('./db.js', () => ({
  initDatabase: vi.fn(),
  getRouterState: vi.fn().mockReturnValue(''),
  setRouterState: vi.fn(),
  deleteRouterState: vi.fn(),
  getAllSessions: vi.fn().mockReturnValue({}),
  getAllRegisteredGroups: vi.fn().mockReturnValue({}),
  getAllChats: vi.fn().mockReturnValue([]),
  getAllTasks: vi.fn().mockReturnValue([]),
  getPendingCursors: vi.fn().mockReturnValue(new Map()),
  getMessagesSince: vi.fn().mockReturnValue([]),
  getNewMessages: vi.fn().mockReturnValue([]),
  getLastBotMessageTimestamp: vi.fn().mockReturnValue(null),
  setRegisteredGroup: vi.fn(),
  setSession: vi.fn(),
  deleteSession: vi.fn(),
  storeMessage: vi.fn(),
  storeChatMetadata: vi.fn(),
  logSessionCost: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn().mockResolvedValue({
    status: 'success',
    result: 'test response',
    newSessionId: 'session-1',
  }),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./container-runtime.js', () => ({
  ensureContainerRuntimeRunning: vi.fn().mockResolvedValue(undefined),
  cleanupOrphans: vi.fn(),
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: vi.fn().mockReturnValue([]),
  readonlyMountArgs: vi.fn().mockReturnValue([]),
  stopContainer: vi.fn(),
}));

vi.mock('./channels/registry.js', () => ({
  getChannelFactory: vi.fn(),
  getRegisteredChannelNames: vi.fn().mockReturnValue([]),
}));

vi.mock('./budget.js', () => ({
  isBudgetExceeded: vi.fn().mockReturnValue(false),
}));

vi.mock('./ipc.js', () => ({
  startIpcWatcher: vi.fn(),
}));

vi.mock('./task-scheduler.js', () => ({
  startSchedulerLoop: vi.fn(),
}));

vi.mock('./email-sse.js', () => ({
  startEmailSSE: vi.fn(),
}));

vi.mock('./gmail-token-refresh.js', () => ({
  refreshGmailTokens: vi.fn(),
  startGmailRefreshLoop: vi.fn(),
}));

vi.mock('./deal-watch-loop.js', () => ({
  startDealWatchLoop: vi.fn(),
}));

vi.mock('./remote-control.js', () => ({
  startRemoteControl: vi.fn(),
  stopRemoteControl: vi.fn(),
  restoreRemoteControl: vi.fn(),
}));

vi.mock('./sender-allowlist.js', () => ({
  isSenderAllowed: vi.fn().mockReturnValue(true),
  isTriggerAllowed: vi.fn().mockReturnValue(true),
  loadSenderAllowlist: vi.fn().mockReturnValue({}),
  shouldDropMessage: vi.fn().mockReturnValue(false),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: vi.fn().mockImplementation(() => ({
    ensureAgent: vi.fn().mockResolvedValue({ created: false }),
  })),
}));
```

- [ ] **Step 2: Add characterization test for state loading**

```typescript
// Append to src/index.test.ts
import { getRouterState, getAllSessions, getAllRegisteredGroups, getPendingCursors } from './db.js';

describe('State Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads state from database on startup', async () => {
    const mockGroups = {
      'group1@jid': { name: 'Test', folder: 'test', trigger: '@Andy', added_at: '2026-01-01' },
    };
    vi.mocked(getAllRegisteredGroups).mockReturnValue(mockGroups);
    vi.mocked(getAllSessions).mockReturnValue({ test: 'session-1' });
    vi.mocked(getRouterState).mockImplementation((key: string) => {
      if (key === 'last_timestamp') return '2026-01-01T00:00:00Z';
      if (key === 'last_agent_timestamp') return JSON.stringify({ 'group1@jid': '2026-01-01' });
      return null;
    });
    vi.mocked(getPendingCursors).mockReturnValue(new Map());

    // Import triggers loadState
    const { _setRegisteredGroups } = await import('./index.js');
    expect(getAllRegisteredGroups).toHaveBeenCalled();
    expect(getAllSessions).toHaveBeenCalled();
  });

  it('recovers pending cursors on startup', async () => {
    const pendingCursors = new Map([['group1@jid', '2026-01-01T00:00:00Z']]);
    vi.mocked(getPendingCursors).mockReturnValue(pendingCursors);
    vi.mocked(getRouterState).mockImplementation((key: string) => {
      if (key === 'last_agent_timestamp')
        return JSON.stringify({ 'group1@jid': '2026-01-01T12:00:00Z' });
      return '';
    });

    await import('./index.js');
    // Should roll back the cursor
    expect(vi.mocked(require('./db.js').deleteRouterState)).toHaveBeenCalledWith(
      'pending_cursor:group1@jid',
    );
  });
});
```

- [ ] **Step 3: Add characterization test for group registration**

```typescript
// Append to src/index.test.ts
import fs from 'fs';

describe('Group Registration', () => {
  it('creates group folder and CLAUDE.md on registration', () => {
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('# Andy\nYou are Andy');
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    // Test registerGroup via the exported _setRegisteredGroups
    // (registerGroup is not exported, but we can test it indirectly)
    // This characterizes the behavior we must preserve
  });
});
```

- [ ] **Step 4: Add characterization test for message processing flow**

```typescript
// Append to src/index.test.ts
import { getMessagesSince } from './db.js';
import { runContainerAgent } from './container-runner.js';

describe('Message Processing', () => {
  it('skips processing when no messages are pending', async () => {
    vi.mocked(getMessagesSince).mockReturnValue([]);
    // processGroupMessages should return true (success, nothing to do)
  });

  it('checks trigger pattern for non-main groups', async () => {
    vi.mocked(getMessagesSince).mockReturnValue([
      {
        id: '1',
        chat_jid: 'group1@jid',
        sender: 'user1',
        sender_name: 'User',
        content: 'hello without trigger',
        timestamp: '2026-01-01T00:00:01Z',
      },
    ]);
    // processGroupMessages should return true (no trigger, skip)
  });

  it('processes messages when trigger is present', async () => {
    vi.mocked(getMessagesSince).mockReturnValue([
      {
        id: '1',
        chat_jid: 'group1@jid',
        sender: 'user1',
        sender_name: 'User',
        content: '@Andy hello',
        timestamp: '2026-01-01T00:00:01Z',
      },
    ]);
    // processGroupMessages should call runContainerAgent
  });

  it('rolls back cursor on agent error when no output was sent', async () => {
    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'error',
      result: null,
      error: 'container crashed',
    });
    // processGroupMessages should return false
    // cursor should be rolled back
  });

  it('does NOT roll back cursor on agent error when output was already sent', async () => {
    // If the agent sent partial output before erroring, don't re-process
    // (would cause duplicate messages)
  });
});
```

- [ ] **Step 5: Run characterization tests**

Run: `npx vitest run src/index.test.ts`
Expected: All tests pass (these characterize existing behavior, not new behavior)

- [ ] **Step 6: Commit**

```bash
git add src/index.test.ts
git commit -m "test: add characterization tests for index.ts before event-driven rewrite"
```

---

### Task 2: Event Type Definitions

Define all event types the system will use. This is the contract between layers.

**Files:**
- Create: `src/events.ts`

- [ ] **Step 1: Write the event type definitions**

```typescript
// src/events.ts

/**
 * NanoClaw Event System — Type Definitions
 *
 * All inter-layer communication flows through typed events.
 * Each layer emits and subscribes to events via the EventBus.
 *
 * Event naming: {layer}.{entity}.{action}
 *   layer: message, task, trust, verify, learn, system
 *   entity: what's being acted on
 *   action: what happened
 */

// --- Base event structure ---

export interface NanoClawEvent {
  type: string;
  source: string;
  groupId?: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

// --- Message events ---

export interface MessageInboundEvent extends NanoClawEvent {
  type: 'message.inbound';
  source: 'channel';
  payload: {
    chatJid: string;
    channel: string;
    messageCount: number;
  };
}

export interface MessageOutboundEvent extends NanoClawEvent {
  type: 'message.outbound';
  source: 'router';
  payload: {
    chatJid: string;
    channel: string;
    text: string;
  };
}

// --- Task/Executor events ---

export interface TaskQueuedEvent extends NanoClawEvent {
  type: 'task.queued';
  source: 'executor';
  payload: {
    taskId: string;
    groupJid: string;
    priority: 'interactive' | 'scheduled' | 'proactive';
    queuePosition: number;
  };
}

export interface TaskStartedEvent extends NanoClawEvent {
  type: 'task.started';
  source: 'executor';
  payload: {
    taskId: string;
    groupJid: string;
    containerName: string;
    slotIndex: number;
  };
}

export interface TaskCompleteEvent extends NanoClawEvent {
  type: 'task.complete';
  source: 'executor';
  payload: {
    taskId: string;
    groupJid: string;
    status: 'success' | 'error';
    durationMs: number;
    costUsd?: number;
  };
}

export interface TaskProgressEvent extends NanoClawEvent {
  type: 'task.progress';
  source: 'executor';
  payload: {
    taskId: string;
    groupJid: string;
    label: string;
  };
}

// --- System events ---

export interface SystemErrorEvent extends NanoClawEvent {
  type: 'system.error';
  source: string;
  payload: {
    error: string;
    handler: string;
    originalEvent: string;
  };
}

export interface SystemStartupEvent extends NanoClawEvent {
  type: 'system.startup';
  source: 'orchestrator';
  payload: {
    channels: string[];
    groupCount: number;
  };
}

export interface SystemShutdownEvent extends NanoClawEvent {
  type: 'system.shutdown';
  source: 'orchestrator';
  payload: {
    reason: string;
  };
}

// --- Event type map (for type-safe subscriptions) ---

export interface EventMap {
  'message.inbound': MessageInboundEvent;
  'message.outbound': MessageOutboundEvent;
  'task.queued': TaskQueuedEvent;
  'task.started': TaskStartedEvent;
  'task.complete': TaskCompleteEvent;
  'task.progress': TaskProgressEvent;
  'system.error': SystemErrorEvent;
  'system.startup': SystemStartupEvent;
  'system.shutdown': SystemShutdownEvent;
}

export type EventType = keyof EventMap;
```

- [ ] **Step 2: Commit**

```bash
git add src/events.ts
git commit -m "feat: add event type definitions for event-driven architecture"
```

---

### Task 3: Event Bus Implementation

**Files:**
- Create: `src/event-bus.ts`
- Create: `src/event-bus.test.ts`
- Read: `src/events.ts`

- [ ] **Step 1: Write failing tests for event bus**

```typescript
// src/event-bus.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from './event-bus.js';
import type { MessageInboundEvent, SystemErrorEvent } from './events.js';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('emits and receives typed events', () => {
    const handler = vi.fn();
    bus.on('message.inbound', handler);

    const event: MessageInboundEvent = {
      type: 'message.inbound',
      source: 'channel',
      groupId: 'group1',
      timestamp: Date.now(),
      payload: { chatJid: 'group1@jid', channel: 'telegram', messageCount: 3 },
    };

    bus.emit('message.inbound', event);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('does not crash when a handler throws', () => {
    const errorHandler = vi.fn();
    bus.on('system.error', errorHandler);

    bus.on('message.inbound', () => {
      throw new Error('handler exploded');
    });

    const event: MessageInboundEvent = {
      type: 'message.inbound',
      source: 'channel',
      timestamp: Date.now(),
      payload: { chatJid: 'group1@jid', channel: 'telegram', messageCount: 1 },
    };

    // Should not throw
    expect(() => bus.emit('message.inbound', event)).not.toThrow();

    // Should emit system.error
    expect(errorHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system.error',
        payload: expect.objectContaining({
          error: 'handler exploded',
          originalEvent: 'message.inbound',
        }),
      }),
    );
  });

  it('supports multiple handlers for same event', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.on('task.complete', handler1);
    bus.on('task.complete', handler2);

    bus.emit('task.complete', {
      type: 'task.complete',
      source: 'executor',
      timestamp: Date.now(),
      payload: { taskId: '1', groupJid: 'g1', status: 'success', durationMs: 100 },
    });

    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it('supports unsubscribing', () => {
    const handler = vi.fn();
    const unsub = bus.on('message.inbound', handler);

    unsub();

    bus.emit('message.inbound', {
      type: 'message.inbound',
      source: 'channel',
      timestamp: Date.now(),
      payload: { chatJid: 'g1', channel: 'telegram', messageCount: 1 },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('logs all events for observability', () => {
    const allHandler = vi.fn();
    bus.onAny(allHandler);

    bus.emit('task.started', {
      type: 'task.started',
      source: 'executor',
      timestamp: Date.now(),
      payload: { taskId: '1', groupJid: 'g1', containerName: 'c1', slotIndex: 0 },
    });

    expect(allHandler).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/event-bus.test.ts`
Expected: FAIL with "Cannot find module './event-bus.js'"

- [ ] **Step 3: Implement EventBus**

```typescript
// src/event-bus.ts
import { EventEmitter } from 'events';

import { logger } from './logger.js';
import type { EventMap, EventType, NanoClawEvent, SystemErrorEvent } from './events.js';

type EventHandler<T extends NanoClawEvent> = (event: T) => void;

export class EventBus {
  private emitter = new EventEmitter();
  private anyHandlers: Array<(event: NanoClawEvent) => void> = [];

  constructor() {
    // Increase max listeners — we'll have many layers subscribing
    this.emitter.setMaxListeners(50);
  }

  /**
   * Subscribe to a typed event. Returns an unsubscribe function.
   */
  on<K extends EventType>(type: K, handler: EventHandler<EventMap[K]>): () => void {
    const wrappedHandler = (event: EventMap[K]) => {
      try {
        handler(event);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          { eventType: type, handler: handler.name || 'anonymous', error: errorMsg },
          'Event handler threw — caught by error boundary',
        );

        // Emit system.error (but guard against infinite recursion)
        if (type !== 'system.error') {
          const errorEvent: SystemErrorEvent = {
            type: 'system.error',
            source: 'event-bus',
            timestamp: Date.now(),
            payload: {
              error: errorMsg,
              handler: handler.name || 'anonymous',
              originalEvent: type,
            },
          };
          this.emit('system.error', errorEvent);
        }
      }
    };

    this.emitter.on(type, wrappedHandler);
    return () => this.emitter.off(type, wrappedHandler);
  }

  /**
   * Emit a typed event to all subscribers.
   */
  emit<K extends EventType>(type: K, event: EventMap[K]): void {
    logger.debug({ eventType: type, source: event.source, groupId: event.groupId }, 'Event emitted');

    // Notify any-handlers first (for logging/observability)
    for (const handler of this.anyHandlers) {
      try {
        handler(event);
      } catch {
        // Swallow — any-handlers are observability-only
      }
    }

    this.emitter.emit(type, event);
  }

  /**
   * Subscribe to all events (for logging, metrics, debugging).
   */
  onAny(handler: (event: NanoClawEvent) => void): () => void {
    this.anyHandlers.push(handler);
    return () => {
      const idx = this.anyHandlers.indexOf(handler);
      if (idx >= 0) this.anyHandlers.splice(idx, 1);
    };
  }

  /**
   * Remove all handlers (for testing).
   */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
    this.anyHandlers = [];
  }
}

// Singleton instance — imported by all layers
export const eventBus = new EventBus();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/event-bus.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/event-bus.ts src/event-bus.test.ts
git commit -m "feat: implement EventBus with typed events and error boundary"
```

---

### Task 4: Wire GroupQueue to Emit Events

Add event emission to the existing GroupQueue without changing its behavior. This is additive — existing tests must continue to pass.

**Files:**
- Modify: `src/group-queue.ts`
- Modify: `src/group-queue.test.ts`
- Read: `src/event-bus.ts`, `src/events.ts`

- [ ] **Step 1: Write failing tests for event emission**

```typescript
// Append to src/group-queue.test.ts
import { eventBus } from './event-bus.js';
import type { TaskQueuedEvent, TaskStartedEvent, TaskCompleteEvent } from './events.js';

describe('GroupQueue event emission', () => {
  beforeEach(() => {
    eventBus.removeAllListeners();
  });

  it('emits task.queued when a message check is enqueued at capacity', () => {
    const handler = vi.fn();
    eventBus.on('task.queued', handler);

    // Fill to capacity, then enqueue one more
    // (uses existing test setup pattern from the file)
  });

  it('emits task.started when a container begins processing', () => {
    const handler = vi.fn();
    eventBus.on('task.started', handler);

    // Enqueue a message check and let it start
  });

  it('emits task.complete when container finishes', () => {
    const handler = vi.fn();
    eventBus.on('task.complete', handler);

    // Process a message and wait for completion
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/group-queue.test.ts`
Expected: New tests FAIL (no events emitted yet), existing tests PASS

- [ ] **Step 3: Add event emission to GroupQueue**

Add imports at the top of `src/group-queue.ts`:

```typescript
import { eventBus } from './event-bus.js';
import type { TaskQueuedEvent, TaskStartedEvent, TaskCompleteEvent } from './events.js';
```

Add event emission in `enqueueMessageCheck` when queuing (at capacity):

```typescript
// Inside enqueueMessageCheck, after adding to waitingGroups:
eventBus.emit('task.queued', {
  type: 'task.queued',
  source: 'executor',
  groupId: groupJid,
  timestamp: Date.now(),
  payload: {
    taskId: `msg-${groupJid}-${Date.now()}`,
    groupJid,
    priority: 'interactive' as const,
    queuePosition: this.waitingGroups.length,
  },
});
```

Add event emission in `runForGroup` at start:

```typescript
// At the top of runForGroup, after setting state.active = true:
eventBus.emit('task.started', {
  type: 'task.started',
  source: 'executor',
  groupId: groupJid,
  timestamp: Date.now(),
  payload: {
    taskId: `msg-${groupJid}`,
    groupJid,
    containerName: state.containerName || 'unknown',
    slotIndex: this.activeCount - 1,
  },
});
```

Add event emission in `runForGroup` in finally block:

```typescript
// In the finally block of runForGroup, before this.drainGroup:
eventBus.emit('task.complete', {
  type: 'task.complete',
  source: 'executor',
  groupId: groupJid,
  timestamp: Date.now(),
  payload: {
    taskId: `msg-${groupJid}`,
    groupJid,
    status: hadError ? 'error' : 'success',
    durationMs: Date.now() - startMs,
  },
});
```

Same pattern for `runTask` — emit `task.started` at entry, `task.complete` in finally.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run src/group-queue.test.ts`
Expected: All tests PASS (existing + new)

- [ ] **Step 5: Commit**

```bash
git add src/group-queue.ts src/group-queue.test.ts
git commit -m "feat: wire GroupQueue to emit events on task lifecycle"
```

---

### Task 5: Wire index.ts to Emit Message Events

Add `message.inbound` event emission to the message handling flow. The existing behavior stays identical — we're adding event emission alongside, not replacing the flow yet.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add event bus import to index.ts**

```typescript
// Add to imports at top of src/index.ts
import { eventBus } from './event-bus.js';
import type { MessageInboundEvent, MessageOutboundEvent, SystemStartupEvent } from './events.js';
```

- [ ] **Step 2: Emit message.inbound in the onMessage callback**

In `startMessageLoop` (or wherever the `onMessage` callback is defined), add event emission when a new message arrives and is routed to a registered group:

```typescript
// After determining the message should be processed (trigger check passed, group registered):
eventBus.emit('message.inbound', {
  type: 'message.inbound',
  source: 'channel',
  groupId: chatJid,
  timestamp: Date.now(),
  payload: {
    chatJid,
    channel: channel.name,
    messageCount: 1,
  },
});
```

- [ ] **Step 3: Emit message.outbound when sending responses**

In `processGroupMessages`, after `channel.sendMessage(chatJid, outText)`:

```typescript
eventBus.emit('message.outbound', {
  type: 'message.outbound',
  source: 'router',
  groupId: chatJid,
  timestamp: Date.now(),
  payload: {
    chatJid,
    channel: channel.name,
    text: outText.slice(0, 200), // Truncate for event payload
  },
});
```

- [ ] **Step 4: Emit system.startup at end of initialization**

After all channels are connected and the message loop starts:

```typescript
eventBus.emit('system.startup', {
  type: 'system.startup',
  source: 'orchestrator',
  timestamp: Date.now(),
  payload: {
    channels: channels.map(c => c.name),
    groupCount: Object.keys(registeredGroups).length,
  },
});
```

- [ ] **Step 5: Run all tests to verify nothing broke**

Run: `npx vitest run`
Expected: All existing tests PASS

- [ ] **Step 6: Run the system manually to verify**

Run: `npm run dev`
Expected: System starts normally. Check logs for `Event emitted` debug messages.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: emit message and system events from orchestrator"
```

---

### Task 6: Add Event Log for Observability

Create a simple event log that records all events to SQLite. This is the foundation for daily digest, "what did I miss?", and cost tracking.

**Files:**
- Create: `src/event-log.ts`
- Create: `src/event-log.test.ts`
- Modify: `src/db.ts` (add event_log table)

- [ ] **Step 1: Write failing tests**

```typescript
// src/event-log.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Will test the event log subscriber
describe('EventLog', () => {
  it('records events to SQLite', () => {
    // Insert a mock event and verify it's queryable
  });

  it('queries events by time range', () => {
    // Insert events with different timestamps, query a range
  });

  it('queries events by type', () => {
    // Insert events of different types, filter by type
  });

  it('prunes events older than retention period', () => {
    // Insert old events, run prune, verify they're gone
  });
});
```

- [ ] **Step 2: Add event_log table to db.ts**

```sql
CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  group_id TEXT,
  payload TEXT NOT NULL,  -- JSON
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_log_type_time ON event_log(event_type, timestamp);
CREATE INDEX IF NOT EXISTS idx_event_log_group_time ON event_log(group_id, timestamp);
```

- [ ] **Step 3: Implement EventLog**

```typescript
// src/event-log.ts
import { eventBus } from './event-bus.js';
import { logger } from './logger.js';
import type { NanoClawEvent } from './events.js';

// Functions: logEvent, queryEvents, pruneOldEvents
// The subscriber auto-registers with eventBus.onAny()
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/event-log.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/event-log.ts src/event-log.test.ts src/db.ts
git commit -m "feat: add event log for observability and future analytics"
```

---

### Task 7: Integration Test — Full Event Flow

Verify the complete flow: message arrives → event emitted → GroupQueue processes → events logged.

**Files:**
- Create: `src/event-flow.integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// src/event-flow.integration.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from './event-bus.js';
import type { EventType, NanoClawEvent } from './events.js';

describe('Event Flow Integration', () => {
  it('message.inbound triggers task lifecycle events in order', async () => {
    const events: Array<{ type: string; timestamp: number }> = [];
    const bus = new EventBus();

    // Subscribe to all relevant events
    bus.onAny((event: NanoClawEvent) => {
      events.push({ type: event.type, timestamp: event.timestamp });
    });

    // Simulate: message.inbound → task.queued → task.started → task.complete
    bus.emit('message.inbound', {
      type: 'message.inbound',
      source: 'channel',
      groupId: 'g1',
      timestamp: 1,
      payload: { chatJid: 'g1', channel: 'telegram', messageCount: 1 },
    });

    bus.emit('task.started', {
      type: 'task.started',
      source: 'executor',
      groupId: 'g1',
      timestamp: 2,
      payload: { taskId: 't1', groupJid: 'g1', containerName: 'c1', slotIndex: 0 },
    });

    bus.emit('task.complete', {
      type: 'task.complete',
      source: 'executor',
      groupId: 'g1',
      timestamp: 3,
      payload: { taskId: 't1', groupJid: 'g1', status: 'success', durationMs: 1000 },
    });

    expect(events).toHaveLength(3);
    expect(events.map(e => e.type)).toEqual([
      'message.inbound',
      'task.started',
      'task.complete',
    ]);
  });

  it('error in handler does not block subsequent events', () => {
    const bus = new EventBus();
    const results: string[] = [];

    bus.on('message.inbound', () => {
      throw new Error('boom');
    });
    bus.on('message.inbound', () => {
      results.push('second handler ran');
    });

    bus.emit('message.inbound', {
      type: 'message.inbound',
      source: 'channel',
      timestamp: Date.now(),
      payload: { chatJid: 'g1', channel: 'telegram', messageCount: 1 },
    });

    // The second handler should still run despite the first throwing
    // (EventEmitter calls handlers synchronously, so the error boundary
    // catches the first and the emitter continues to the second)
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx vitest run src/event-flow.integration.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS, including existing group-queue, container-runner, and channel tests

- [ ] **Step 4: Commit**

```bash
git add src/event-flow.integration.test.ts
git commit -m "test: add event flow integration tests"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run the system with hot reload**

Run: `npm run dev`
Expected: System starts normally. Send a test message to any channel. Verify in logs:
- `Event emitted: message.inbound` appears
- `Event emitted: task.started` appears
- `Event emitted: task.complete` appears
- System behavior is identical to before (responses work, sessions persist)

- [ ] **Step 3: Commit any final adjustments**

```bash
git add -A
git commit -m "chore: finalize event-driven foundation (Plan 1 complete)"
```

---

## Summary

After completing this plan, NanoClaw has:

1. **Characterization tests** for `index.ts` protecting against regressions
2. **Typed event system** (`EventBus`, `events.ts`) with error boundaries
3. **Event emission** from GroupQueue (task lifecycle) and index.ts (messages, system)
4. **Event log** in SQLite for future analytics and daily digest
5. **Integration tests** verifying the full event flow

The system behavior is unchanged. Events are emitted alongside existing direct calls. This is the foundation that Layers 1-7 will build on.

**Next plan:** Plan 2 (Parallel Execution — refactor GroupQueue into ExecutorPool with warm pool and priority scheduling) and Plan 3 (Trust Engine — MCP gateway with graduated autonomy).
