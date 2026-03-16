import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  _testInternals,
  startDispatchLoop,
  startStallDetector,
  stopAgencyHqSubsystems,
} from './agency-hq-dispatcher.js';
import type { SchedulerDependencies } from './task-scheduler.js';
import type { GroupQueue } from './group-queue.js';

const {
  dispatchRetryCount,
  dispatchTime,
  dispatchReadyTasks,
  detectStalledTasks,
  buildPrompt,
  findCeoJid,
  resetStopping,
} = _testInternals;

function makeMockDeps(overrides?: Partial<SchedulerDependencies>): SchedulerDependencies {
  return {
    registeredGroups: () => ({
      'ceo@g.us': { name: 'CEO', folder: 'ceo', trigger: '', added_at: '2026-01-01T00:00:00Z', isMain: true },
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

describe('agency-hq-dispatcher', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _initTestDatabase();
    vi.useFakeTimers();

    fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({ tasks: [] }));
    vi.stubGlobal('fetch', fetchMock);

    // Clean module state
    resetStopping();
    dispatchRetryCount.clear();
    dispatchTime.clear();
  });

  afterEach(async () => {
    await stopAgencyHqSubsystems();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('findCeoJid', () => {
    it('returns CEO group JID when registered', () => {
      const deps = makeMockDeps();
      const result = findCeoJid(deps);
      expect(result).toEqual({ jid: 'ceo@g.us', folder: 'ceo' });
    });

    it('returns null when CEO group is not registered', () => {
      const deps = makeMockDeps({
        registeredGroups: () => ({
          'other@g.us': { name: 'Other', folder: 'other', trigger: '', added_at: '2026-01-01T00:00:00Z', isMain: false },
        }),
      });
      expect(findCeoJid(deps)).toBeNull();
    });
  });

  describe('buildPrompt', () => {
    it('builds prompt with task details and write-back instructions', () => {
      const prompt = buildPrompt({
        id: 'task-1',
        title: 'Fix login bug',
        description: 'Users cannot log in',
        acceptance_criteria: 'Login works',
        repository: 'org/repo',
        status: 'ready',
      }, 'Ship MVP');

      expect(prompt).toContain('/orchestrate Fix login bug');
      expect(prompt).toContain('Users cannot log in');
      expect(prompt).toContain('Acceptance Criteria: Login works');
      expect(prompt).toContain('Repository: org/repo');
      expect(prompt).toContain('Sprint Goal: Ship MVP');
      expect(prompt).toContain('Agency HQ task ID: task-1');
      expect(prompt).toContain('status');
      expect(prompt).toContain('done');
    });
  });

  describe('dispatch loop', () => {
    it('skips when no ready tasks', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ tasks: [] }));
      const deps = makeMockDeps();

      await dispatchReadyTasks(deps);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((deps.queue.enqueueTask as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('skips tasks assigned to hold', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          tasks: [{ id: 't1', title: 'Held', description: 'test', status: 'ready', assigned_to: 'hold' }],
        }),
      );
      const deps = makeMockDeps();

      await dispatchReadyTasks(deps);

      // Only the initial GET, no PUT for in-progress
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((deps.queue.enqueueTask as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('skips tasks with future scheduled_dispatch_at', async () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          tasks: [{ id: 't2', title: 'Future', description: 'test', status: 'ready', scheduled_dispatch_at: future }],
        }),
      );
      const deps = makeMockDeps();

      await dispatchReadyTasks(deps);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((deps.queue.enqueueTask as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('marks task in-progress and enqueues it', async () => {
      // GET ready tasks
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          tasks: [{ id: 't3', title: 'Ready Task', description: 'Do something', status: 'ready' }],
        }),
      );
      // PUT in-progress
      fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

      const deps = makeMockDeps();
      await dispatchReadyTasks(deps);

      // Should have called PUT to mark in-progress
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const putCall = fetchMock.mock.calls[1];
      expect(putCall[0]).toContain('/tasks/t3');
      expect(putCall[1].method).toBe('PUT');
      const putBody = JSON.parse(putCall[1].body);
      expect(putBody.status).toBe('in-progress');

      // Should have enqueued the task
      expect((deps.queue.enqueueTask as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    });

    it('marks task blocked after 3 failed dispatch retries', async () => {
      // Pre-set retry count to 3
      dispatchRetryCount.set('t4', 3);

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          tasks: [{ id: 't4', title: 'Failing Task', description: 'fails', status: 'ready' }],
        }),
      );
      // PUT blocked
      fetchMock.mockResolvedValueOnce(mockFetchResponse({}));
      // POST notification
      fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

      const deps = makeMockDeps();
      await dispatchReadyTasks(deps);

      // Should have PUT blocked status
      const putCall = fetchMock.mock.calls.find(
        (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      expect(JSON.parse(putCall![1]!.body as string).status).toBe('blocked');

      // Should have POST notification
      const postCall = fetchMock.mock.calls.find(
        (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(postCall).toBeDefined();
      expect(JSON.parse(postCall![1]!.body as string).type).toBe('task-blocked');

      // Should NOT have enqueued
      expect((deps.queue.enqueueTask as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('skips dispatch when CEO group is not registered', async () => {
      const deps = makeMockDeps({
        registeredGroups: () => ({}),
      });

      await dispatchReadyTasks(deps);

      // Should not even fetch tasks
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('stall detector', () => {
    it('sends notification for stalled tasks', async () => {
      const stalledTime = Date.now() - 20 * 60_000; // 20 min ago (> 15 min threshold)
      dispatchTime.set('t5', stalledTime);

      // GET in-progress tasks
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          tasks: [{
            id: 't5',
            title: 'Stalled Task',
            description: 'stuck',
            status: 'in-progress',
            dispatched_at: new Date(stalledTime).toISOString(),
          }],
        }),
      );
      // POST notification
      fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

      const deps = makeMockDeps();
      await detectStalledTasks(deps);

      // Should have posted a stall notification
      const postCall = fetchMock.mock.calls.find(
        (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(postCall).toBeDefined();
      expect(JSON.parse(postCall![1]!.body as string).type).toBe('task-stalled');

      // Should have sent message to CEO group
      expect(deps.sendMessage).toHaveBeenCalled();
    });

    it('skips tasks dispatched within the stall threshold', async () => {
      const recentTime = Date.now() - 5 * 60_000; // 5 min ago (< 15 min threshold)
      dispatchTime.set('t6', recentTime);

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          tasks: [{
            id: 't6',
            title: 'Recent Task',
            description: 'working',
            status: 'in-progress',
            dispatched_at: new Date(recentTime).toISOString(),
          }],
        }),
      );

      const deps = makeMockDeps();
      await detectStalledTasks(deps);

      // Should NOT have posted notification (only the GET call)
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('skips tasks that have been updated since dispatch', async () => {
      const stalledTime = Date.now() - 20 * 60_000;
      dispatchTime.set('t7', stalledTime);

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          tasks: [{
            id: 't7',
            title: 'Updated Task',
            description: 'progressing',
            status: 'in-progress',
            dispatched_at: new Date(stalledTime).toISOString(),
            updated_at: new Date(Date.now() - 60_000).toISOString(), // Updated 1 min ago
          }],
        }),
      );

      const deps = makeMockDeps();
      await detectStalledTasks(deps);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('starts and stops dispatch loop cleanly', async () => {
      const deps = makeMockDeps();
      await startDispatchLoop(deps);

      // Should have made initial fetch
      expect(fetchMock).toHaveBeenCalled();

      await stopAgencyHqSubsystems();
      // No errors thrown
    });

    it('starts and stops stall detector cleanly', async () => {
      const deps = makeMockDeps();
      await startStallDetector(deps);
      await stopAgencyHqSubsystems();
      // No errors thrown
    });
  });
});
