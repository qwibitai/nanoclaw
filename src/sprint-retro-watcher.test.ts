import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildTaskFingerprint,
  checkForCompletedSprints,
  checkSprintStatus,
  detectSprintChanges,
  formatSprintChangeMessage,
  _resetForTesting,
  type SprintDiff,
  type SprintSnapshot,
} from './sprint-retro-watcher.js';
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

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

describe('sprint-retro-watcher', () => {
  describe('buildTaskFingerprint', () => {
    it('produces a sorted, deterministic string from tasks', () => {
      const tasks = [
        { id: 'b', status: 'ready' },
        { id: 'a', status: 'done' },
        { id: 'c', status: 'in-progress' },
      ];
      const fp = buildTaskFingerprint(tasks);
      expect(fp).toBe('a:done|b:ready|c:in-progress');
    });

    it('returns empty string for empty task list', () => {
      expect(buildTaskFingerprint([])).toBe('');
    });

    it('produces different fingerprints when status changes', () => {
      const before = [{ id: 'a', status: 'ready' }];
      const after = [{ id: 'a', status: 'done' }];
      expect(buildTaskFingerprint(before)).not.toBe(
        buildTaskFingerprint(after),
      );
    });

    it('produces different fingerprints when tasks are added', () => {
      const before = [{ id: 'a', status: 'ready' }];
      const after = [
        { id: 'a', status: 'ready' },
        { id: 'b', status: 'ready' },
      ];
      expect(buildTaskFingerprint(before)).not.toBe(
        buildTaskFingerprint(after),
      );
    });
  });

  describe('detectSprintChanges', () => {
    it('detects a new sprint', () => {
      const current: SprintSnapshot[] = [
        {
          sprintId: 's1',
          sprintName: 'Sprint 1',
          status: 'active',
          taskFingerprint: 'a:ready',
          totalTasks: 1,
          completedTasks: 0,
        },
      ];
      const previous = new Map<string, SprintSnapshot>();

      const diffs = detectSprintChanges(current, previous);
      expect(diffs).toHaveLength(1);
      expect(diffs[0].type).toBe('new_sprint');
      expect(diffs[0].sprintName).toBe('Sprint 1');
      expect(diffs[0].details).toContain('New sprint started');
    });

    it('detects task status changes', () => {
      const prev: SprintSnapshot = {
        sprintId: 's1',
        sprintName: 'Sprint 1',
        status: 'active',
        taskFingerprint: 'a:ready|b:ready',
        totalTasks: 2,
        completedTasks: 0,
      };
      const current: SprintSnapshot[] = [
        {
          sprintId: 's1',
          sprintName: 'Sprint 1',
          status: 'active',
          taskFingerprint: 'a:done|b:ready',
          totalTasks: 2,
          completedTasks: 1,
        },
      ];
      const previous = new Map([['s1', prev]]);

      const diffs = detectSprintChanges(current, previous);
      expect(diffs).toHaveLength(1);
      expect(diffs[0].type).toBe('tasks_changed');
      expect(diffs[0].details).toContain('1 task(s) completed');
      expect(diffs[0].details).toContain('50% complete');
    });

    it('detects new tasks added to sprint', () => {
      const prev: SprintSnapshot = {
        sprintId: 's1',
        sprintName: 'Sprint 1',
        status: 'active',
        taskFingerprint: 'a:ready',
        totalTasks: 1,
        completedTasks: 0,
      };
      const current: SprintSnapshot[] = [
        {
          sprintId: 's1',
          sprintName: 'Sprint 1',
          status: 'active',
          taskFingerprint: 'a:ready|b:ready',
          totalTasks: 2,
          completedTasks: 0,
        },
      ];
      const previous = new Map([['s1', prev]]);

      const diffs = detectSprintChanges(current, previous);
      expect(diffs).toHaveLength(1);
      expect(diffs[0].type).toBe('tasks_changed');
      expect(diffs[0].details).toContain('1 new task(s)');
    });

    it('detects sprint completion (removed from active)', () => {
      const prev: SprintSnapshot = {
        sprintId: 's1',
        sprintName: 'Sprint 1',
        status: 'active',
        taskFingerprint: 'a:done',
        totalTasks: 1,
        completedTasks: 1,
      };
      const current: SprintSnapshot[] = [];
      const previous = new Map([['s1', prev]]);

      const diffs = detectSprintChanges(current, previous);
      expect(diffs).toHaveLength(1);
      expect(diffs[0].type).toBe('sprint_completed');
      expect(diffs[0].details).toContain('no longer active');
    });

    it('returns empty array when nothing changed', () => {
      const snap: SprintSnapshot = {
        sprintId: 's1',
        sprintName: 'Sprint 1',
        status: 'active',
        taskFingerprint: 'a:ready|b:done',
        totalTasks: 2,
        completedTasks: 1,
      };
      const current = [{ ...snap }];
      const previous = new Map([['s1', snap]]);

      const diffs = detectSprintChanges(current, previous);
      expect(diffs).toHaveLength(0);
    });

    it('handles multiple simultaneous changes', () => {
      const prev1: SprintSnapshot = {
        sprintId: 's1',
        sprintName: 'Sprint 1',
        status: 'active',
        taskFingerprint: 'a:ready',
        totalTasks: 1,
        completedTasks: 0,
      };
      const current: SprintSnapshot[] = [
        {
          sprintId: 's1',
          sprintName: 'Sprint 1',
          status: 'active',
          taskFingerprint: 'a:done',
          totalTasks: 1,
          completedTasks: 1,
        },
        {
          sprintId: 's2',
          sprintName: 'Sprint 2',
          status: 'active',
          taskFingerprint: 'x:ready',
          totalTasks: 1,
          completedTasks: 0,
        },
      ];
      const previous = new Map([['s1', prev1]]);

      const diffs = detectSprintChanges(current, previous);
      expect(diffs).toHaveLength(2);
      expect(diffs.map((d) => d.type).sort()).toEqual([
        'new_sprint',
        'tasks_changed',
      ]);
    });
  });

  describe('formatSprintChangeMessage', () => {
    it('formats diffs into a Telegram message', () => {
      const diffs: SprintDiff[] = [
        {
          type: 'new_sprint',
          sprintName: 'Sprint 5',
          sprintId: 's5',
          details: 'New sprint started: Sprint 5 (3 tasks)',
        },
        {
          type: 'tasks_changed',
          sprintName: 'Sprint 4',
          sprintId: 's4',
          details: '1 task(s) completed — 50% complete (1/2)',
        },
      ];

      const msg = formatSprintChangeMessage(diffs);
      expect(msg).toContain('*Sprint Status Update*');
      expect(msg).toContain('New sprint started: Sprint 5');
      expect(msg).toContain('*Sprint 4:*');
      expect(msg).toContain('50% complete');
    });
  });

  describe('checkSprintStatus integration', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      _resetForTesting();
      fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('seeds cache on first run without sending messages', async () => {
      // Active sprints fetch
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          data: [{ id: 's1', name: 'Sprint 1', status: 'active' }],
        }),
      );
      // Sprint tasks fetch
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          data: [
            { id: 't1', title: 'Task 1', status: 'ready', description: '' },
          ],
        }),
      );
      // Completed sprints fetch (for checkForCompletedSprints)
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ data: [] }));

      const deps = makeMockDeps();
      await checkSprintStatus(deps, () => false);

      // No message should be sent on first run (cache seeding)
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('sends no message when nothing changed between polls', async () => {
      const sprintData = {
        data: [{ id: 's1', name: 'Sprint 1', status: 'active' }],
      };
      const taskData = {
        data: [{ id: 't1', title: 'Task 1', status: 'ready', description: '' }],
      };

      // First run — seed cache
      fetchMock.mockResolvedValueOnce(mockFetchResponse(sprintData));
      fetchMock.mockResolvedValueOnce(mockFetchResponse(taskData));
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ data: [] }));

      const deps = makeMockDeps();
      await checkSprintStatus(deps, () => false);

      // Second run — same data
      fetchMock.mockResolvedValueOnce(mockFetchResponse(sprintData));
      fetchMock.mockResolvedValueOnce(mockFetchResponse(taskData));
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ data: [] }));

      await checkSprintStatus(deps, () => false);

      // Still no message — nothing changed
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('sends message when task status changes between polls', async () => {
      // First run — seed
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          data: [{ id: 's1', name: 'Sprint 1', status: 'active' }],
        }),
      );
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          data: [
            { id: 't1', title: 'Task 1', status: 'ready', description: '' },
          ],
        }),
      );
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ data: [] }));

      const deps = makeMockDeps();
      await checkSprintStatus(deps, () => false);
      expect(deps.sendMessage).not.toHaveBeenCalled();

      // Second run — task completed
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          data: [{ id: 's1', name: 'Sprint 1', status: 'active' }],
        }),
      );
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          data: [
            { id: 't1', title: 'Task 1', status: 'done', description: '' },
          ],
        }),
      );
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ data: [] }));

      await checkSprintStatus(deps, () => false);

      // Now a message should be sent
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      const message = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      expect(message).toContain('Sprint Status Update');
      expect(message).toContain('Sprint 1');
      expect(message).toContain('completed');
    });

    it('does not send when stopping', async () => {
      const deps = makeMockDeps();
      await checkSprintStatus(deps, () => true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('handles API errors gracefully without sending', async () => {
      // Active sprints fetch fails
      fetchMock.mockResolvedValueOnce(mockFetchResponse({}, false, 500));
      // Completed sprints fetch
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ data: [] }));

      const deps = makeMockDeps();
      await checkSprintStatus(deps, () => false);

      // First run after error still seeds (with empty data), no message
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });
  });
});
