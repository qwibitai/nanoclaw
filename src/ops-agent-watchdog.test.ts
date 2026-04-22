import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process before imports
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock runtime-adapter
vi.mock('./runtime-adapter.js', () => ({
  getAgentRuntime: vi.fn(() => ({
    listSessionNames: vi.fn(() => []),
  })),
}));

// Mock dispatch-slot-backends
vi.mock('./dispatch-slot-backends.js', () => ({
  getDispatchSlotBackend: vi.fn(() => ({
    name: 'sqlite',
    listActiveSlots: vi.fn(async () => []),
  })),
}));

// Mock db/index for scheduled task registration
vi.mock('./db/index.js', () => ({
  createTask: vi.fn(),
  getTaskById: vi.fn(() => undefined),
  updateTaskAfterRun: vi.fn(),
}));

import { execSync } from 'child_process';
import { getAgentRuntime } from './runtime-adapter.js';
import { getDispatchSlotBackend } from './dispatch-slot-backends.js';
import { createTask, getTaskById } from './db/index.js';
import {
  detectStuckSlots,
  ensureWatchdogTask,
  restartNanoClaw,
  runWatchdogTick,
  startOpsAgentWatchdog,
  stopOpsAgentWatchdog,
  SLOT_GRACE_PERIOD_MS,
  WATCHDOG_TASK_ID,
  _resetWatchdogState,
} from './ops-agent-watchdog.js';
import type { SchedulerDependencies } from './task-scheduler.js';
import type { GroupQueue } from './group-queue.js';

