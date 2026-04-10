/**
 * Parallel Dispatch Concurrency Integration Tests
 *
 * Exercises the full dispatchReadyTasks pipeline with concurrent scenarios to
 * verify that the parallel dispatch system holds its key contracts end-to-end.
 *
 * All tests run standalone — no live infrastructure (no AHQ, no containers).
 * Each test documents the production failure scenario it guards against.
 *
 * Scenarios under test:
 *  1. 4 tasks dispatched simultaneously: slot count never exceeds PARALLEL_DISPATCH_WORKERS
 *  2. Branch collision between two tasks targeting the same repo: yield-and-requeue, not deadlock
 *  3. One worker SIGKILL mid-execution: slot released within one poll cycle
 *  4. Kill switch toggles to sequential: correct dispatch target and no slot claims
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist mocks before module resolution so dispatch-loop/pool pick up fakes.
vi.mock('./agency-hq-client.js', () => ({
  agencyFetch: vi.fn(),
  fetchPersona: vi.fn().mockResolvedValue(null),
}));

vi.mock('./worktree-manager.js', () => ({
  cleanupOrphanedWorktrees: vi.fn(),
  createWorktree: vi.fn().mockReturnValue(null),
  removeWorktree: vi.fn(),
}));

import { agencyFetch } from './agency-hq-client.js';
import { _initTestDatabase, createTask } from './db/index.js';
import {
  getActiveSlots,
  insertAcquiringSlot,
  recoverStaleSlotRecords,
  transitionToExecuting,
} from './db/dispatch-slots.js';
import {
  PARALLEL_DISPATCH_WORKERS,
  freeSlot,
  workerSlotJid,
} from './dispatch-pool.js';
import {
  dispatchReadyTasks,
  dispatchRetryCount,
  dispatchSkipTicks,
  enableParallelDispatch,
  lockedWorkerSlots,
  resetDispatchLoopState,
} from './dispatch-loop.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal SchedulerDependencies mock for dispatch loop tests. */
function makeMockDeps() {
  return {
    registeredGroups: () => ({
      'main@g.us': { isMain: true as const, folder: 'main', name: 'Main' },
    }),
    getSessions: () => ({}),
    queue: { enqueueTask: vi.fn() },
    onProcess: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

/** Lightweight Response stand-in for agencyFetch mocks. */
function mockResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

/** Minimal valid AgencyHqTask shape used across scenarios. */
function makeAhqTask(overrides: {
  id: string;
  title?: string;
  assigned_to?: string | null;
  repository?: string | null;
}) {
  return {
    id: overrides.id,
    title: overrides.title ?? `Task ${overrides.id}`,
    description: '',
    assigned_to: overrides.assigned_to ?? null,
    scheduled_dispatch_at: null,
    dispatch_blocked_until: null,
    dispatch_attempts: 0,
    sprint_id: null,
    repository: overrides.repository ?? null,
    status: 'ready',
  };
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Fresh in-memory DB for each test; runs all migrations (008/009 etc.).
  _initTestDatabase();

  // Reset in-memory dispatch loop state: parallelDispatchEnabled → false.
  resetDispatchLoopState();

  // Clear retry/backoff counters and in-memory slot lock set.
  dispatchRetryCount.clear();
  dispatchSkipTicks.clear();
  lockedWorkerSlots.clear();

  // Clear mock call history.
  vi.clearAllMocks();
});

// ===========================================================================
// Scenario 1: 4 tasks dispatched simultaneously — slot count never exceeds 4
//
// Failure scenario: if slot enforcement failed (e.g., the partial unique index
// was dropped or the branch-check query regressed), multiple concurrent
// dispatch ticks could insert two rows for the same slot_index, exceeding the
// PARALLEL_DISPATCH_WORKERS limit and overloading the host container runtime
// with too many simultaneous containers.
// ===========================================================================
describe('Scenario 1: 4 simultaneous dispatches — slot count never exceeds PARALLEL_DISPATCH_WORKERS', () => {
  it('claims exactly 4 slots when 4 tasks are dispatched and blocks any 5th', async () => {
    const mockFetch = vi.mocked(agencyFetch);

    // 5 tasks ready — one more than the pool allows
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeAhqTask({ id: `task-sim-${i}` }),
    );

    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/tasks?status=ready')
        return mockResponse({ success: true, data: tasks });
      return mockResponse({ success: true });
    });

    const deps = makeMockDeps();
    enableParallelDispatch();

    await dispatchReadyTasks(deps, () => false);

    // Exactly PARALLEL_DISPATCH_WORKERS (4) slots must be active — never 5.
    const active = getActiveSlots();
    expect(active).toHaveLength(PARALLEL_DISPATCH_WORKERS);

    // Only 4 tasks were enqueued — the 5th was blocked at the pre-check.
    expect(deps.queue.enqueueTask).toHaveBeenCalledTimes(
      PARALLEL_DISPATCH_WORKERS,
    );
  });

  it('frees a slot and allows a new dispatch on the next tick, keeping total at 4', async () => {
    const mockFetch = vi.mocked(agencyFetch);

    // First tick: fill all 4 slots.
    const firstBatch = Array.from({ length: 4 }, (_, i) =>
      makeAhqTask({ id: `task-batch1-${i}` }),
    );

    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/tasks?status=ready')
        return mockResponse({ success: true, data: firstBatch });
      return mockResponse({ success: true });
    });

    const deps = makeMockDeps();
    enableParallelDispatch();

    await dispatchReadyTasks(deps, () => false);
    expect(getActiveSlots()).toHaveLength(PARALLEL_DISPATCH_WORKERS);

    // Simulate task 0 completing normally (finally block runs).
    const [slot0] = getActiveSlots();
    freeSlot(slot0.id, slot0.ahq_task_id);
    lockedWorkerSlots.delete(workerSlotJid(slot0.slot_index));

    expect(getActiveSlots()).toHaveLength(PARALLEL_DISPATCH_WORKERS - 1);

    // Second tick: one new task arrives.
    const newTask = makeAhqTask({ id: 'task-refill' });
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/tasks?status=ready')
        return mockResponse({ success: true, data: [newTask] });
      return mockResponse({ success: true });
    });

    await dispatchReadyTasks(deps, () => false);

    // Pool must be back to exactly PARALLEL_DISPATCH_WORKERS — no overflow, no starvation.
    expect(getActiveSlots()).toHaveLength(PARALLEL_DISPATCH_WORKERS);
  });
});

