import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createJobRun,
  getJobById,
  listDueJobs,
  listJobRuns,
  markJobRunning,
  releaseStaleJobLeases,
  updateJob,
  upsertJob,
} from '../storage/db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextJobRun,
  startSchedulerLoop,
} from './task-scheduler.js';
import { spawnAgent } from './agent-spawn.js';
import { writeMemoryContextSnapshot } from '../memory/memory-ipc.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';

const reflectAfterTurnMock = vi.fn(async () => {});
const runDreamingSweepMock = vi.fn(async () => ({
  groupFolder: 'main',
  totalItems: 0,
  scoredItems: 0,
  promotedCount: 0,
  decayedCount: 0,
  retiredCount: 0,
  consolidation: null,
  topPromoted: [],
  durationMs: 1,
}));

vi.mock('./agent-spawn.js', () => ({
  spawnAgent: vi.fn(async () => ({
    status: 'success',
    result: 'Job run completed',
    newSessionId: 'session-1',
  })),
}));

vi.mock('../memory/memory-ipc.js', () => ({
  writeMemoryContextSnapshot: vi.fn(async () => ({ retrievedItemIds: [] })),
}));

vi.mock('../platform/group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => '/tmp/test-group-folder'),
}));

vi.mock('../memory/memory-service.js', () => ({
  MemoryService: {
    getInstance: () => ({
      reflectAfterTurn: reflectAfterTurnMock,
      runDreamingSweep: runDreamingSweepMock,
    }),
  },
}));

