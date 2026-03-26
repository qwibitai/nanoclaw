/**
 * Dispatch Invariants Test Harness
 *
 * Verifies five invariants of the dispatch pool / slot state machine.
 * All tests run standalone — no live infrastructure (no AHQ, no containers).
 *
 * Invariants under test:
 *  1. Slot count never exceeds PARALLEL_DISPATCH_WORKERS (4)
 *  2. SIGKILL worker releases slot within one poll cycle
 *  3. Branch collision triggers yield-and-requeue, not deadlock
 *  4. 3 failed dispatch attempts transitions task to blocked with dispatch_blocked_until
 *  5. Startup reconciliation correctly frees orphaned acquiring-state rows
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist mocks before module resolution so imports in dispatch-pool.ts and
// dispatch-loop.ts pick up the fakes rather than the real implementations.
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
  ACQUIRING_STALE_MS,
  getActiveSlots,
  insertAcquiringSlot,
  recoverStaleSlotRecords,
  transitionToExecuting,
} from './db/dispatch-slots.js';
import {
  PARALLEL_DISPATCH_WORKERS,
  claimSlot,
  freeSlot,
  recoverStaleSlots,
} from './dispatch-pool.js';
import {
  dispatchReadyTasks,
  dispatchRetryCount,
  dispatchSkipTicks,
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

/** Minimal valid AgencyHqTask shape used in loop tests. */
function makeAhqTask(overrides: { id: string; title?: string }) {
  return {
    id: overrides.id,
    title: overrides.title ?? `Task ${overrides.id}`,
    description: '',
    assigned_to: null,
    scheduled_dispatch_at: null,
    dispatch_blocked_until: null,
    dispatch_attempts: 0,
    sprint_id: null,
    repository: null,
    status: 'ready',
  };
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Fresh in-memory DB for each test; runs all migrations including 008/009.
  _initTestDatabase();

  // Reset in-memory dispatch loop state (parallelDispatchEnabled → false, etc.).
  resetDispatchLoopState();

  // Clear retry/backoff counters.
  dispatchRetryCount.clear();
  dispatchSkipTicks.clear();

  // Clear mock call history.
  vi.clearAllMocks();
});

// ===========================================================================
// Invariant 1: Slot count never exceeds PARALLEL_DISPATCH_WORKERS (4)
//
// Failure scenario: without the partial unique index on slot_index, a race
// between two concurrent dispatch ticks could insert two rows for the same
// slot, allowing more than 4 tasks to run simultaneously and overloading the
// host container runtime.
// ===========================================================================
describe('Invariant 1: slot count never exceeds PARALLEL_DISPATCH_WORKERS', () => {
  it('allows exactly PARALLEL_DISPATCH_WORKERS slots then rejects any additional claim', () => {
    // Fill all 4 slots
    for (let i = 0; i < PARALLEL_DISPATCH_WORKERS; i++) {
      const id = insertAcquiringSlot(i, `task-${i}`, null, `local-${i}`, null);
      expect(id, `slot ${i} should be claimable`).not.toBeNull();
    }

    expect(getActiveSlots()).toHaveLength(PARALLEL_DISPATCH_WORKERS);

    // Every additional low-level insert must fail (unique index violation)
    for (let i = 0; i < PARALLEL_DISPATCH_WORKERS; i++) {
      expect(
        insertAcquiringSlot(i, 'task-extra', null, 'local-extra', null),
        `slot ${i} must reject a second claim`,
      ).toBeNull();
    }

    // Higher-level claimSlot also returns null when all slots are occupied
    expect(claimSlot('task-overflow', null, 'local-overflow', null)).toBeNull();

    // Active count must remain exactly 4 — no overflow
    expect(getActiveSlots()).toHaveLength(PARALLEL_DISPATCH_WORKERS);
  });

  it('a freed slot immediately becomes claimable, keeping total at exactly 4', () => {
    const ids: number[] = [];
    for (let i = 0; i < PARALLEL_DISPATCH_WORKERS; i++) {
      ids.push(
        insertAcquiringSlot(i, `task-fill-${i}`, null, `local-fill-${i}`, null)!,
      );
    }

    // Release slot 2 (simulating normal task completion)
    freeSlot(ids[2], 'task-fill-2');

    // Exactly one new claim should succeed and restore the count to 4
    const newClaim = claimSlot('task-replacement', null, 'local-replacement', null);
    expect(newClaim).not.toBeNull();
    expect(getActiveSlots()).toHaveLength(PARALLEL_DISPATCH_WORKERS);
  });
});