// ===========================================================================
// Scenario 2: Branch collision — yield-and-requeue, not deadlock
//
// Failure scenario: two tasks with the same assigned_to (branch_id) both claim
// slots and attempt to work on the same git branch concurrently. This causes
// merge conflicts, overwritten commits, or data corruption. The branch
// isolation guard in insertAcquiringSlot must serialise same-branch tasks:
// the second task must be deferred and re-queued, not blocked forever.
// ===========================================================================
describe('Scenario 2: branch collision yields-and-requeues, not deadlocks', () => {
  it('dispatches only the first of two same-branch tasks; second is reverted to ready', async () => {
    const mockFetch = vi.mocked(agencyFetch);

    const capturedPuts: Array<{ path: string; status?: string }> = [];

    const taskA = makeAhqTask({
      id: 'task-branch-A',
      assigned_to: 'agent/alice',
    });
    const taskB = makeAhqTask({
      id: 'task-branch-B',
      assigned_to: 'agent/alice',
    });

    mockFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/tasks?status=ready')
        return mockResponse({ success: true, data: [taskA, taskB] });
      if (opts?.method === 'PUT') {
        const body = JSON.parse(opts.body as string) as { status?: string };
        capturedPuts.push({ path, status: body.status });
      }
      return mockResponse({ success: true });
    });

    const deps = makeMockDeps();
    enableParallelDispatch();

    await dispatchReadyTasks(deps, () => false);

    // Only one slot active — task A holds the branch lock.
    const active = getActiveSlots();
    expect(active).toHaveLength(1);
    expect(active[0].ahq_task_id).toBe('task-branch-A');
    expect(active[0].branch_id).toBe('agent/alice');

    // Task B must have been re-queued: a PUT /tasks/task-branch-B with status=ready
    // must have been sent to release the optimistic in-progress claim.
    const requeued = capturedPuts.find(
      (p) => p.path.includes('task-branch-B') && p.status === 'ready',
    );
    expect(
      requeued,
      'Task B must be PUT back to ready on branch collision (not left in-progress)',
    ).toBeDefined();

    // Branch collision must NOT count as a retry failure — retry counter
    // must be 0, not 1, so backoff is not applied to the re-queued task.
    expect(dispatchRetryCount.get('task-branch-B') ?? 0).toBe(0);
  });

  it('allows task B to claim a slot once task A finishes and the branch is free', async () => {
    const mockFetch = vi.mocked(agencyFetch);

    const taskA = makeAhqTask({
      id: 'task-seq-A',
      assigned_to: 'agent/alice',
    });
    const taskB = makeAhqTask({
      id: 'task-seq-B',
      assigned_to: 'agent/alice',
    });

    // First tick: A and B are both ready; A wins the branch lock.
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/tasks?status=ready')
        return mockResponse({ success: true, data: [taskA, taskB] });
      return mockResponse({ success: true });
    });

    const deps = makeMockDeps();
    enableParallelDispatch();

    await dispatchReadyTasks(deps, () => false);

    const active = getActiveSlots();
    expect(active).toHaveLength(1);
    expect(active[0].ahq_task_id).toBe('task-seq-A');

    // Task A completes — free its slot and in-memory lock.
    freeSlot(active[0].id, 'task-seq-A');
    lockedWorkerSlots.delete(workerSlotJid(active[0].slot_index));
    dispatchRetryCount.delete('task-seq-A');

    // Second tick: only B is ready; the branch is now free.
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/tasks?status=ready')
        return mockResponse({ success: true, data: [taskB] });
      return mockResponse({ success: true });
    });

    await dispatchReadyTasks(deps, () => false);

    // B must now hold a slot — no deadlock, no permanent deferral.
    const activeAfter = getActiveSlots();
    expect(activeAfter).toHaveLength(1);
    expect(activeAfter[0].ahq_task_id).toBe('task-seq-B');
  });
});

