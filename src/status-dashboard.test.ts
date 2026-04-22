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
  formatStatusPlain,
  formatStatusColor,
  type StatusSnapshot,
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
});
