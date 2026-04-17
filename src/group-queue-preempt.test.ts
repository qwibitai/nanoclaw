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

function countCloseWrites(writeFileSync: ReturnType<typeof vi.mocked>): number {
  return writeFileSync.mock.calls.filter(
    (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
  ).length;
}

describe('GroupQueue — idle preemption', () => {
  it('does NOT preempt active container when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess(
      'group1@g.us',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'container-1',
      'test-group',
    );

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    expect(countCloseWrites(writeFileSync)).toBe(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle container when task is enqueued (after grace period)', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess(
      'group1@g.us',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'container-1',
      'test-group',
    );
    queue.notifyIdle('group1@g.us');

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    expect(countCloseWrites(writeFileSync)).toBe(0);

    await vi.advanceTimersByTimeAsync(60000);
    expect(countCloseWrites(writeFileSync)).toBe(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'container-1',
      'test-group',
    );

    queue.notifyIdle('group1@g.us');
    queue.sendMessage('group1@g.us', 'hello');

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    expect(countCloseWrites(writeFileSync)).toBe(0);

    await vi.advanceTimersByTimeAsync(60000);
    expect(countCloseWrites(writeFileSync)).toBe(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts when idle arrives with pending tasks (after grace period)', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess(
      'group1@g.us',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'container-1',
      'test-group',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    expect(countCloseWrites(writeFileSync)).toBe(0);

    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us');

    expect(countCloseWrites(writeFileSync)).toBe(0);

    await vi.advanceTimersByTimeAsync(60000);
    expect(countCloseWrites(writeFileSync)).toBe(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe('GroupQueue — grace period', () => {
  it('sendMessage during grace period cancels preemption', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'container-1',
      'test-group',
    );

    queue.notifyIdle('group1@g.us');
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    await vi.advanceTimersByTimeAsync(30000);
    queue.sendMessage('group1@g.us', 'hello');

    await vi.advanceTimersByTimeAsync(60000);
    expect(countCloseWrites(writeFileSync)).toBe(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('does not restart grace timer on additional notifyIdle calls', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'container-1',
      'test-group',
    );

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    queue.notifyIdle('group1@g.us');

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    await vi.advanceTimersByTimeAsync(30000);
    queue.notifyIdle('group1@g.us');

    await vi.advanceTimersByTimeAsync(30000);
    expect(countCloseWrites(writeFileSync)).toBe(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });
});