// ===========================================================================
// Invariant 2: SIGKILL worker releases slot within one poll cycle
//
// Failure scenario: a container is SIGKILL'd mid-execution; no finally block
// runs, so the slot row remains 'executing' in SQLite indefinitely. Without
// dead-task detection in recoverStaleSlotRecords(), that slot is lost forever,
// reducing the effective pool to N-1 until the next process restart.
// ===========================================================================
describe('Invariant 2: SIGKILL worker releases slot within one poll cycle', () => {
  it('frees an executing slot whose local scheduled_task no longer exists', () => {
    // Claim and advance to executing — simulates a container that started
    const slotId = insertAcquiringSlot(
      0,
      'ahq-killed',
      null,
      'local-killed',
      null,
    )!;
    transitionToExecuting(slotId);

    expect(getActiveSlots()).toHaveLength(1);
    expect(getActiveSlots()[0].state).toBe('executing');

    // 'local-killed' has no row in scheduled_tasks → the task is dead
    // (simulates SIGKILL: the process exited before writing the task row,
    // or the OS killed the process after the row was cleaned up).
    // One call to recoverStaleSlotRecords() is the poll cycle.
    const stale = recoverStaleSlotRecords();

    expect(stale).toHaveLength(1);
    expect(stale[0].slotId).toBe(slotId);
    expect(stale[0].ahqTaskId).toBe('ahq-killed');
    expect(stale[0].state).toBe('executing');
    expect(stale[0].reason).toMatch(/local task.*no longer active/);

    // Slot must be free after a single poll
    expect(getActiveSlots()).toHaveLength(0);
  });

  it('does not free an executing slot whose local task is still active', () => {
    const now = new Date().toISOString();
    const localId = 'local-still-running';

    // Insert a live scheduled_task row (status='active')
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

    const slotId = insertAcquiringSlot(0, 'ahq-live', null, localId, null)!;
    transitionToExecuting(slotId);

    // Recovery must not touch this slot
    expect(recoverStaleSlotRecords()).toHaveLength(0);
    expect(getActiveSlots()).toHaveLength(1);
  });
});

// ===========================================================================
// Invariant 3: Branch collision triggers yield-and-requeue, not deadlock
//
// Failure scenario: two tasks with the same branch_id (same assigned agent)
// both succeed in claiming a slot. They then try to work on the same git
// branch concurrently, causing merge conflicts or overwritten commits. The
// guard is a branch-isolation check in insertAcquiringSlot that serialises
// same-branch tasks.
// ===========================================================================
describe('Invariant 3: branch collision triggers yield, not deadlock', () => {
  it('prevents a second task with the same branch_id from claiming any slot', () => {
    // Task A claims a slot on branch 'agent/alice'
    const slotA = insertAcquiringSlot(0, 'ahq-A', 'agent/alice', 'local-A', null);
    expect(slotA).not.toBeNull();

    // Task B with the same branch must be deferred for every slot index
    for (let i = 0; i < PARALLEL_DISPATCH_WORKERS; i++) {
      expect(
        insertAcquiringSlot(i, 'ahq-B', 'agent/alice', 'local-B', null),
        `slot ${i} must block same-branch task`,
      ).toBeNull();
    }

    // Higher-level claimSlot also returns null for the same branch
    expect(claimSlot('ahq-B', 'agent/alice', 'local-B', null)).toBeNull();

    // Task A's slot must still be intact — no corruption
    const active = getActiveSlots();
    expect(active).toHaveLength(1);
    expect(active[0].ahq_task_id).toBe('ahq-A');
    expect(active[0].branch_id).toBe('agent/alice');
  });

  it('allows the deferred task to claim a slot once the branch is free', () => {
    const slotAId = insertAcquiringSlot(
      0,
      'ahq-A',
      'agent/alice',
      'local-A',
      null,
    )!;

    // B is still blocked
    expect(claimSlot('ahq-B', 'agent/alice', 'local-B', null)).toBeNull();

    // A finishes; slot is freed
    freeSlot(slotAId, 'ahq-A');

    // B can now claim
    const claimB = claimSlot('ahq-B', 'agent/alice', 'local-B', null);
    expect(claimB).not.toBeNull();
    expect(claimB!.slotIndex).toBe(0);
  });

  it('allows two tasks with different branch_ids to hold slots simultaneously', () => {
    const slotA = insertAcquiringSlot(0, 'ahq-A', 'agent/alice', 'local-A', null);
    const slotB = insertAcquiringSlot(1, 'ahq-B', 'agent/bob', 'local-B', null);

    expect(slotA).not.toBeNull();
    expect(slotB).not.toBeNull();
    expect(getActiveSlots()).toHaveLength(2);
  });
});