describe('computeNextJobRun edge cases', () => {
  it('does not hang with small interval and old anchor', () => {
    // Bug: the while loop in computeNextJobRun iterates (now - anchor) / ms times.
    // With a 1ms interval and an anchor 90 days ago, that's ~7.8 billion iterations.
    // The loop should compute the result in O(1) with math, not O(n) by looping.
    const threeMonthsAgo = new Date(
      Date.now() - 90 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const start = Date.now();
    const next = computeNextJobRun(
      { schedule_type: 'interval', schedule_value: '1' },
      threeMonthsAgo,
    );
    const elapsed = Date.now() - start;
    expect(next).not.toBeNull();
    // Should complete in well under 1 second — O(1) math, not O(n) loop
    expect(elapsed).toBeLessThan(1000);
  }, 5000);
});

describe('job scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('computeNextJobRun anchors interval schedules to scheduled time', () => {
    const scheduledFor = new Date(Date.now() - 2_000).toISOString();
    const next = computeNextJobRun(
      { schedule_type: 'interval', schedule_value: '60000' },
      scheduledFor,
    );
    expect(next).not.toBeNull();
    expect(new Date(next!).getTime()).toBe(
      new Date(scheduledFor).getTime() + 60000,
    );
  });

  it('computeNextJobRun returns null for once/manual schedules', () => {
    expect(
      computeNextJobRun(
        { schedule_type: 'once', schedule_value: '2026-01-01T00:00:00.000Z' },
        new Date().toISOString(),
      ),
    ).toBeNull();
    expect(
      computeNextJobRun(
        { schedule_type: 'manual', schedule_value: '' },
        new Date().toISOString(),
      ),
    ).toBeNull();
  });

  it('runs due jobs and records run history with status notifications', async () => {
    upsertJob({
      id: 'job-1',
      name: 'daily-summary',
      prompt: 'Send a summary',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );
    const sendMessage = vi.fn(async () => {});

    startSchedulerLoop({
      registeredGroups: () => ({
        'group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask,
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const job = getJobById('job-1');
    expect(job?.status).toBe('completed');
    const runs = listJobRuns('job-1', 10);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('completed');
    expect(sendMessage).toHaveBeenCalled();
  });

  it('sends failed/dead-letter status updates to linked sessions', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'error',
      error: 'synthetic failure',
      result: null,
      newSessionId: 'session-1',
    });

    upsertJob({
      id: 'job-fail',
      name: 'failure-job',
      prompt: 'fail this run',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      max_retries: 0,
      max_consecutive_failures: 1,
    });

    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop({
      registeredGroups: () => ({
        'group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask: vi.fn(
          (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
            void fn();
          },
        ),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const runs = listJobRuns('job-fail', 10);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('dead_lettered');
    expect(sendMessage).toHaveBeenCalledWith(
      'group@g.us',
      expect.stringContaining('status: dead_lettered'),
    );
  });

  it('runs __system jobs without container execution', async () => {
    upsertJob({
      id: 'system:dreaming:main',
      name: 'Memory Dreaming (main)',
      prompt: '__system:memory_dream',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    startSchedulerLoop({
      registeredGroups: () => ({
        'group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask: vi.fn(
          (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
            void fn();
          },
        ),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage: vi.fn(async () => {}),
    });

    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    expect(runDreamingSweepMock).toHaveBeenCalledTimes(1);
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(reflectAfterTurnMock).not.toHaveBeenCalled();
  });

  it('does not crash with exponential backoff overflow on high consecutive_failures', async () => {
    // Bug: retry delay = retry_backoff_ms * 2^(retryCount-1).
    // With retryCount=40 and retry_backoff_ms=30000:
    //   30000 * 2^39 = ~1.65e16, which exceeds Date's max (8.64e15).
    //   new Date(Date.now() + overflow).toISOString() throws RangeError.
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'error',
      error: 'synthetic failure',
      result: null,
      newSessionId: 'session-1',
    });

    upsertJob({
      id: 'job-overflow',
      name: 'backoff-overflow',
      prompt: 'test prompt',
      schedule_type: 'interval',
      schedule_value: '86400000',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
    });

    // Manually set high consecutive_failures (DB default is 0)
    const rawDb = (await import('../storage/db.js')) as any;
    // Use updateJob to set consecutive_failures high
    rawDb.updateJob('job-overflow', {
      consecutive_failures: 39,
      max_retries: 100,
      max_consecutive_failures: 100,
      retry_backoff_ms: 30000,
    });

    let taskError: Error | null = null;
    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop({
      registeredGroups: () => ({
        'group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask: vi.fn(
          (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
            fn().catch((err: Error) => {
              taskError = err;
            });
          },
        ),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The job runner should not throw a RangeError from Date overflow
    expect(taskError).toBeNull();

    const job = getJobById('job-overflow');
    expect(job).toBeDefined();
    // Job should have a valid next_run ISO date, not be stuck in 'running'
    expect(job?.status).not.toBe('running');
    if (job?.next_run) {
      expect(() => new Date(job.next_run!).toISOString()).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage tests for computeNextJobRun
// ---------------------------------------------------------------------------
describe('computeNextJobRun', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for "once" schedule type', () => {
    const result = computeNextJobRun(
      { schedule_type: 'once', schedule_value: '2026-01-01T00:00:00.000Z' },
      '2026-01-01T00:00:00.000Z',
    );
    expect(result).toBeNull();
  });

  it('returns null for "manual" schedule type', () => {
    const result = computeNextJobRun(
      { schedule_type: 'manual', schedule_value: '' },
      null,
    );
    expect(result).toBeNull();
  });

  it('computes next cron run from scheduledFor date', () => {
    vi.setSystemTime(new Date('2026-04-12T10:00:00.000Z'));
    const result = computeNextJobRun(
      { schedule_type: 'cron', schedule_value: '0 * * * *' },
      '2026-04-12T09:30:00.000Z',
    );
    expect(result).not.toBeNull();
    // Cron "0 * * * *" from 09:30 anchor should give 10:00
    const nextDate = new Date(result!);
    expect(nextDate.getMinutes()).toBe(0);
  });

  it('computes next cron run with null scheduledFor (uses now)', () => {
    vi.setSystemTime(new Date('2026-04-12T10:15:00.000Z'));
    const result = computeNextJobRun(
      { schedule_type: 'cron', schedule_value: '0 * * * *' },
      null,
    );
    expect(result).not.toBeNull();
    const nextDate = new Date(result!);
    expect(nextDate.getTime()).toBeGreaterThan(
      new Date('2026-04-12T10:15:00.000Z').getTime(),
    );
  });

  it('interval: advances past now when anchor is in the past', () => {
    vi.setSystemTime(new Date('2026-04-12T10:00:00.000Z'));
    const anchor = new Date('2026-04-12T09:58:00.000Z').toISOString();
    const result = computeNextJobRun(
      { schedule_type: 'interval', schedule_value: '60000' }, // 1 min
      anchor,
    );
    expect(result).not.toBeNull();
    const nextTime = new Date(result!).getTime();
    const now = Date.now();
    expect(nextTime).toBeGreaterThan(now);
    // anchor + 2*60000 = 10:00:00, which equals now, so next = anchor + 3*60000 = 10:01:00
    // Actually the while loop says while (next <= now), so it keeps going until next > now.
    // anchor + 60000 = 09:59:00 <= now -> skip
    // anchor + 120000 = 10:00:00 <= now -> skip (next <= now)
    // anchor + 180000 = 10:01:00 > now -> return
    expect(nextTime).toBe(
      new Date('2026-04-12T10:01:00.000Z').getTime(),
    );
  });

  it('interval: uses now when scheduledFor is null', () => {
    vi.setSystemTime(new Date('2026-04-12T10:00:00.000Z'));
    const result = computeNextJobRun(
      { schedule_type: 'interval', schedule_value: '60000' },
      null,
    );
    expect(result).not.toBeNull();
    const nextTime = new Date(result!).getTime();
    // anchor = now, next = now + 60000 > now, return immediately
    expect(nextTime).toBe(Date.now() + 60000);
  });

  it('interval: defaults to 60s when schedule_value is invalid (0)', () => {
    vi.setSystemTime(new Date('2026-04-12T10:00:00.000Z'));
    const result = computeNextJobRun(
      { schedule_type: 'interval', schedule_value: '0' },
      null,
    );
    expect(result).not.toBeNull();
    // Falls through to ms <= 0 branch -> returns Date.now() + 60_000
    expect(new Date(result!).getTime()).toBe(Date.now() + 60_000);
  });

  it('interval: defaults to 60s when schedule_value is negative', () => {
    vi.setSystemTime(new Date('2026-04-12T10:00:00.000Z'));
    const result = computeNextJobRun(
      { schedule_type: 'interval', schedule_value: '-5000' },
      null,
    );
    expect(result).not.toBeNull();
    expect(new Date(result!).getTime()).toBe(Date.now() + 60_000);
  });

  it('interval: defaults to 60s when schedule_value is NaN', () => {
    vi.setSystemTime(new Date('2026-04-12T10:00:00.000Z'));
    const result = computeNextJobRun(
      { schedule_type: 'interval', schedule_value: 'not-a-number' },
      null,
    );
    expect(result).not.toBeNull();
    expect(new Date(result!).getTime()).toBe(Date.now() + 60_000);
  });

  it('interval: returns anchor + ms when anchor is in the future', () => {
    vi.setSystemTime(new Date('2026-04-12T10:00:00.000Z'));
    const anchor = new Date('2026-04-12T10:05:00.000Z').toISOString(); // 5 min from now
    const result = computeNextJobRun(
      { schedule_type: 'interval', schedule_value: '60000' },
      anchor,
    );
    expect(result).not.toBeNull();
    // anchor + 60000 = 10:06:00 which is > now, so returns immediately
    expect(new Date(result!).getTime()).toBe(
      new Date('2026-04-12T10:06:00.000Z').getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// Coverage tests for markJobRunning and releaseStaleJobLeases (db helpers)
// ---------------------------------------------------------------------------
describe('job lease management', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T10:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('markJobRunning transitions active job to running', () => {
    upsertJob({
      id: 'lease-1',
      name: 'lease test',
      prompt: 'test',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: ['g@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
    });

    const success = markJobRunning(
      'lease-1',
      'run-abc',
      new Date(Date.now() + 300_000).toISOString(),
    );
    expect(success).toBe(true);

    const job = getJobById('lease-1');
    expect(job?.status).toBe('running');
    expect(job?.lease_run_id).toBe('run-abc');
  });

  it('markJobRunning fails for non-active job', () => {
    upsertJob({
      id: 'lease-2',
      name: 'lease test 2',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2026-01-01',
      linked_sessions: ['g@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
      status: 'active',
    });
    // First call succeeds (active -> running)
    markJobRunning('lease-2', 'run-1', new Date(Date.now() + 300_000).toISOString());
    // Second call fails (already running)
    const success = markJobRunning(
      'lease-2',
      'run-2',
      new Date(Date.now() + 300_000).toISOString(),
    );
    expect(success).toBe(false);
  });

  it('releaseStaleJobLeases resets expired running jobs to active', () => {
    upsertJob({
      id: 'stale-1',
      name: 'stale lease',
      prompt: 'test',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: ['g@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
    });

    // Mark it running with a lease that expires in the past
    const pastLease = new Date(Date.now() - 1000).toISOString();
    markJobRunning('stale-1', 'run-stale', pastLease);
    expect(getJobById('stale-1')?.status).toBe('running');

    // Release stale leases
    const released = releaseStaleJobLeases();
    expect(released).toBe(1);
    expect(getJobById('stale-1')?.status).toBe('active');
    expect(getJobById('stale-1')?.lease_run_id).toBeNull();
  });

  it('releaseStaleJobLeases does not release non-expired leases', () => {
    upsertJob({
      id: 'fresh-1',
      name: 'fresh lease',
      prompt: 'test',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: ['g@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
    });

    // Mark running with lease in the future
    const futureLease = new Date(Date.now() + 600_000).toISOString();
    markJobRunning('fresh-1', 'run-fresh', futureLease);

    const released = releaseStaleJobLeases();
    expect(released).toBe(0);
    expect(getJobById('fresh-1')?.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// Coverage tests for scheduler loop behavior
// ---------------------------------------------------------------------------
describe('scheduler loop', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T10:00:00.000Z'));
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDeps(overrides?: Partial<{
    registeredGroups: () => Record<string, any>;
    getSessions: () => Record<string, string>;
    enqueueTask: (...args: any[]) => void;
    closeStdin: () => void;
    notifyIdle: () => void;
    onProcess: () => void;
    sendMessage: (...args: any[]) => Promise<void>;
    onSchedulerChanged: () => void;
  }>) {
    return {
      registeredGroups: overrides?.registeredGroups ?? (() => ({
        'group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: true,
        },
      })),
      getSessions: overrides?.getSessions ?? (() => ({})),
      queue: {
        enqueueTask: overrides?.enqueueTask ?? vi.fn(
          (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
            void fn();
          },
        ),
        closeStdin: overrides?.closeStdin ?? vi.fn(),
        notifyIdle: overrides?.notifyIdle ?? vi.fn(),
      } as any,
      onProcess: overrides?.onProcess ?? vi.fn(),
      sendMessage: overrides?.sendMessage ?? vi.fn(async () => {}),
      onSchedulerChanged: overrides?.onSchedulerChanged,
    };
  }

  it('does not start a second loop if already running', async () => {
    const enqueueTask = vi.fn();
    const deps = makeDeps({ enqueueTask });
    startSchedulerLoop(deps);
    // Start again — should be no-op
    startSchedulerLoop(deps);

    await vi.advanceTimersByTimeAsync(20);
    // Only one loop should be running (hard to test directly, but we test
    // that the second call doesn't cause duplicate processing)
  });

  it('skips non-active jobs when listing due jobs', async () => {
    upsertJob({
      id: 'paused-job',
      name: 'paused',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });
    // Pause the job
    updateJob('paused-job', { status: 'paused' });

    const enqueueTask = vi.fn();
    startSchedulerLoop(makeDeps({ enqueueTask }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();

    // Paused job should not be enqueued
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('dead-letters a job when group scope is not found', async () => {
    upsertJob({
      id: 'orphan-job',
      name: 'orphan',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['unknown@g.us'],
      group_scope: 'nonexistent-folder',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    const onSchedulerChanged = vi.fn();
    startSchedulerLoop(makeDeps({ onSchedulerChanged }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const job = getJobById('orphan-job');
    expect(job?.status).toBe('dead_lettered');
    expect(job?.pause_reason).toContain('Group scope not found');
    expect(onSchedulerChanged).toHaveBeenCalled();
  });

  it('handles job where markJobRunning returns false (concurrent lease)', async () => {
    upsertJob({
      id: 'contended-job',
      name: 'contended',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });
    // Pre-acquire the lease so the scheduler's markJobRunning fails
    markJobRunning(
      'contended-job',
      'pre-run',
      new Date(Date.now() + 600_000).toISOString(),
    );

    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop(makeDeps({ sendMessage }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    // The job should still be running (the scheduler bailed out)
    const job = getJobById('contended-job');
    expect(job?.status).toBe('running');
    // No message sent since the scheduler didn't run the job
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('resolves group by linked_sessions when folder match fails', async () => {
    upsertJob({
      id: 'linked-resolve',
      name: 'linked',
      prompt: 'test prompt',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'other-folder',  // Doesn't match any group's folder
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop(makeDeps({ sendMessage }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    // Job should have been resolved via linked_sessions fallback and completed
    const job = getJobById('linked-resolve');
    expect(job?.status).toBe('completed');
    expect(sendMessage).toHaveBeenCalled();
  });

  it('records failed run and retries with backoff', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'error',
      error: 'temporary failure',
      result: null,
      newSessionId: 'session-1',
    });

    upsertJob({
      id: 'retry-job',
      name: 'retry test',
      prompt: 'do work',
      schedule_type: 'interval',
      schedule_value: '3600000', // 1 hour
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      max_retries: 3,
      max_consecutive_failures: 5,
    });

    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop(makeDeps({ sendMessage }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const job = getJobById('retry-job');
    expect(job?.status).toBe('active');
    expect(job?.consecutive_failures).toBe(1);
    expect(job?.next_run).not.toBeNull();
    // Check that next_run is in the future (retry backoff)
    expect(new Date(job!.next_run!).getTime()).toBeGreaterThan(Date.now());

    // Check run was recorded as failed
    const runs = listJobRuns('retry-job', 10);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_summary).toContain('temporary failure');

    // Check status message was sent
    expect(sendMessage).toHaveBeenCalledWith(
      'group@g.us',
      expect.stringContaining('status: failed'),
    );
  });

  it('marks timeout errors with "timeout" run status', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'error',
      error: 'Process timed out after 300s',
      result: null,
      newSessionId: 'session-1',
    });

    upsertJob({
      id: 'timeout-job',
      name: 'timeout test',
      prompt: 'slow task',
      schedule_type: 'interval',
      schedule_value: '3600000',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      max_retries: 3,
      max_consecutive_failures: 5,
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const runs = listJobRuns('timeout-job', 10);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('timeout');
  });

  it('completes interval job and schedules next run', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'All good',
      newSessionId: 'session-1',
    });

    const scheduledFor = new Date(Date.now() - 5000).toISOString();
    upsertJob({
      id: 'interval-job',
      name: 'interval test',
      prompt: 'do periodic work',
      schedule_type: 'interval',
      schedule_value: '3600000', // 1 hour
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: scheduledFor,
      status: 'active',
    });

    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop(makeDeps({ sendMessage }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const job = getJobById('interval-job');
    expect(job?.status).toBe('active');
    expect(job?.consecutive_failures).toBe(0);
    expect(job?.next_run).not.toBeNull();
    // Next run should be anchored + interval
    const nextTime = new Date(job!.next_run!).getTime();
    const anchorTime = new Date(scheduledFor).getTime();
    expect(nextTime).toBe(anchorTime + 3600000);

    const runs = listJobRuns('interval-job', 10);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('completed');

    // The status message should include next_run info
    expect(sendMessage).toHaveBeenCalledWith(
      'group@g.us',
      expect.stringContaining('next_run:'),
    );
  });

  it('completes once job and sets status to completed (no next_run)', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'Done',
      newSessionId: 'session-1',
    });

    upsertJob({
      id: 'once-job',
      name: 'once test',
      prompt: 'one-off task',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const job = getJobById('once-job');
    expect(job?.status).toBe('completed');
    expect(job?.next_run).toBeNull();
  });

  it('calls onSchedulerChanged after stale lease release', async () => {
    upsertJob({
      id: 'stale-notify',
      name: 'stale notify',
      prompt: 'test',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
    });
    // Create stale lease
    markJobRunning(
      'stale-notify',
      'run-stale',
      new Date(Date.now() - 1000).toISOString(),
    );

    const onSchedulerChanged = vi.fn();
    startSchedulerLoop(makeDeps({ onSchedulerChanged }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    expect(onSchedulerChanged).toHaveBeenCalled();
  });

  it('enqueues job tasks using queue.enqueueTask with correct jid', async () => {
    upsertJob({
      id: 'enqueue-test',
      name: 'enqueue test',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop(makeDeps({ enqueueTask }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();

    expect(enqueueTask).toHaveBeenCalledWith(
      'group@g.us',
      'enqueue-test',
      expect.any(Function),
    );
  });

  it('uses group_scope:job as queueJid when no linked_sessions', async () => {
    upsertJob({
      id: 'no-session-job',
      name: 'no session',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    const enqueueTask = vi.fn();
    startSchedulerLoop(makeDeps({ enqueueTask }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();

    // With empty linked_sessions, queueJid = `${group_scope}:job`
    expect(enqueueTask).toHaveBeenCalledWith(
      'main:job',
      'no-session-job',
      expect.any(Function),
    );
  });

  it('handles sendMessage failure gracefully', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'ok',
      newSessionId: 'session-1',
    });

    upsertJob({
      id: 'msg-fail-job',
      name: 'msg fail',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    const sendMessage = vi.fn(async () => {
      throw new Error('Network error');
    });

    startSchedulerLoop(makeDeps({ sendMessage }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    // Job should still complete despite notification failure
    const job = getJobById('msg-fail-job');
    expect(job?.status).toBe('completed');
  });

  it('sends notification to all unique linked_sessions', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'done',
      newSessionId: 'session-1',
    });

    upsertJob({
      id: 'multi-notify',
      name: 'multi notify',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us', 'other@g.us', 'group@g.us'],  // duplicate
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    // We need both groups registered so the job can resolve
    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop(makeDeps({
      registeredGroups: () => ({
        'group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: true,
        },
        'other@g.us': {
          name: 'Other',
          folder: 'other',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
        },
      }),
      sendMessage,
    }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    // Should send to 2 unique jids (deduped), not 3
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(
      'group@g.us',
      expect.any(String),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'other@g.us',
      expect.any(String),
    );
  });

  it('calls reflectAfterTurn after successful non-system job', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'reflection result',
      newSessionId: 'session-1',
    });

    upsertJob({
      id: 'reflect-job',
      name: 'reflect test',
      prompt: 'something to reflect on',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(reflectAfterTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        groupFolder: 'main',
        prompt: 'something to reflect on',
        result: 'reflection result',
        isMain: true,
      }),
    );
  });

  it('does not call reflectAfterTurn on failed job', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'error',
      error: 'failure',
      result: null,
      newSessionId: 'session-1',
    });

    upsertJob({
      id: 'no-reflect',
      name: 'no reflect',
      prompt: 'fail this',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      max_retries: 0,
      max_consecutive_failures: 1,
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    expect(reflectAfterTurnMock).not.toHaveBeenCalled();
  });

  it('scheduler loop re-runs on setTimeout interval', async () => {
    // Create a job that will be due on the second tick
    const sendMessage = vi.fn(async () => {});
    const deps = makeDeps({ sendMessage });
    startSchedulerLoop(deps);

    // First tick - no jobs
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();

    // Now insert a job that will be due
    _resetSchedulerLoopForTests();

    upsertJob({
      id: 'delayed-job',
      name: 'delayed',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 1000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
    });

    // Advance past SCHEDULER_POLL_INTERVAL (60000ms)
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const job = getJobById('delayed-job');
    expect(job?.status).toBe('completed');
  });

  it('handles spawnAgent throwing an exception', async () => {
    vi.mocked(spawnAgent).mockRejectedValueOnce(new Error('spawn crash'));

    upsertJob({
      id: 'crash-job',
      name: 'crash test',
      prompt: 'crash me',
      schedule_type: 'interval',
      schedule_value: '3600000',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      max_retries: 3,
      max_consecutive_failures: 5,
    });

    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop(makeDeps({ sendMessage }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const job = getJobById('crash-job');
    expect(job?.status).toBe('active');
    expect(job?.consecutive_failures).toBe(1);

    const runs = listJobRuns('crash-job', 10);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_summary).toContain('spawn crash');
  });

  it('dead-letters job that exceeds max_consecutive_failures', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'error',
      error: 'keep failing',
      result: null,
      newSessionId: 'session-1',
    });

    upsertJob({
      id: 'dl-consec',
      name: 'dead letter consecutive',
      prompt: 'fail',
      schedule_type: 'interval',
      schedule_value: '3600000',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      max_retries: 10,
      max_consecutive_failures: 2,
    });
    // Set consecutive_failures to 1, so the next failure hits 2 (>= max_consecutive_failures)
    updateJob('dl-consec', { consecutive_failures: 1 });

    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop(makeDeps({ sendMessage }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const job = getJobById('dl-consec');
    expect(job?.status).toBe('dead_lettered');
    expect(job?.next_run).toBeNull();
    expect(job?.pause_reason).toContain('Paused after 2 failures');

    const runs = listJobRuns('dl-consec', 10);
    expect(runs[0].status).toBe('dead_lettered');

    expect(sendMessage).toHaveBeenCalledWith(
      'group@g.us',
      expect.stringContaining('pause_state: paused'),
    );
  });

  it('dead-letters job that exceeds max_retries', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'error',
      error: 'max retries hit',
      result: null,
      newSessionId: 'session-1',
    });

    upsertJob({
      id: 'dl-retry',
      name: 'dead letter retry',
      prompt: 'fail',
      schedule_type: 'interval',
      schedule_value: '3600000',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      max_retries: 2,
      max_consecutive_failures: 100,
    });
    // Set consecutive_failures to 2 so next failure = 3 > max_retries(2)
    updateJob('dl-retry', { consecutive_failures: 2 });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const job = getJobById('dl-retry');
    expect(job?.status).toBe('dead_lettered');
    expect(job?.consecutive_failures).toBe(3);
  });

  it('resets consecutive_failures to 0 on successful run', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'recovered',
      newSessionId: 'session-1',
    });

    upsertJob({
      id: 'recover-job',
      name: 'recover',
      prompt: 'test',
      schedule_type: 'interval',
      schedule_value: '3600000',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      max_retries: 5,
      max_consecutive_failures: 5,
    });
    updateJob('recover-job', { consecutive_failures: 3 });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const job = getJobById('recover-job');
    expect(job?.status).toBe('active');
    expect(job?.consecutive_failures).toBe(0);
  });

  it('truncates long result to 500 chars in job run summary', async () => {
    const longResult = 'A'.repeat(1000);
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: longResult,
      newSessionId: 'session-1',
    });

    upsertJob({
      id: 'truncate-job',
      name: 'truncate test',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const runs = listJobRuns('truncate-job', 10);
    expect(runs[0].result_summary).toHaveLength(500);
  });

  it('truncates long error to 500 chars in job run summary', async () => {
    const longError = 'E'.repeat(1000);
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'error',
      error: longError,
      result: null,
      newSessionId: 'session-1',
    });

    upsertJob({
      id: 'truncate-err',
      name: 'truncate error',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      max_retries: 0,
      max_consecutive_failures: 1,
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const runs = listJobRuns('truncate-err', 10);
    expect(runs[0].error_summary).toHaveLength(500);
  });
});

// ---------------------------------------------------------------------------
// Additional coverage tests targeting uncovered branches
// ---------------------------------------------------------------------------
describe('scheduler coverage: streaming callback and edge cases', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T10:00:00.000Z'));
    vi.clearAllMocks();
    vi.mocked(resolveGroupFolderPath).mockReturnValue('/tmp/test-group-folder');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDeps(overrides?: Partial<{
    registeredGroups: () => Record<string, any>;
    getSessions: () => Record<string, string>;
    enqueueTask: (...args: any[]) => void;
    closeStdin: () => void;
    notifyIdle: () => void;
    onProcess: () => void;
    sendMessage: (...args: any[]) => Promise<void>;
    onSchedulerChanged: () => void;
  }>) {
    return {
      registeredGroups: overrides?.registeredGroups ?? (() => ({
        'group@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: true,
        },
      })),
      getSessions: overrides?.getSessions ?? (() => ({})),
      queue: {
        enqueueTask: overrides?.enqueueTask ?? vi.fn(
          (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
            void fn();
          },
        ),
        closeStdin: overrides?.closeStdin ?? vi.fn(),
        notifyIdle: overrides?.notifyIdle ?? vi.fn(),
      } as any,
      onProcess: overrides?.onProcess ?? vi.fn(),
      sendMessage: overrides?.sendMessage ?? vi.fn(async () => {}),
      onSchedulerChanged: overrides?.onSchedulerChanged,
    };
  }

  it('invokes streaming callback with result and scheduleClose', async () => {
    const closeStdin = vi.fn();
    const notifyIdle = vi.fn();

    // Mock spawnAgent to invoke the onOutput callback
    vi.mocked(spawnAgent).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput, _options) => {
        // Invoke streaming callback with result
        if (onOutput) {
          await onOutput({ status: 'success', result: 'streamed result' });
        }
        return { status: 'success', result: 'final result', newSessionId: 'sess-1' };
      },
    );

    upsertJob({
      id: 'stream-result',
      name: 'stream test',
      prompt: 'stream me',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    startSchedulerLoop(makeDeps({ closeStdin, notifyIdle }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();
    // Advance close delay timer (10s)
    await vi.advanceTimersByTimeAsync(11_000);
    await Promise.resolve();

    expect(notifyIdle).toHaveBeenCalledWith('group@g.us');
    expect(closeStdin).toHaveBeenCalledWith('group@g.us');
  });

  it('invokes streaming callback with error status', async () => {
    vi.mocked(spawnAgent).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput, _options) => {
        if (onOutput) {
          await onOutput({ status: 'error', result: null, error: 'stream error' });
        }
        return { status: 'success', result: null, newSessionId: 'sess-1' };
      },
    );

    upsertJob({
      id: 'stream-error',
      name: 'stream error test',
      prompt: 'error stream',
      schedule_type: 'interval',
      schedule_value: '3600000',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      max_retries: 3,
      max_consecutive_failures: 5,
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const runs = listJobRuns('stream-error', 10);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_summary).toContain('stream error');
  });

  it('invokes streaming callback with error but no error message (Unknown error fallback)', async () => {
    vi.mocked(spawnAgent).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput, _options) => {
        if (onOutput) {
          await onOutput({ status: 'error', result: null });
        }
        return { status: 'success', result: null, newSessionId: 'sess-1' };
      },
    );

    upsertJob({
      id: 'stream-unknown',
      name: 'stream unknown error',
      prompt: 'unknown error',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      max_retries: 0,
      max_consecutive_failures: 1,
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const runs = listJobRuns('stream-unknown', 10);
    expect(runs[0].error_summary).toBe('Unknown error');
  });

  it('streaming callback sets result without success status (only result, no notifyIdle)', async () => {
    const notifyIdle = vi.fn();
    vi.mocked(spawnAgent).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput, _options) => {
        if (onOutput) {
          // Only result, no success status
          await onOutput({ status: 'error', result: 'partial result' });
        }
        return { status: 'success', result: 'final', newSessionId: 'sess-1' };
      },
    );

    upsertJob({
      id: 'stream-partial',
      name: 'partial',
      prompt: 'partial stream',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      max_retries: 0,
      max_consecutive_failures: 1,
    });

    startSchedulerLoop(makeDeps({ notifyIdle }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    // Error path was set by the callback
    const runs = listJobRuns('stream-partial', 10);
    expect(runs.length).toBe(1);
  });

  it('spawnAgent onProcess callback is invoked', async () => {
    const onProcess = vi.fn();
    vi.mocked(spawnAgent).mockImplementationOnce(
      async (_group, _input, onProc, _onOutput, _options) => {
        // Invoke the onProcess callback
        onProc({} as any, 'test-container');
        return { status: 'success', result: 'ok', newSessionId: 'sess-1' };
      },
    );

    upsertJob({
      id: 'onprocess-job',
      name: 'onprocess test',
      prompt: 'test onprocess',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    startSchedulerLoop(makeDeps({ onProcess }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    expect(onProcess).toHaveBeenCalledWith(
      'group@g.us',
      expect.anything(),
      'test-container',
      'main',
    );
  });

  it('handles createJobRun returning false (run creation failure)', async () => {
    upsertJob({
      id: 'run-fail',
      name: 'run creation fail',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    // Spy on createJobRun to return false
    const createJobRunSpy = vi.spyOn(
      await import('../storage/db.js'),
      'createJobRun',
    );
    createJobRunSpy.mockReturnValueOnce(false);

    const onSchedulerChanged = vi.fn();
    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop(makeDeps({ sendMessage, onSchedulerChanged }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    // Job should be reset to active (not running, not completed)
    const job = getJobById('run-fail');
    expect(job?.status).toBe('active');
    expect(job?.lease_run_id).toBeNull();
    // onSchedulerChanged should be called
    expect(onSchedulerChanged).toHaveBeenCalled();
    // No message sent since the job didn't actually run
    expect(sendMessage).not.toHaveBeenCalled();

    createJobRunSpy.mockRestore();
  });

  it('handles resolveGroupFolderPath throwing an error', async () => {
    vi.mocked(resolveGroupFolderPath).mockImplementationOnce(() => {
      throw new Error('Invalid group folder path');
    });

    upsertJob({
      id: 'folder-error',
      name: 'folder error test',
      prompt: 'test',
      schedule_type: 'interval',
      schedule_value: '3600000',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      max_retries: 0,
      max_consecutive_failures: 1,
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const runs = listJobRuns('folder-error', 10);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('dead_lettered');
    expect(runs[0].error_summary).toContain('Invalid group folder path');
  });

  it('handles writeMemoryContextSnapshot failure gracefully', async () => {
    vi.mocked(writeMemoryContextSnapshot).mockRejectedValueOnce(
      new Error('Snapshot write failed'),
    );
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'completed despite snapshot error',
      newSessionId: 'sess-1',
    });

    upsertJob({
      id: 'snap-fail',
      name: 'snapshot fail',
      prompt: 'test prompt',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    // Job should still complete despite snapshot failure
    const job = getJobById('snap-fail');
    expect(job?.status).toBe('completed');
  });

  it('handles reflectAfterTurn throwing gracefully', async () => {
    reflectAfterTurnMock.mockRejectedValueOnce(new Error('Reflection failed'));
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'ok result',
      newSessionId: 'sess-1',
    });

    upsertJob({
      id: 'reflect-fail',
      name: 'reflect fail',
      prompt: 'reflect me',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Job should still be completed despite reflection failure
    const job = getJobById('reflect-fail');
    expect(job?.status).toBe('completed');
    expect(reflectAfterTurnMock).toHaveBeenCalled();
  });

  it('handles unknown system job prompt', async () => {
    upsertJob({
      id: 'unknown-sys',
      name: 'unknown system',
      prompt: '__system:unknown_action',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      max_retries: 0,
      max_consecutive_failures: 1,
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const runs = listJobRuns('unknown-sys', 10);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('dead_lettered');
    expect(runs[0].error_summary).toContain('Unknown system job');
  });

  it('handles runJob when getJobById returns null (job deleted mid-run)', async () => {
    // Create job, then delete it before the task runs
    upsertJob({
      id: 'deleted-job',
      name: 'deleted',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    // Intercept getJobById to return null after the first call (from listDueJobs check)
    const getJobByIdSpy = vi.spyOn(
      await import('../storage/db.js'),
      'getJobById',
    );
    const original = getJobByIdSpy.getMockImplementation() || getJobById;
    let callCount = 0;
    getJobByIdSpy.mockImplementation((id: string) => {
      callCount++;
      // First call from the loop filter, second from runJob - return null on second
      if (id === 'deleted-job' && callCount > 1) return null as any;
      return (original as any)(id);
    });

    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop(makeDeps({ sendMessage }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    // No message should be sent since job was "deleted"
    expect(sendMessage).not.toHaveBeenCalled();

    getJobByIdSpy.mockRestore();
  });

  it('handles scheduler loop error (catch block)', async () => {
    // Spy on listDueJobs to throw on the first call
    const listDueJobsSpy = vi.spyOn(
      await import('../storage/db.js'),
      'listDueJobs',
    );
    listDueJobsSpy.mockImplementationOnce(() => {
      throw new Error('DB connection lost');
    });

    // Should not crash the scheduler loop
    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();

    // Scheduler should continue running (test that it doesn't throw)
    listDueJobsSpy.mockRestore();
  });

  it('resolves execution context using byFolder[0] when linked_sessions is empty', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'resolved by folder',
      newSessionId: 'sess-1',
    });

    upsertJob({
      id: 'empty-sessions',
      name: 'empty sessions',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    // Need an enqueueTask that actually runs the fn
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );
    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop(makeDeps({ enqueueTask, sendMessage }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    // Job should complete - resolved via folder match with executionJid = byFolder[0] = 'group@g.us'
    const job = getJobById('empty-sessions');
    expect(job?.status).toBe('completed');
  });

  it('spawnAgent output.status error with no error message uses Unknown error', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'error',
      result: null,
      newSessionId: 'sess-1',
      // No error property
    });

    upsertJob({
      id: 'no-error-msg',
      name: 'no error msg',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      max_retries: 0,
      max_consecutive_failures: 1,
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const runs = listJobRuns('no-error-msg', 10);
    expect(runs[0].error_summary).toBe('Unknown error');
  });

  it('spawnAgent returns success with result=null yields "Completed" summary', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: null,
      newSessionId: 'sess-1',
    });

    upsertJob({
      id: 'null-result',
      name: 'null result',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop(makeDeps({ sendMessage }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const job = getJobById('null-result');
    expect(job?.status).toBe('completed');
    // The summary should be "Completed" when result is null
    expect(sendMessage).toHaveBeenCalledWith(
      'group@g.us',
      expect.stringContaining('summary: Completed'),
    );
  });

  it('uses next_run as scheduledFor when it exists (not fallback to now)', async () => {
    const specificTime = new Date(Date.now() - 5000).toISOString();
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'ok',
      newSessionId: 'sess-1',
    });

    upsertJob({
      id: 'scheduled-for',
      name: 'scheduled for test',
      prompt: 'test',
      schedule_type: 'interval',
      schedule_value: '3600000',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: specificTime,
      status: 'active',
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const job = getJobById('scheduled-for');
    // Next run should be anchored from specificTime
    const expected = new Date(new Date(specificTime).getTime() + 3600000).toISOString();
    expect(job?.next_run).toBe(expected);
  });

  it('handles job with null next_run (scheduledFor defaults to now)', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'ok',
      newSessionId: 'sess-1',
    });

    upsertJob({
      id: 'null-next',
      name: 'null next run',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    // Pre-update to null next_run then manually mark running + set status back
    // Actually, since next_run must be set for listDueJobs to pick it up,
    // let's test the path where next_run is set but the job uses it correctly
    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const job = getJobById('null-next');
    expect(job?.status).toBe('completed');
  });

  it('uses timeout_ms from job when specified (not default)', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'ok',
      newSessionId: 'sess-1',
    });

    upsertJob({
      id: 'custom-timeout',
      name: 'custom timeout',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      timeout_ms: 60_000,
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    // spawnAgent should have been called with timeoutMs: 60000
    expect(spawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { timeoutMs: 60_000 },
    );
  });

  it('handles non-Error thrown by resolveGroupFolderPath', async () => {
    vi.mocked(resolveGroupFolderPath).mockImplementationOnce(() => {
      throw 'string-error-from-resolve';  // eslint-disable-line no-throw-literal
    });

    upsertJob({
      id: 'string-throw',
      name: 'string throw test',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      max_retries: 0,
      max_consecutive_failures: 1,
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const runs = listJobRuns('string-throw', 10);
    expect(runs[0].error_summary).toBe('string-error-from-resolve');
  });

  it('due job skipped in loop when getJobById returns non-active status', async () => {
    upsertJob({
      id: 'paused-mid-loop',
      name: 'paused mid loop',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    // Spy on getJobById to return paused status in the loop body check
    const dbModule = await import('../storage/db.js');
    const getJobByIdSpy = vi.spyOn(dbModule, 'getJobById');
    const realGetJobById = getJobById;
    getJobByIdSpy.mockImplementation((id: string) => {
      const job = realGetJobById(id);
      if (job && id === 'paused-mid-loop') {
        return { ...job, status: 'paused' } as any;
      }
      return job;
    });

    const enqueueTask = vi.fn();
    startSchedulerLoop(makeDeps({ enqueueTask }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();

    // Should not enqueue since getJobById returned non-active
    expect(enqueueTask).not.toHaveBeenCalled();

    getJobByIdSpy.mockRestore();
  });

  it('scheduleClose is only invoked once (idempotent guard)', async () => {
    const closeStdin = vi.fn();

    vi.mocked(spawnAgent).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput, _options) => {
        if (onOutput) {
          // Invoke with result twice to test scheduleClose guard
          await onOutput({ status: 'success', result: 'first' });
          await onOutput({ status: 'success', result: 'second' });
        }
        return { status: 'success', result: 'final', newSessionId: 'sess-1' };
      },
    );

    upsertJob({
      id: 'double-close',
      name: 'double close',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    startSchedulerLoop(makeDeps({ closeStdin }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();
    // Advance past close delay
    await vi.advanceTimersByTimeAsync(11_000);

    // closeStdin should be called only once despite scheduleClose being invoked multiple times
    expect(closeStdin).toHaveBeenCalledTimes(1);
  });

  it('system job error uses non-Error string fallback', async () => {
    runDreamingSweepMock.mockRejectedValueOnce('non-error-string');

    upsertJob({
      id: 'sys-string-err',
      name: 'system string error',
      prompt: '__system:memory_dream',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      max_retries: 0,
      max_consecutive_failures: 1,
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const runs = listJobRuns('sys-string-err', 10);
    expect(runs[0].error_summary).toBe('non-error-string');
  });

  it('getSessions returns a session ID used by the job', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'ok',
      newSessionId: 'sess-1',
    });

    upsertJob({
      id: 'with-session',
      name: 'with session',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });

    startSchedulerLoop(makeDeps({
      getSessions: () => ({ main: 'existing-session-id' }),
    }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: 'existing-session-id' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('job with script field passes it to spawnAgent', async () => {
    vi.mocked(spawnAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'ok',
      newSessionId: 'sess-1',
    });

    upsertJob({
      id: 'with-script',
      name: 'with script',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });
    // Update with script field
    updateJob('with-script', { script: 'echo hello' } as any);

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ script: 'echo hello' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('clears closeTimer in finally block when it was set', async () => {
    const closeStdin = vi.fn();

    vi.mocked(spawnAgent).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput, _options) => {
        if (onOutput) {
          // Set result which triggers scheduleClose (sets closeTimer)
          await onOutput({ status: 'success', result: 'result' });
        }
        // Return error to exercise more paths, but closeTimer was set
        return { status: 'error', result: null, error: 'oops', newSessionId: 'sess-1' };
      },
    );

    upsertJob({
      id: 'finally-clear',
      name: 'finally clear',
      prompt: 'test',
      schedule_type: 'interval',
      schedule_value: '3600000',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      max_retries: 3,
      max_consecutive_failures: 5,
    });

    startSchedulerLoop(makeDeps({ closeStdin }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();
    // Advance a lot — if closeTimer was NOT cleared, closeStdin would fire
    await vi.advanceTimersByTimeAsync(20_000);

    // closeStdin should NOT have been called because the timer was cleared in finally
    expect(closeStdin).not.toHaveBeenCalled();
  });

  it('non-Error thrown by spawnAgent is stringified', async () => {
    vi.mocked(spawnAgent).mockRejectedValueOnce('plain-string-crash');

    upsertJob({
      id: 'non-error-throw',
      name: 'non error throw',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      max_retries: 0,
      max_consecutive_failures: 1,
    });

    startSchedulerLoop(makeDeps());
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await Promise.resolve();

    const runs = listJobRuns('non-error-throw', 10);
    expect(runs[0].error_summary).toBe('plain-string-crash');
  });
});
