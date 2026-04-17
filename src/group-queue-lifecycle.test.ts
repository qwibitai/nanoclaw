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

describe('GroupQueue — killProcess', () => {
  it('sends SIGTERM then SIGKILL after 5s', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    const kill = vi.fn();
    const proc = {
      kill,
      killed: false,
    } as unknown as import('child_process').ChildProcess;
    queue.registerProcess('group1@g.us', proc, 'container-1', 'test-group');

    queue.killProcess('group1@g.us');

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(kill).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(kill).toHaveBeenCalledTimes(2);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('skips SIGKILL if process already killed', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    const kill = vi.fn();
    const proc = {
      kill,
      killed: false,
    } as unknown as import('child_process').ChildProcess;
    queue.registerProcess('group1@g.us', proc, 'container-1', 'test-group');

    queue.killProcess('group1@g.us');
    expect(kill).toHaveBeenCalledWith('SIGTERM');

    (proc as { killed: boolean }).killed = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(kill).toHaveBeenCalledTimes(1);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('is a no-op when no process is registered', () => {
    queue.killProcess('nonexistent@g.us');
  });
});

describe('GroupQueue — advanceCursorFn', () => {
  it('calls advanceCursorFn on successful container exit', async () => {
    const advanceCursor = vi.fn();
    queue.advanceCursorFn = advanceCursor;

    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledWith('group1@g.us');
    expect(advanceCursor).toHaveBeenCalledOnce();
    expect(advanceCursor).toHaveBeenCalledWith('group1@g.us');
  });

  it('does not call advanceCursorFn on failed container exit', async () => {
    const advanceCursor = vi.fn();
    queue.advanceCursorFn = advanceCursor;

    const processMessages = vi.fn(async () => false);
    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalled();
    expect(advanceCursor).not.toHaveBeenCalled();
  });
});

describe('GroupQueue — getStatus', () => {
  it('returns 0 active containers initially', () => {
    expect(queue.getStatus()).toEqual({ activeContainers: 0 });
  });

  it('reflects active container count', async () => {
    queue.setProcessMessagesFn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10000));
      return true;
    });

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.getStatus().activeContainers).toBe(1);
  });
});