// ===========================================================================
// Scenario 3: SIGKILL mid-execution — slot released within one poll cycle
//
// Failure scenario: a container is SIGKILL'd mid-execution (OOM killer, host
// reboot, manual kill). The finally block in the enqueueTask callback never
// runs, so the slot stays 'executing' indefinitely — permanently reducing the
// pool to N-1 workers. Without dead-task detection in recoverStaleSlotRecords,
// a single SIGKILL can permanently shrink the dispatch pool until the next
// process restart.
// ===========================================================================
describe('Scenario 3: SIGKILL mid-execution — slot released within one poll cycle', () => {
  it('frees an executing slot whose local task was killed, in a single recoverStaleSlotRecords call', () => {
    // Simulate: task dispatched, container started (executing state), then SIGKILL.
    // The local_task_id was never written to scheduled_tasks (killed before createTask),
    // or was cleaned up. Either way, there is no active row for this local_task_id.
    const slotId = insertAcquiringSlot(
      0,
      'ahq-sigkill',
      'agent/runner',
      'local-sigkill',
      null,
    )!;
    expect(slotId).not.toBeNull();

    transitionToExecuting(slotId);

    expect(getActiveSlots()).toHaveLength(1);
    expect(getActiveSlots()[0].state).toBe('executing');

    // One poll cycle = one call to recoverStaleSlotRecords().
    // This is the same frequency the stall-detector runs in production.
    const recovered = recoverStaleSlotRecords();

    expect(recovered).toHaveLength(1);
    expect(recovered[0].slotId).toBe(slotId);
    expect(recovered[0].ahqTaskId).toBe('ahq-sigkill');
    expect(recovered[0].state).toBe('executing');
    expect(recovered[0].reason).toMatch(/no longer active/);

    // After exactly one poll cycle the slot must be free, restoring pool capacity.
    expect(getActiveSlots()).toHaveLength(0);
  });

  it('does not incorrectly free a slot whose local task is still running', () => {
    const now = new Date().toISOString();
    const localId = 'local-still-alive';

    // Healthy container: its scheduled_task row exists with status='active'.
    createTask({
      id: localId,
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: now,
      context_mode: 'isolated',
      next_run: now,
      status: 'active',
      created_at: now,
    });

    const slotId = insertAcquiringSlot(0, 'ahq-alive', null, localId, null)!;
    transitionToExecuting(slotId);

    // Recovery must leave this slot intact — false positives would kill live tasks.
    const recovered = recoverStaleSlotRecords();
    expect(recovered).toHaveLength(0);
    expect(getActiveSlots()).toHaveLength(1);
    expect(getActiveSlots()[0].state).toBe('executing');
  });

  it('restores full pool capacity after exactly one killed worker is recovered', () => {
    const now = new Date().toISOString();

    // Fill all 4 slots; 3 have live local tasks, 1 was SIGKILL'd (no task row).
    for (let i = 0; i < PARALLEL_DISPATCH_WORKERS; i++) {
      const localId = `local-capacity-${i}`;

      // Create live scheduled_task rows for all slots except slot 2 (SIGKILL'd).
      if (i !== 2) {
        createTask({
          id: localId,
          group_folder: 'main',
          chat_jid: 'main@g.us',
          prompt: 'test',
          schedule_type: 'once',
          schedule_value: now,
          context_mode: 'isolated',
          next_run: now,
          status: 'active',
          created_at: now,
        });
      }

      const slotId = insertAcquiringSlot(
        i,
        `ahq-capacity-${i}`,
        null,
        localId,
        null,
      )!;
      transitionToExecuting(slotId);
    }

    expect(getActiveSlots()).toHaveLength(PARALLEL_DISPATCH_WORKERS);

    // One poll cycle: only slot 2's dead task is detected.
    const recovered = recoverStaleSlotRecords();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].ahqTaskId).toBe('ahq-capacity-2');

    // Pool now has 3 active + 1 free — capacity restored for new work.
    expect(getActiveSlots()).toHaveLength(PARALLEL_DISPATCH_WORKERS - 1);

    // Confirm the freed slot accepts a new claim immediately.
    const refill = insertAcquiringSlot(
      2,
      'ahq-refill',
      null,
      'local-refill',
      null,
    );
    expect(refill).not.toBeNull();
    expect(getActiveSlots()).toHaveLength(PARALLEL_DISPATCH_WORKERS);
  });
});

