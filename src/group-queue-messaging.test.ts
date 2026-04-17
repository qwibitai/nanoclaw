import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  HOST_MODE: false,
  MAX_CONCURRENT_CONTAINERS: 2,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

import { GroupQueue } from './group-queue.js';

let queue: GroupQueue;

beforeEach(() => {
  vi.useFakeTimers();
  queue = new GroupQueue();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GroupQueue — sendMessage to task containers', () => {
  it('sendMessage returns false for task containers so user messages queue up', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'container-1',
      'test-group',
    );

    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe('GroupQueue — response-sent tracking', () => {
  it('markResponseSent records timestamp and isRecentResponseSent checks it', () => {
    vi.setSystemTime(new Date('2026-04-05T12:00:00Z'));

    expect(queue.isRecentResponseSent('group1@g.us')).toBe(false);

    queue.markResponseSent('group1@g.us');
    expect(queue.isRecentResponseSent('group1@g.us')).toBe(true);

    vi.setSystemTime(new Date('2026-04-05T12:00:05Z'));
    expect(queue.isRecentResponseSent('group1@g.us')).toBe(true);

    vi.setSystemTime(new Date('2026-04-05T12:00:11Z'));
    expect(queue.isRecentResponseSent('group1@g.us')).toBe(false);
  });

  it('isRecentResponseSent respects custom window', () => {
    vi.setSystemTime(new Date('2026-04-05T12:00:00Z'));

    queue.markResponseSent('group1@g.us');

    vi.setSystemTime(new Date('2026-04-05T12:00:03Z'));
    expect(queue.isRecentResponseSent('group1@g.us', 5000)).toBe(true);
    expect(queue.isRecentResponseSent('group1@g.us', 2000)).toBe(false);
  });

  it('markResponseSent is per-group', () => {
    vi.setSystemTime(new Date('2026-04-05T12:00:00Z'));

    queue.markResponseSent('group1@g.us');
    expect(queue.isRecentResponseSent('group1@g.us')).toBe(true);
    expect(queue.isRecentResponseSent('group2@g.us')).toBe(false);
  });
});