function makeMockDeps(
  overrides?: Partial<SchedulerDependencies>,
): SchedulerDependencies {
  return {
    registeredGroups: () => ({
      'ceo@g.us': {
        name: 'CEO',
        folder: 'ceo',
        trigger: '',
        added_at: '2026-01-01T00:00:00Z',
        isMain: true,
      },
    }),
    getSessions: () => ({}),
    queue: {
      enqueueTask: vi.fn(),
      registerProcess: vi.fn(),
      closeStdin: vi.fn(),
      notifyIdle: vi.fn(),
      shutdown: vi.fn(),
    } as unknown as GroupQueue,
    onProcess: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Return an ISO timestamp that is `ms` milliseconds in the past. */
function pastTimestamp(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

describe('ops-agent-watchdog', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _resetWatchdogState();

    fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    // Reset mocks
    vi.mocked(getAgentRuntime).mockReturnValue({
      listSessionNames: vi.fn(() => []),
      descriptor: {
        kind: 'tmux-host',
        displayName: 'tmux host sessions',
        isolation: 'host-process',
        dependency: 'tmux',
        proxyBindHost: '127.0.0.1',
        preferredTarget: 'micro-vm',
      },
      stopSession: vi.fn(() => ''),
      hasSession: vi.fn(() => false),
      ensureReady: vi.fn(),
      cleanupOrphans: vi.fn(),
      getStatus: vi.fn(() => ({
        descriptor: {} as never,
        ready: true,
        activeSessions: [],
      })),
    });

    vi.mocked(getDispatchSlotBackend).mockReturnValue({
      name: 'sqlite',
      listActiveSlots: vi.fn(async () => []),
      claimSlot: vi.fn(async () => null),
      markExecuting: vi.fn(async () => {}),
      markReleasing: vi.fn(async () => {}),
      freeSlot: vi.fn(async () => {}),
      recoverStaleSlots: vi.fn(async () => []),
      pruneHistory: vi.fn(() => 0),
    });

    vi.mocked(getTaskById).mockReturnValue(undefined);
    vi.mocked(createTask).mockReturnValue(true);
  });

  afterEach(() => {
    stopOpsAgentWatchdog();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('ensureWatchdogTask', () => {
    it('creates scheduled task row when not present', () => {
      vi.mocked(getTaskById).mockReturnValue(undefined);
      ensureWatchdogTask();
      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          id: WATCHDOG_TASK_ID,
          schedule_type: 'interval',
          schedule_value: '900000',
          status: 'active',
        }),
      );
    });

    it('skips creation when task row already exists', () => {
      vi.mocked(getTaskById).mockReturnValue({
        id: WATCHDOG_TASK_ID,
        status: 'active',
      } as never);
      ensureWatchdogTask();
      expect(createTask).not.toHaveBeenCalled();
    });
  });

  describe('detectStuckSlots', () => {
    it('returns empty when no active slots', async () => {
      const result = await detectStuckSlots();
      expect(result).toEqual([]);
    });

    it('returns empty when executing slot has matching tmux session', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-1',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      // Session matching slot 0's prefix: nanoclaw-devworker0-*
      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => ['nanoclaw-devworker0-1710000000000']),
      });

      const result = await detectStuckSlots();
      expect(result).toEqual([]);
    });

    it('detects stuck slot when another slot has a session but this one does not', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-healthy',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
          {
            slotId: 2,
            slotIndex: 1,
            ahqTaskId: 'task-stuck',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      // Only slot 0 has a session; slot 1 does not
      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => ['nanoclaw-devworker0-1710000000000']),
      });

      const result = await detectStuckSlots();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
        expect.objectContaining({
          slotId: 2,
          slotIndex: 1,
          ahqTaskId: 'task-stuck',
          state: 'executing',
          hasSession: false,
        }),
      );
      expect(result[0].slotAgeMs).toBeGreaterThan(SLOT_GRACE_PERIOD_MS);
    });

    it('detects all stuck slots when no tmux sessions exist', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-1',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
          {
            slotId: 2,
            slotIndex: 1,
            ahqTaskId: 'task-2',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      // No tmux sessions
      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
      });

      const result = await detectStuckSlots();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({
          slotId: 1,
          slotIndex: 0,
          ahqTaskId: 'task-1',
          state: 'executing',
          hasSession: false,
        }),
      );
      expect(result[1]).toEqual(
        expect.objectContaining({
          slotId: 2,
          slotIndex: 1,
          ahqTaskId: 'task-2',
          state: 'executing',
          hasSession: false,
        }),
      );
    });

    it('ignores non-executing slots (acquiring/releasing)', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-1',
            state: 'acquiring',
            worktreePath: null,
            executingAt: null,
          },
          {
            slotId: 2,
            slotIndex: 1,
            ahqTaskId: 'task-2',
            state: 'releasing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      const result = await detectStuckSlots();
      expect(result).toEqual([]);
    });

    it('returns empty when listActiveSlots throws after retries', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => {
          throw new Error('DB error');
        }),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      const resultPromise = detectStuckSlots();
      // Advance timers to allow retries to complete
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;
      expect(result).toEqual([]);
    });

    it('returns empty when tmux listing throws (avoids false positive)', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-1',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => {
          throw new Error('tmux not available');
        }),
      });

      const result = await detectStuckSlots();
      expect(result).toEqual([]);
    });

    it('skips slots within grace period even if no tmux session exists', async () => {
      // Slot entered executing only 2 minutes ago (within 5-min grace period)
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-new',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(2 * 60_000), // 2 min ago
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      // No tmux sessions at all
      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
      });

      const result = await detectStuckSlots();
      expect(result).toEqual([]); // Should NOT be flagged as stuck
    });

    it('detects stuck slot after grace period expires', async () => {
      // Slot entered executing 6 minutes ago (past 5-min grace period)
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-old',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(6 * 60_000), // 6 min ago
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      // No tmux sessions
      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
        hasSession: vi.fn(() => false),
      });

      const result = await detectStuckSlots();
      expect(result).toHaveLength(1);
      expect(result[0].ahqTaskId).toBe('task-old');
      expect(result[0].slotAgeMs).toBeGreaterThanOrEqual(6 * 60_000);
      expect(result[0].hasSession).toBe(false);
    });

    it('does not flag slot as stuck when hasSession confirms active process', async () => {
      // Slot past grace period but hasSession returns true
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-active',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      // listSessionNames returns nothing, but hasSession returns true
      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
        hasSession: vi.fn(() => true),
      });

      const result = await detectStuckSlots();
      expect(result).toEqual([]); // hasSession saved it from false positive
    });

    it('handles null executingAt gracefully (treats as past grace period)', async () => {
      // executingAt is null (e.g., PG backend may not return it)
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-unknown-age',
            state: 'executing',
            worktreePath: null,
            executingAt: null,
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      // No tmux sessions
      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
        hasSession: vi.fn(() => false),
      });

      const result = await detectStuckSlots();
      expect(result).toHaveLength(1);
      expect(result[0].slotAgeMs).toBeNull();
    });

    it('includes slot age and process info in stuck slot details', async () => {
      const ageMs = SLOT_GRACE_PERIOD_MS + 120_000; // 7 minutes
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 2,
            ahqTaskId: 'task-diagnostics',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(ageMs),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
        hasSession: vi.fn(() => false),
      });

      const result = await detectStuckSlots();
      expect(result).toHaveLength(1);
      // slotAgeMs should be roughly ageMs (allow 1s tolerance for test execution)
      expect(result[0].slotAgeMs).toBeGreaterThanOrEqual(ageMs - 1000);
      expect(result[0].slotAgeMs).toBeLessThanOrEqual(ageMs + 1000);
      expect(result[0].hasSession).toBe(false);
      expect(result[0].slotIndex).toBe(2);
    });

    it('skips slot when Agency HQ task status is terminal (done)', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-done',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
        hasSession: vi.fn(() => false),
      });

      // Agency HQ returns terminal status 'done'
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ data: { status: 'done' } }),
      );

      const result = await detectStuckSlots();
      expect(result).toEqual([]); // Not flagged because task is done
      // Should have queried Agency HQ for task status
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain('/tasks/task-done');
    });

    it('skips slot when Agency HQ task status is in-review', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-reviewed',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
        hasSession: vi.fn(() => false),
      });

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ data: { status: 'in-review' } }),
      );

      const result = await detectStuckSlots();
      expect(result).toEqual([]);
    });

    it('skips slot when Agency HQ task status is cancelled', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-cancelled',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
        hasSession: vi.fn(() => false),
      });

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ data: { status: 'cancelled' } }),
      );

      const result = await detectStuckSlots();
      expect(result).toEqual([]);
    });

    it('flags slot when Agency HQ task status is active (in-progress)', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-active',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
        hasSession: vi.fn(() => false),
      });

      // Agency HQ returns active status 'in-progress'
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ data: { status: 'in-progress' } }),
      );

      const result = await detectStuckSlots();
      expect(result).toHaveLength(1);
      expect(result[0].ahqTaskId).toBe('task-active');
    });

    it('flags slot when Agency HQ task status query fails (conservative)', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-unknown',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
        hasSession: vi.fn(() => false),
      });

      // Agency HQ task query fails
      fetchMock.mockRejectedValueOnce(new Error('network error'));

      const result = await detectStuckSlots();
      // Should still flag the slot when API fails
      expect(result).toHaveLength(1);
      expect(result[0].ahqTaskId).toBe('task-unknown');
    });

    it('flags slot when Agency HQ returns non-OK response', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-404',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
        hasSession: vi.fn(() => false),
      });

      // Agency HQ returns 404
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ error: 'not found' }, false, 404),
      );

      const result = await detectStuckSlots();
      expect(result).toHaveLength(1);
      expect(result[0].ahqTaskId).toBe('task-404');
    });
  });

  describe('restartNanoClaw', () => {
    it('calls systemctl restart and returns true', () => {
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      const result = restartNanoClaw();
      expect(result).toBe(true);
      expect(execSync).toHaveBeenCalledWith(
        'systemctl --user restart nanoclaw',
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('returns false when systemctl fails', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('systemctl failed');
      });
      const result = restartNanoClaw();
      expect(result).toBe(false);
    });

    it('respects restart cooldown', () => {
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));

      // First restart succeeds
      expect(restartNanoClaw()).toBe(true);

      // Second restart within cooldown should be rejected
      vi.advanceTimersByTime(5 * 60_000); // 5 minutes (< 20 min cooldown)
      expect(restartNanoClaw()).toBe(false);

      // After cooldown, restart should work
      vi.advanceTimersByTime(16 * 60_000); // +16 more minutes (total 21 min)
      expect(restartNanoClaw()).toBe(true);
    });
  });

  describe('runWatchdogTick', () => {
    it('does nothing when no stuck slots detected', async () => {
      const deps = makeMockDeps();
      await runWatchdogTick(deps, () => false);

      expect(deps.sendMessage).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does nothing when stopping', async () => {
      const deps = makeMockDeps();
      await runWatchdogTick(deps, () => true);

      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('sends notification, logs to AHQ, and restarts when stuck slots found', async () => {
      // Set up stuck slot scenario (past grace period)
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'stuck-task-1',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      // No tmux sessions
      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
      });

      // Mock systemctl restart
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));

      // Mock Agency HQ notification POST
      fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

      const deps = makeMockDeps();
      await runWatchdogTick(deps, () => false);

      // Should have sent Telegram notification to CEO with diagnostic info
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      const sentMsg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      expect(sentMsg).toContain('Ops Watchdog Recovery');
      expect(sentMsg).toContain('stuck-task-1');
      expect(sentMsg).toContain('age:');
      expect(sentMsg).toContain('min');
      expect(sentMsg).toContain('process: none');

      // Should have logged to Agency HQ with slot diagnostics
      // fetchMock calls: 1 task status query + 1 notification POST
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain('/tasks/stuck-task-1');
      const postCall = fetchMock.mock.calls[1];
      expect(postCall[0]).toContain('/notifications');
      const body = JSON.parse(postCall[1].body);
      expect(body.type).toBe('dispatch-watchdog-recovery');
      expect(body.metadata.stuck_slots[0]).toHaveProperty('slot_age_ms');
      expect(body.metadata.stuck_slots[0]).toHaveProperty('has_session', false);

      // Should have called systemctl restart
      expect(execSync).toHaveBeenCalledWith(
        'systemctl --user restart nanoclaw',
        expect.anything(),
      );
    });

    it('sends notification even when CEO group is not registered', async () => {
      // Set up stuck slot scenario (past grace period)
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'stuck-task-1',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
      });

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

      // No CEO group registered
      const deps = makeMockDeps({
        registeredGroups: () => ({}),
      });

      await runWatchdogTick(deps, () => false);

      // Should NOT have sent Telegram (no CEO group)
      expect(deps.sendMessage).not.toHaveBeenCalled();

      // Should still log to AHQ and restart
      // fetchMock calls: 1 task status query + 1 notification POST
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(execSync).toHaveBeenCalled();
    });

    it('uses notification batcher when available', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'stuck-task-1',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
      });

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

      const mockBatcher = {
        send: vi.fn().mockResolvedValue(undefined),
        flushAll: vi.fn().mockResolvedValue(undefined),
      };

      const deps = makeMockDeps();
      await runWatchdogTick(
        deps,
        () => false,
        mockBatcher as unknown as import('./notification-batcher.js').NotificationBatcher,
      );

      // Should use batcher instead of direct sendMessage
      expect(mockBatcher.send).toHaveBeenCalledTimes(1);
      expect(mockBatcher.send).toHaveBeenCalledWith(
        'ceo@g.us',
        expect.stringContaining('Ops Watchdog Recovery'),
        'critical',
      );
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('retries Agency HQ notification on transient failure', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'stuck-task-1',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(SLOT_GRACE_PERIOD_MS + 60_000),
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
      });

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));

      // First call: task status query (succeeds with active status)
      // Second call: notification POST (fails)
      // Third call: notification POST retry (succeeds)
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse({ data: { status: 'in-progress' } }),
        )
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(mockFetchResponse({}));

      const deps = makeMockDeps();
      const tickPromise = runWatchdogTick(deps, () => false);

      // Advance timers to allow retry delay (1000ms base)
      await vi.advanceTimersByTimeAsync(2_000);
      await tickPromise;

      // Should have been called 3 times: 1 task status + 1 failed notification + 1 retry
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not restart when all executing slots are within grace period', async () => {
      // Simulate a normal task that just started (1 min ago)
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'normal-task',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(1 * 60_000), // 1 min ago
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      // No tmux sessions (e.g., session hasn't started yet)
      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
      });

      const deps = makeMockDeps();
      await runWatchdogTick(deps, () => false);

      // Should NOT send notification, log to AHQ, or restart
      expect(deps.sendMessage).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(execSync).not.toHaveBeenCalled();
    });

    it('catches truly stuck slot (past grace period, no process)', async () => {
      // Simulate a truly stuck slot: 10 min old, no tmux session, hasSession=false
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'stuck-task',
            state: 'executing',
            worktreePath: null,
            executingAt: pastTimestamp(10 * 60_000), // 10 min ago
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
        hasSession: vi.fn(() => false),
      });

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

      const deps = makeMockDeps();
      await runWatchdogTick(deps, () => false);

      // Should have sent notification and restarted
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      expect(execSync).toHaveBeenCalledWith(
        'systemctl --user restart nanoclaw',
        expect.anything(),
      );
    });
  });

  describe('lifecycle', () => {
    it('starts and stops cleanly', () => {
      const deps = makeMockDeps();
      startOpsAgentWatchdog(deps, () => false);
      stopOpsAgentWatchdog();
      // No errors thrown
    });

    it('registers scheduled task row on start', () => {
      const deps = makeMockDeps();
      startOpsAgentWatchdog(deps, () => false);

      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          id: WATCHDOG_TASK_ID,
          schedule_type: 'interval',
        }),
      );

      stopOpsAgentWatchdog();
    });

    it('runs tick on interval', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => []),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      const deps = makeMockDeps();
      startOpsAgentWatchdog(deps, () => false);

      // Advance past the 15-minute interval
      await vi.advanceTimersByTimeAsync(15 * 60_000);

      // listActiveSlots should have been called (tick ran)
      const backend = getDispatchSlotBackend();
      expect(backend.listActiveSlots).toHaveBeenCalled();

      stopOpsAgentWatchdog();
    });
  });
});