// ===========================================================================
// Scenario 4: Kill switch toggles to sequential — correct dispatch behavior
//
// Failure scenario: the kill switch (parallelDispatchEnabled flag) is the
// safety valve that falls back to single-target sequential dispatch when the
// notification-metrics gate fails. If the flag were ignored, parallel mode
// would activate prematurely (before the pool is ready), sending tasks to
// worker slot JIDs that don't yet exist, or claiming slots when no recovery
// mechanism is in place.
// ===========================================================================
describe('Scenario 4: kill switch toggles to sequential — correct dispatch target', () => {
  it('uses the main target JID (not a worker slot) when kill switch is off', async () => {
    const mockFetch = vi.mocked(agencyFetch);
    const task = makeAhqTask({ id: 'task-sequential' });

    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/tasks?status=ready')
        return mockResponse({ success: true, data: [task] });
      return mockResponse({ success: true });
    });

    const deps = makeMockDeps();
    // resetDispatchLoopState() in beforeEach ensures parallelDispatchEnabled=false.

    await dispatchReadyTasks(deps, () => false);

    // Sequential mode must NOT claim any dispatch pool slots.
    expect(getActiveSlots()).toHaveLength(0);

    // Task must be enqueued on the main group JID — not a worker slot JID.
    expect(deps.queue.enqueueTask).toHaveBeenCalledTimes(1);
    const calledJid = deps.queue.enqueueTask.mock.calls[0][0] as string;
    expect(calledJid).toBe('main@g.us');
    expect(calledJid).not.toMatch(/internal:dev-inbox/);
  });

  it('uses a worker slot JID and claims a slot when kill switch is on', async () => {
    const mockFetch = vi.mocked(agencyFetch);
    const task = makeAhqTask({ id: 'task-parallel' });

    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/tasks?status=ready')
        return mockResponse({ success: true, data: [task] });
      return mockResponse({ success: true });
    });

    const deps = makeMockDeps();
    enableParallelDispatch(); // Toggle kill switch ON.

    await dispatchReadyTasks(deps, () => false);

    // Parallel mode must claim exactly one slot.
    expect(getActiveSlots()).toHaveLength(1);

    // Task must be enqueued on a worker slot JID of the form internal:dev-inbox:N.
    expect(deps.queue.enqueueTask).toHaveBeenCalledTimes(1);
    const calledJid = deps.queue.enqueueTask.mock.calls[0][0] as string;
    expect(calledJid).toMatch(/^internal:dev-inbox:\d+$/);
    expect(calledJid).not.toBe('main@g.us');
  });

  it('reverts to sequential dispatch after kill switch is toggled off mid-session', async () => {
    const mockFetch = vi.mocked(agencyFetch);
    const deps = makeMockDeps();

    // Phase 1 — parallel on: task A dispatched to a worker slot.
    enableParallelDispatch();

    const taskA = makeAhqTask({ id: 'task-toggle-A' });
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/tasks?status=ready')
        return mockResponse({ success: true, data: [taskA] });
      return mockResponse({ success: true });
    });

    await dispatchReadyTasks(deps, () => false);

    expect(getActiveSlots()).toHaveLength(1);
    const firstJid = deps.queue.enqueueTask.mock.calls[0][0] as string;
    expect(firstJid).toMatch(/^internal:dev-inbox:\d+$/);

    // Simulate kill switch toggled off (e.g., metrics gate revoked, maintenance mode).
    resetDispatchLoopState();
    lockedWorkerSlots.clear();

    // Phase 2 — parallel off: task B must go to the main target JID.
    const taskB = makeAhqTask({ id: 'task-toggle-B' });
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/tasks?status=ready')
        return mockResponse({ success: true, data: [taskB] });
      return mockResponse({ success: true });
    });

    await dispatchReadyTasks(deps, () => false);

    // Task B must use the main JID — sequential fallback is active.
    const allCalls = deps.queue.enqueueTask.mock.calls;
    const lastJid = allCalls[allCalls.length - 1][0] as string;
    expect(lastJid).toBe('main@g.us');
    expect(lastJid).not.toMatch(/internal:dev-inbox/);
  });
});