// ===========================================================================
// Invariant 4: 3 failed dispatch attempts transitions task to blocked with
//              dispatch_blocked_until
//
// Failure scenario: a task repeatedly fails to dispatch (e.g., AHQ returns
// an error, the container image is broken, or the prompt is malformed). Without
// a retry ceiling, the dispatch loop burns every tick on the same broken task,
// starving healthy tasks. The guard is a retry counter that blocks the task for
// 24 hours after 3 consecutive failures.
// ===========================================================================
describe('Invariant 4: 3 failed dispatch attempts → task marked blocked with dispatch_blocked_until', () => {
  it('calls agencyFetch with status=blocked and dispatch_blocked_until after 3 retries', async () => {
    const mockFetch = vi.mocked(agencyFetch);

    // Captured PUT payloads to /tasks/task-retry
    const capturedPuts: Array<{ status?: string; dispatch_blocked_until?: string }> = [];

    mockFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/tasks?status=ready') {
        return mockResponse({
          success: true,
          data: [makeAhqTask({ id: 'task-retry' })],
        });
      }
      if (path === '/tasks/task-retry' && opts?.method === 'PUT') {
        const body = JSON.parse(opts.body as string) as {
          status?: string;
          dispatch_blocked_until?: string;
        };
        capturedPuts.push(body);
      }
      return mockResponse({ success: true });
    });

    // Simulate 3 prior failures — next tick should trigger markBlocked
    dispatchRetryCount.set('task-retry', 3);

    await dispatchReadyTasks(makeMockDeps(), () => false);

    // Exactly one blocked PUT must have been sent
    const blockedPut = capturedPuts.find((p) => p.status === 'blocked');
    expect(blockedPut, 'no PUT with status=blocked was sent').toBeDefined();
    expect(blockedPut!.dispatch_blocked_until).toBeTruthy();

    // dispatch_blocked_until must be a valid future timestamp (24 h window)
    const blockedUntilMs = new Date(blockedPut!.dispatch_blocked_until!).getTime();
    expect(blockedUntilMs).toBeGreaterThan(Date.now());
    // Sanity: no more than 25 h in the future
    expect(blockedUntilMs).toBeLessThan(Date.now() + 25 * 60 * 60_000);

    // Retry counter must be cleared once the task is blocked
    expect(dispatchRetryCount.has('task-retry')).toBe(false);
  });

  it('applies exponential skip-tick backoff on failures 1 and 2', async () => {
    const mockFetch = vi.mocked(agencyFetch);

    // Track which task IDs reach dispatchTask (PUT in-progress)
    const inProgressPuts: string[] = [];

    mockFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      // Return a task list on the ready poll
      if (path === '/tasks?status=ready') {
        return mockResponse({
          success: true,
          data: [makeAhqTask({ id: 'task-backoff' })],
        });
      }
      // Fail the in-progress PUT (simulates a dispatch failure)
      if (path === '/tasks/task-backoff' && opts?.method === 'PUT') {
        const body = JSON.parse(opts.body as string) as { status?: string };
        if (body.status === 'in-progress') {
          inProgressPuts.push(path);
          return mockResponse({ error: 'not found' }, 404);
        }
        // Rollback PUT (ready) succeeds
        if (body.status === 'ready') return mockResponse({ success: true });
      }
      return mockResponse({ success: true });
    });

    // ── Failure 1 ──────────────────────────────────────────────────────────
    await dispatchReadyTasks(makeMockDeps(), () => false);
    expect(dispatchRetryCount.get('task-backoff')).toBe(1);
    // After 1 failure, skip 1 tick
    expect(dispatchSkipTicks.get('task-backoff')).toBe(1);

    // ── Skipped tick ───────────────────────────────────────────────────────
    inProgressPuts.length = 0;
    await dispatchReadyTasks(makeMockDeps(), () => false);
    // dispatchTask was NOT called (skipped)
    expect(inProgressPuts).toHaveLength(0);
    // Skip counter decremented to 0
    expect(dispatchSkipTicks.get('task-backoff') ?? 0).toBe(0);

    // ── Failure 2 ──────────────────────────────────────────────────────────
    await dispatchReadyTasks(makeMockDeps(), () => false);
    expect(dispatchRetryCount.get('task-backoff')).toBe(2);
    // After 2 failures, skip 3 ticks
    expect(dispatchSkipTicks.get('task-backoff')).toBe(3);
  });
});

