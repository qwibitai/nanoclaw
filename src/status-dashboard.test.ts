import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock agency-hq-client to avoid real HTTP calls
vi.mock('./agency-hq-client.js', () => ({
  AGENCY_HQ_URL: 'http://localhost:3040',
  agencyFetch: vi.fn(),
}));

// Mock dispatch-slot-backends to avoid SQLite dependency
vi.mock('./dispatch-slot-backends.js', () => ({
  getDispatchSlotBackend: vi.fn(),
}));

import { agencyFetch } from './agency-hq-client.js';
import { getDispatchSlotBackend } from './dispatch-slot-backends.js';
import {
  buildStatusSnapshot,
  buildHistoricalSnapshot,
  formatStatusPlain,
  formatStatusColor,
  formatHistoricalPlain,
  formatHistoricalColor,
  type StatusSnapshot,
  type HistoricalSnapshot,
} from './status-dashboard.js';

const mockAgencyFetch = vi.mocked(agencyFetch);
const mockGetBackend = vi.mocked(getDispatchSlotBackend);

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

describe('status-dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildStatusSnapshot', () => {
    it('returns all FREE slots when no active slots', async () => {
      mockGetBackend.mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn().mockResolvedValue([]),
        claimSlot: vi.fn(),
        markExecuting: vi.fn(),
        markReleasing: vi.fn(),
        freeSlot: vi.fn(),
        recoverStaleSlots: vi.fn(),
        pruneHistory: vi.fn(),
      });

      // Queue depth query
      mockAgencyFetch.mockResolvedValue(
        makeResponse({ success: true, data: [] }),
      );

      const snapshot = await buildStatusSnapshot();

      expect(snapshot.error).toBeNull();
      expect(snapshot.slots).toHaveLength(4);
      for (const slot of snapshot.slots) {
        expect(slot.state).toBe('FREE');
        expect(slot.taskId).toBeNull();
      }
      expect(snapshot.queueDepth).toBe(0);
    });

    it('marks occupied slots as BUSY with task metadata', async () => {
      mockGetBackend.mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn().mockResolvedValue([
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-abc-123',
            state: 'executing',
            worktreePath: null,
            executingAt: new Date(Date.now() - 90_000).toISOString(), // 1m 30s ago
          },
          {
            slotId: 2,
            slotIndex: 2,
            ahqTaskId: 'task-def-456',
            state: 'acquiring',
            worktreePath: null,
            executingAt: null,
          },
        ]),
        claimSlot: vi.fn(),
        markExecuting: vi.fn(),
        markReleasing: vi.fn(),
        freeSlot: vi.fn(),
        recoverStaleSlots: vi.fn(),
        pruneHistory: vi.fn(),
      });

      // Task title lookups + queue depth
      mockAgencyFetch.mockImplementation(async (path: string) => {
        if (path === '/tasks/task-abc-123') {
          return makeResponse({
            success: true,
            data: { id: 'task-abc-123', title: 'Implement auth' },
          });
        }
        if (path === '/tasks/task-def-456') {
          return makeResponse({
            success: true,
            data: { id: 'task-def-456', title: 'Fix bug' },
          });
        }
        if (path === '/tasks?status=ready') {
          return makeResponse({
            success: true,
            data: [{ id: 'queued-1' }, { id: 'queued-2' }, { id: 'queued-3' }],
          });
        }
        return makeResponse({ error: 'not found' }, false, 404);
      });

      const snapshot = await buildStatusSnapshot();

      expect(snapshot.error).toBeNull();
      expect(snapshot.slots[0].state).toBe('BUSY');
      expect(snapshot.slots[0].taskId).toBe('task-abc-123');
      expect(snapshot.slots[0].taskTitle).toBe('Implement auth');
      expect(snapshot.slots[0].elapsedMs).toBeGreaterThan(80_000);

      expect(snapshot.slots[1].state).toBe('FREE');

      expect(snapshot.slots[2].state).toBe('BUSY');
      expect(snapshot.slots[2].taskId).toBe('task-def-456');
      expect(snapshot.slots[2].taskTitle).toBe('Fix bug');
      expect(snapshot.slots[2].elapsedMs).toBeNull(); // not yet executing

      expect(snapshot.slots[3].state).toBe('FREE');

      expect(snapshot.queueDepth).toBe(3);
    });

    it('falls back to Agency HQ when local backend throws', async () => {
      mockGetBackend.mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi
          .fn()
          .mockRejectedValue(new Error('DB not initialized')),
        claimSlot: vi.fn(),
        markExecuting: vi.fn(),
        markReleasing: vi.fn(),
        freeSlot: vi.fn(),
        recoverStaleSlots: vi.fn(),
        pruneHistory: vi.fn(),
      });

      mockAgencyFetch.mockImplementation(async (path: string) => {
        if (path === '/dispatch-slots/active') {
          return makeResponse({ success: true, data: [] });
        }
        if (path === '/tasks?status=ready') {
          return makeResponse({ success: true, data: [] });
        }
        return makeResponse({}, false, 404);
      });

      const snapshot = await buildStatusSnapshot();

      expect(snapshot.error).toBeNull();
      expect(snapshot.slots).toHaveLength(4);
      for (const slot of snapshot.slots) {
        expect(slot.state).toBe('FREE');
      }
    });

    it('returns UNKNOWN state when all queries fail', async () => {
      mockGetBackend.mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi
          .fn()
          .mockRejectedValue(new Error('DB not initialized')),
        claimSlot: vi.fn(),
        markExecuting: vi.fn(),
        markReleasing: vi.fn(),
        freeSlot: vi.fn(),
        recoverStaleSlots: vi.fn(),
        pruneHistory: vi.fn(),
      });

      mockAgencyFetch.mockRejectedValue(new Error('connection refused'));

      const snapshot = await buildStatusSnapshot();

      expect(snapshot.error).toBeTruthy();
      expect(snapshot.slots).toHaveLength(4);
      for (const slot of snapshot.slots) {
        expect(slot.state).toBe('UNKNOWN');
      }
      expect(snapshot.queueDepth).toBe(0);
    });
  });

  describe('formatStatusPlain', () => {
    it('formats all-free snapshot', () => {
      const snapshot: StatusSnapshot = {
        timestamp: '2026-04-22T12:00:00.000Z',
        slots: [
          {
            index: 0,
            state: 'FREE',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
          {
            index: 1,
            state: 'FREE',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
          {
            index: 2,
            state: 'FREE',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
          {
            index: 3,
            state: 'FREE',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
        ],
        queueDepth: 0,
        error: null,
      };

      const output = formatStatusPlain(snapshot);

      expect(output).toContain('NanoClaw Status');
      expect(output).toContain('[FREE]');
      expect(output).not.toContain('[BUSY]');
      expect(output).toContain('0 tasks ready');
    });

    it('formats busy slots with task info and elapsed time', () => {
      const snapshot: StatusSnapshot = {
        timestamp: '2026-04-22T12:00:00.000Z',
        slots: [
          {
            index: 0,
            state: 'BUSY',
            taskId: 'abc12345-6789',
            taskTitle: 'Implement auth',
            elapsedMs: 125_000, // 2m 05s
          },
          {
            index: 1,
            state: 'FREE',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
          {
            index: 2,
            state: 'FREE',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
          {
            index: 3,
            state: 'FREE',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
        ],
        queueDepth: 5,
        error: null,
      };

      const output = formatStatusPlain(snapshot);

      expect(output).toContain('[BUSY]');
      expect(output).toContain('Implement auth');
      expect(output).toContain('(abc12345)');
      expect(output).toContain('2m 05s');
      expect(output).toContain('5 tasks ready');
    });

    it('shows error message when present', () => {
      const snapshot: StatusSnapshot = {
        timestamp: '2026-04-22T12:00:00.000Z',
        slots: [
          {
            index: 0,
            state: 'UNKNOWN',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
          {
            index: 1,
            state: 'UNKNOWN',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
          {
            index: 2,
            state: 'UNKNOWN',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
          {
            index: 3,
            state: 'UNKNOWN',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
        ],
        queueDepth: 0,
        error: 'connection refused',
      };

      const output = formatStatusPlain(snapshot);

      expect(output).toContain('Error: connection refused');
      expect(output).toContain('[UNKNOWN]');
    });

    it('uses singular "task" for queue depth of 1', () => {
      const snapshot: StatusSnapshot = {
        timestamp: '2026-04-22T12:00:00.000Z',
        slots: [
          {
            index: 0,
            state: 'FREE',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
          {
            index: 1,
            state: 'FREE',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
          {
            index: 2,
            state: 'FREE',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
          {
            index: 3,
            state: 'FREE',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
        ],
        queueDepth: 1,
        error: null,
      };

      const output = formatStatusPlain(snapshot);
      expect(output).toContain('1 task ready');
      expect(output).not.toContain('1 tasks');
    });
  });

  describe('formatStatusColor', () => {
    it('includes ANSI escape codes', () => {
      const snapshot: StatusSnapshot = {
        timestamp: '2026-04-22T12:00:00.000Z',
        slots: [
          {
            index: 0,
            state: 'BUSY',
            taskId: 'abc12345-6789',
            taskTitle: 'Fix bug',
            elapsedMs: 60_000,
          },
          {
            index: 1,
            state: 'FREE',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
          {
            index: 2,
            state: 'FREE',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
          {
            index: 3,
            state: 'FREE',
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          },
        ],
        queueDepth: 2,
        error: null,
      };

      const output = formatStatusColor(snapshot);

      // Should contain ANSI escape sequences
      expect(output).toContain('\x1b[');
      expect(output).toContain('[BUSY]');
      expect(output).toContain('[FREE]');
      expect(output).toContain('Fix bug');
    });
  });

  describe('buildHistoricalSnapshot', () => {
    it('builds historical snapshot with completed tasks', async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3_600_000).toISOString();
      const twoHoursAgo = new Date(now.getTime() - 7_200_000).toISOString();
      const threeHoursAgo = new Date(now.getTime() - 10_800_000).toISOString();

      mockAgencyFetch.mockImplementation(async (path: string) => {
        if (path === '/tasks?status=done') {
          return makeResponse({
            success: true,
            data: [
              {
                id: 'task-001',
                title: 'Add login page',
                status: 'done',
                created_at: threeHoursAgo,
                dispatched_at: twoHoursAgo,
                updated_at: oneHourAgo,
              },
              {
                id: 'task-002',
                title: 'Fix database migration',
                status: 'done',
                created_at: threeHoursAgo,
                dispatched_at: twoHoursAgo,
                updated_at: oneHourAgo,
              },
            ],
          });
        }
        if (path === '/tasks?status=failed') {
          return makeResponse({
            success: true,
            data: [
              {
                id: 'task-003',
                title: 'Deploy to staging',
                status: 'failed',
                created_at: threeHoursAgo,
                dispatched_at: twoHoursAgo,
                updated_at: oneHourAgo,
              },
            ],
          });
        }
        if (path === '/tasks?status=cancelled') {
          return makeResponse({ success: true, data: [] });
        }
        if (path === '/tasks?status=ready') {
          return makeResponse({
            success: true,
            data: [{ id: 'queued-1' }],
          });
        }
        if (path === '/tasks?status=in-progress') {
          return makeResponse({ success: true, data: [] });
        }
        return makeResponse({}, false, 404);
      });

      const historical = await buildHistoricalSnapshot();

      expect(historical.error).toBeNull();
      expect(historical.recentTasks).toHaveLength(3);
      expect(historical.recentTasks[0].id).toBe('task-001');
      expect(historical.recentTasks[0].status).toBe('done');
      expect(historical.recentTasks[0].durationMs).toBe(3_600_000); // 1 hour

      // Performance
      expect(historical.performance.totalCompleted).toBe(2);
      expect(historical.performance.totalFailed).toBe(1);
      expect(historical.performance.errorRate).toBeCloseTo(33.3, 0);
      expect(historical.performance.avgCompletionMs).toBe(3_600_000);
      expect(historical.performance.slowestTasks).toHaveLength(2);

      // Queue
      expect(historical.queue.avgDepth).toBe(1);
      expect(historical.queue.avgWaitMs).toBe(3_600_000); // 1 hour wait

      // Utilization (no in-progress tasks)
      expect(historical.utilization.avgSlotsInUse).toBe(0);
      expect(historical.utilization.idlePercent).toBe(100);
    });

    it('returns empty snapshot when all API calls fail', async () => {
      mockAgencyFetch.mockRejectedValue(new Error('connection refused'));

      const historical = await buildHistoricalSnapshot();

      // Individual API failures are caught per-status, so the snapshot
      // is returned without an error but with empty data.
      expect(historical.recentTasks).toHaveLength(0);
      expect(historical.performance.totalCompleted).toBe(0);
      expect(historical.performance.totalFailed).toBe(0);
      expect(historical.utilization.avgSlotsInUse).toBe(0);
      expect(historical.utilization.idlePercent).toBe(100);
    });

    it('includes in-progress tasks in utilization', async () => {
      const now = new Date();
      const thirtyMinAgo = new Date(now.getTime() - 1_800_000).toISOString();

      mockAgencyFetch.mockImplementation(async (path: string) => {
        if (path === '/tasks?status=done') {
          return makeResponse({ success: true, data: [] });
        }
        if (path === '/tasks?status=failed') {
          return makeResponse({ success: true, data: [] });
        }
        if (path === '/tasks?status=cancelled') {
          return makeResponse({ success: true, data: [] });
        }
        if (path === '/tasks?status=ready') {
          return makeResponse({ success: true, data: [] });
        }
        if (path === '/tasks?status=in-progress') {
          return makeResponse({
            success: true,
            data: [
              {
                id: 'active-1',
                title: 'Running task 1',
                status: 'in-progress',
                dispatched_at: thirtyMinAgo,
              },
              {
                id: 'active-2',
                title: 'Running task 2',
                status: 'in-progress',
                dispatched_at: thirtyMinAgo,
              },
            ],
          });
        }
        return makeResponse({}, false, 404);
      });

      const historical = await buildHistoricalSnapshot();

      expect(historical.utilization.avgSlotsInUse).toBe(2);
      expect(historical.utilization.peakSlotsInUse).toBe(2);
      expect(historical.utilization.idlePercent).toBe(50);
    });

    it('limits recent tasks to 10', async () => {
      const now = new Date();
      const tasks = Array.from({ length: 15 }, (_, i) => ({
        id: `task-${String(i).padStart(3, '0')}`,
        title: `Task ${i}`,
        status: 'done',
        created_at: new Date(
          now.getTime() - (20 - i) * 3_600_000,
        ).toISOString(),
        dispatched_at: new Date(
          now.getTime() - (19 - i) * 3_600_000,
        ).toISOString(),
        updated_at: new Date(
          now.getTime() - (18 - i) * 3_600_000,
        ).toISOString(),
      }));

      mockAgencyFetch.mockImplementation(async (path: string) => {
        if (path === '/tasks?status=done') {
          return makeResponse({ success: true, data: tasks });
        }
        if (path === '/tasks?status=failed') {
          return makeResponse({ success: true, data: [] });
        }
        if (path === '/tasks?status=cancelled') {
          return makeResponse({ success: true, data: [] });
        }
        if (path === '/tasks?status=ready') {
          return makeResponse({ success: true, data: [] });
        }
        if (path === '/tasks?status=in-progress') {
          return makeResponse({ success: true, data: [] });
        }
        return makeResponse({}, false, 404);
      });

      const historical = await buildHistoricalSnapshot();

      expect(historical.recentTasks).toHaveLength(10);
      // Stats should be computed from up to 50 tasks (all 15)
      expect(historical.performance.totalCompleted).toBe(15);
    });
  });

  describe('formatHistoricalPlain', () => {
    const freeSlots: StatusSnapshot['slots'] = Array.from(
      { length: 4 },
      (_, i) => ({
        index: i,
        state: 'FREE' as const,
        taskId: null,
        taskTitle: null,
        elapsedMs: null,
      }),
    );

    const baseSnapshot: StatusSnapshot = {
      timestamp: '2026-04-22T12:00:00.000Z',
      slots: freeSlots,
      queueDepth: 2,
      error: null,
    };

    const baseHistorical: HistoricalSnapshot = {
      recentTasks: [
        {
          id: 'task-001-abcd',
          title: 'Add login page',
          status: 'done',
          completedAt: '2026-04-22T11:30:00.000Z',
          durationMs: 1_800_000,
        },
        {
          id: 'task-002-efgh',
          title: 'Fix database migration',
          status: 'failed',
          completedAt: '2026-04-22T11:00:00.000Z',
          durationMs: 600_000,
        },
      ],
      utilization: {
        avgSlotsInUse: 1,
        peakSlotsInUse: 3,
        peakTime: '2026-04-22T10:00:00.000Z',
        idlePercent: 75,
      },
      queue: {
        avgDepth: 2,
        avgWaitMs: 300_000,
        longestWaitMs: 900_000,
        longestWaitTaskId: 'task-002-efgh',
      },
      performance: {
        avgCompletionMs: 1_200_000,
        slowestTasks: [
          {
            id: 'task-001-abcd',
            title: 'Add login page',
            durationMs: 1_800_000,
          },
        ],
        errorRate: 50,
        totalCompleted: 1,
        totalFailed: 1,
      },
      error: null,
    };

    it('includes box-drawing characters', () => {
      const output = formatHistoricalPlain(baseSnapshot, baseHistorical);

      expect(output).toContain('\u250c'); // top-left corner
      expect(output).toContain('\u2510'); // top-right corner
      expect(output).toContain('\u2514'); // bottom-left corner
      expect(output).toContain('\u2518'); // bottom-right corner
      expect(output).toContain('\u251c'); // left tee
      expect(output).toContain('\u2524'); // right tee
    });

    it('shows all dashboard sections', () => {
      const output = formatHistoricalPlain(baseSnapshot, baseHistorical);

      expect(output).toContain('NanoClaw Status Dashboard');
      expect(output).toContain('Worker Slots');
      expect(output).toContain('Recent Activity');
      expect(output).toContain('Worker Utilization');
      expect(output).toContain('Queue Metrics');
      expect(output).toContain('Performance Trends');
    });

    it('displays recent tasks with status icons', () => {
      const output = formatHistoricalPlain(baseSnapshot, baseHistorical);

      expect(output).toContain('\u2713'); // checkmark for done
      expect(output).toContain('\u2717'); // x for failed
      expect(output).toContain('task-001');
      expect(output).toContain('Add login page');
      expect(output).toContain('30m 00s'); // 1_800_000ms = 30m
    });

    it('displays utilization metrics', () => {
      const output = formatHistoricalPlain(baseSnapshot, baseHistorical);

      expect(output).toContain('Avg slots in use:');
      expect(output).toContain('1/4');
      expect(output).toContain('Peak slots:');
      expect(output).toContain('3/4');
      expect(output).toContain('75.0%');
    });

    it('displays queue metrics', () => {
      const output = formatHistoricalPlain(baseSnapshot, baseHistorical);

      expect(output).toContain('Current depth:');
      expect(output).toContain('Avg wait time:');
      expect(output).toContain('5m 00s'); // 300_000ms = 5m
      expect(output).toContain('Longest queued:');
      expect(output).toContain('15m 00s'); // 900_000ms = 15m
    });

    it('displays performance trends', () => {
      const output = formatHistoricalPlain(baseSnapshot, baseHistorical);

      expect(output).toContain('Avg completion:');
      expect(output).toContain('20m 00s'); // 1_200_000ms = 20m
      expect(output).toContain('Error rate:');
      expect(output).toContain('50.0%');
      expect(output).toContain('1/2');
      expect(output).toContain('Slowest tasks:');
    });

    it('shows no recent tasks message when empty', () => {
      const emptyHistorical: HistoricalSnapshot = {
        ...baseHistorical,
        recentTasks: [],
      };

      const output = formatHistoricalPlain(baseSnapshot, emptyHistorical);

      expect(output).toContain('No recent tasks');
    });
  });

  describe('formatHistoricalColor', () => {
    const freeSlots: StatusSnapshot['slots'] = Array.from(
      { length: 4 },
      (_, i) => ({
        index: i,
        state: 'FREE' as const,
        taskId: null,
        taskTitle: null,
        elapsedMs: null,
      }),
    );

    it('includes ANSI escape codes in historical output', () => {
      const snapshot: StatusSnapshot = {
        timestamp: '2026-04-22T12:00:00.000Z',
        slots: freeSlots,
        queueDepth: 0,
        error: null,
      };

      const historical: HistoricalSnapshot = {
        recentTasks: [
          {
            id: 'task-001-abcd',
            title: 'Test task',
            status: 'done',
            completedAt: '2026-04-22T11:30:00.000Z',
            durationMs: 600_000,
          },
        ],
        utilization: {
          avgSlotsInUse: 0,
          peakSlotsInUse: 0,
          peakTime: null,
          idlePercent: 100,
        },
        queue: {
          avgDepth: 0,
          avgWaitMs: 0,
          longestWaitMs: 0,
          longestWaitTaskId: null,
        },
        performance: {
          avgCompletionMs: 600_000,
          slowestTasks: [],
          errorRate: 0,
          totalCompleted: 1,
          totalFailed: 0,
        },
        error: null,
      };

      const output = formatHistoricalColor(snapshot, historical);

      expect(output).toContain('\x1b[');
      expect(output).toContain('NanoClaw Status Dashboard');
      expect(output).toContain('Worker Slots');
      expect(output).toContain('Recent Activity');
      expect(output).toContain('Performance Trends');
      expect(output).toContain('Test task');
    });
  });
});