// ===========================================================================
// Invariant 5: Startup reconciliation correctly frees orphaned acquiring rows
//
// Failure scenario: the process crashes after claimSlot() (which inserts an
// 'acquiring' row) but before enqueueTask() creates the local scheduled_task.
// On restart, the slot sits in 'acquiring' forever because the local task that
// would transition it to 'executing' was never created. Without a stale-
// acquiring threshold, that slot is permanently lost until the DB is manually
// cleared.
// ===========================================================================
describe('Invariant 5: startup reconciliation frees orphaned acquiring rows', () => {
  it('frees an acquiring slot that is older than ACQUIRING_STALE_MS', () => {
    vi.useFakeTimers();

    try {
      // Insert at time T (fake clock)
      const slotId = insertAcquiringSlot(
        0,
        'ahq-orphan',
        null,
        'local-orphan',
        null,
      );
      expect(slotId).not.toBeNull();

      // Advance clock past the stale threshold
      vi.advanceTimersByTime(ACQUIRING_STALE_MS + 5_000);

      // Startup reconciliation: one call to recoverStaleSlotRecords()
      const stale = recoverStaleSlotRecords();

      expect(stale).toHaveLength(1);
      expect(stale[0].ahqTaskId).toBe('ahq-orphan');
      expect(stale[0].state).toBe('acquiring');
      expect(stale[0].reason).toMatch(/stuck in acquiring/);

      // Slot must be gone from the active set
      expect(getActiveSlots()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not free a recently acquired slot still within the stale window', () => {
    vi.useFakeTimers();

    try {
      insertAcquiringSlot(0, 'ahq-fresh', null, 'local-fresh', null);

      // Advance to just before the threshold — should still be safe
      vi.advanceTimersByTime(ACQUIRING_STALE_MS - 5_000);

      expect(recoverStaleSlotRecords()).toHaveLength(0);
      expect(getActiveSlots()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-queues the AHQ task via fetch when recoverStaleSlots is called at startup', async () => {
    // recoverStaleSlots() uses the global fetch() directly (not agencyFetch),
    // so we stub the global rather than the agency-hq-client mock.
    const fetchStub = vi.fn().mockResolvedValue(mockResponse({ success: true }));
    vi.stubGlobal('fetch', fetchStub);

    vi.useFakeTimers();

    try {
      // Orphaned acquiring slot from a prior crash
      insertAcquiringSlot(0, 'ahq-crash-victim', null, 'local-crash', null);

      // Advance past the stale threshold
      vi.advanceTimersByTime(ACQUIRING_STALE_MS + 5_000);

      // recoverStaleSlots() is the startup hook in dispatch-pool.ts:
      // it frees stale SQLite rows AND PUTs the AHQ task back to 'ready'.
      await recoverStaleSlots();

      // Slot must be freed in SQLite
      expect(getActiveSlots()).toHaveLength(0);

      // Must have called fetch to re-queue the task (PUT status=ready)
      const reQueueCall = fetchStub.mock.calls.find(
        ([url, opts]: [string, RequestInit]) =>
          typeof url === 'string' &&
          url.includes('ahq-crash-victim') &&
          opts?.method === 'PUT',
      ) as [string, RequestInit] | undefined;
      expect(reQueueCall, 'expected a PUT re-queue call to AHQ').toBeDefined();

      const reQueueBody = JSON.parse(reQueueCall![1].body as string) as {
        status: string;
      };
      expect(reQueueBody.status).toBe('ready');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
