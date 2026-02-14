import { describe, it, expect, beforeEach, mock } from 'bun:test';

import { mock as mockModule } from 'bun:test';

mockModule.module('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 3,
  MAX_TASK_CONTAINERS: 2,
}));

mockModule.module('fs', () => ({
  default: {
    mkdirSync: mock(),
    writeFileSync: mock(),
    renameSync: mock(),
  },
}));

import { GroupQueue } from './group-queue.js';

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    queue = new GroupQueue();
  });

  // --- Message lane isolation ---

  it('only runs one message container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const resolvers: Array<() => void> = [];

    const processMessages = mock(async (_groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise<void>((r) => resolvers.push(r));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    await Bun.sleep(10);
    expect(maxConcurrent).toBe(1);

    // Let first finish, second should drain
    resolvers[0]();
    await Bun.sleep(10);

    // Second call should now be running
    resolvers[1]?.();
    await Bun.sleep(10);
  });

  // --- Message enqueue while task is active ---

  it('message runs immediately even when task lane is active', async () => {
    let messageStarted = false;
    let taskResolve: () => void;

    const processMessages = mock(async () => {
      messageStarted = true;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start a task (occupies task lane)
    queue.enqueueTask('group1@g.us', 'task-1', () =>
      new Promise<void>((resolve) => { taskResolve = resolve; }),
      'Test task',
    );
    await Bun.sleep(10);

    expect(queue.isActive('group1@g.us', 'task')).toBe(true);

    // Enqueue a message — should run immediately on message lane
    queue.enqueueMessageCheck('group1@g.us');
    await Bun.sleep(10);

    expect(messageStarted).toBe(true);

    // Clean up
    taskResolve!();
    await Bun.sleep(10);
  });

  // --- Task enqueue while message is active ---

  it('task runs immediately even when message lane is active', async () => {
    let messageResolve: () => void;
    let taskRan = false;

    const processMessages = mock(async () => {
      await new Promise<void>((resolve) => { messageResolve = resolve; });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start message processing
    queue.enqueueMessageCheck('group1@g.us');
    await Bun.sleep(10);

    expect(queue.isActive('group1@g.us', 'message')).toBe(true);

    // Enqueue a task — should run immediately on task lane
    queue.enqueueTask('group1@g.us', 'task-1', async () => { taskRan = true; }, 'Test task');
    await Bun.sleep(10);

    expect(taskRan).toBe(true);

    // Clean up
    messageResolve!();
    await Bun.sleep(10);
  });

  // --- Both lanes active simultaneously ---

  it('both message and task lanes can be active at the same time', async () => {
    let messageResolve: () => void;
    let taskResolve: () => void;

    const processMessages = mock(async () => {
      await new Promise<void>((resolve) => { messageResolve = resolve; });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    await Bun.sleep(10);

    queue.enqueueTask('group1@g.us', 'task-1', () =>
      new Promise<void>((resolve) => { taskResolve = resolve; }),
      'Test task',
    );
    await Bun.sleep(10);

    expect(queue.isActive('group1@g.us', 'message')).toBe(true);
    expect(queue.isActive('group1@g.us', 'task')).toBe(true);
    expect(queue.isActive('group1@g.us')).toBe(true);

    messageResolve!();
    taskResolve!();
    await Bun.sleep(10);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit across both lanes', async () => {
    const resolvers: Array<() => void> = [];

    const processMessages = mock(async () => {
      await new Promise<void>((resolve) => resolvers.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill all 3 slots (MAX_CONCURRENT_CONTAINERS = 3)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueTask('group2@g.us', 'task-1', () =>
      new Promise<void>((resolve) => resolvers.push(resolve)),
      'Task 1',
    );
    queue.enqueueMessageCheck('group3@g.us');
    await Bun.sleep(10);

    expect(resolvers.length).toBe(3);

    // 4th should be queued (over global limit)
    let fourthStarted = false;
    queue.enqueueTask('group4@g.us', 'task-2', async () => { fourthStarted = true; }, 'Task 2');
    await Bun.sleep(10);
    expect(fourthStarted).toBe(false);

    // Free one slot — 4th should start
    resolvers[0]();
    await Bun.sleep(10);
    expect(fourthStarted).toBe(true);

    // Clean up
    for (const r of resolvers.slice(1)) r();
    await Bun.sleep(10);
  });

  // --- Task concurrency limit ---

  it('respects MAX_TASK_CONTAINERS limit', async () => {
    const resolvers: Array<() => void> = [];

    queue.setProcessMessagesFn(mock(async () => true));

    // Start 2 tasks (MAX_TASK_CONTAINERS = 2)
    queue.enqueueTask('group1@g.us', 'task-1', () =>
      new Promise<void>((resolve) => resolvers.push(resolve)),
      'Task 1',
    );
    queue.enqueueTask('group2@g.us', 'task-2', () =>
      new Promise<void>((resolve) => resolvers.push(resolve)),
      'Task 2',
    );
    await Bun.sleep(10);

    expect(resolvers.length).toBe(2);

    // 3rd task should be queued
    let thirdStarted = false;
    queue.enqueueTask('group3@g.us', 'task-3', async () => { thirdStarted = true; }, 'Task 3');
    await Bun.sleep(10);
    expect(thirdStarted).toBe(false);

    // But a message should still get through
    let messageStarted = false;
    queue.setProcessMessagesFn(mock(async () => { messageStarted = true; return true; }));
    queue.enqueueMessageCheck('group3@g.us');
    await Bun.sleep(10);
    expect(messageStarted).toBe(true);

    // Free a task slot — 3rd task should start
    resolvers[0]();
    await Bun.sleep(10);
    expect(thirdStarted).toBe(true);

    // Clean up
    resolvers[1]();
    await Bun.sleep(10);
  });

  // --- activeTaskInfo tracking ---

  it('tracks activeTaskInfo while task is running', async () => {
    let taskResolve: () => void;

    queue.setProcessMessagesFn(mock(async () => true));

    expect(queue.getActiveTaskInfo('group1@g.us')).toBeNull();

    queue.enqueueTask('group1@g.us', 'task-42', () =>
      new Promise<void>((resolve) => { taskResolve = resolve; }),
      'Run daily report',
    );
    await Bun.sleep(10);

    const info = queue.getActiveTaskInfo('group1@g.us');
    expect(info).not.toBeNull();
    expect(info!.taskId).toBe('task-42');
    expect(info!.promptPreview).toBe('Run daily report');
    expect(info!.startedAt).toBeGreaterThan(0);

    taskResolve!();
    await Bun.sleep(10);

    expect(queue.getActiveTaskInfo('group1@g.us')).toBeNull();
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = mock(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueTask('group1@g.us', 'task-1', async () => {}, 'Test');
    await Bun.sleep(50);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting message groups when active slots free up', async () => {
    const processed: string[] = [];
    const resolvers: Array<() => void> = [];

    const processMessages = mock(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill all 3 slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    await Bun.sleep(10);

    // Queue a 4th
    queue.enqueueMessageCheck('group4@g.us');
    await Bun.sleep(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us', 'group3@g.us']);

    // Free up a slot
    resolvers[0]();
    await Bun.sleep(10);

    expect(processed).toContain('group4@g.us');

    // Clean up
    for (const r of resolvers.slice(1)) r();
    await Bun.sleep(10);
  });

  // --- isActive with lane parameter ---

  it('isActive returns correct state per lane', async () => {
    let messageResolve: () => void;
    let taskResolve: () => void;

    const processMessages = mock(async () => {
      await new Promise<void>((resolve) => { messageResolve = resolve; });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    expect(queue.isActive('group1@g.us')).toBe(false);
    expect(queue.isActive('group1@g.us', 'message')).toBe(false);
    expect(queue.isActive('group1@g.us', 'task')).toBe(false);

    queue.enqueueMessageCheck('group1@g.us');
    await Bun.sleep(10);

    expect(queue.isActive('group1@g.us')).toBe(true);
    expect(queue.isActive('group1@g.us', 'message')).toBe(true);
    expect(queue.isActive('group1@g.us', 'task')).toBe(false);

    queue.enqueueTask('group1@g.us', 'task-1', () =>
      new Promise<void>((resolve) => { taskResolve = resolve; }),
      'Test',
    );
    await Bun.sleep(10);

    expect(queue.isActive('group1@g.us', 'message')).toBe(true);
    expect(queue.isActive('group1@g.us', 'task')).toBe(true);

    messageResolve!();
    await Bun.sleep(10);

    expect(queue.isActive('group1@g.us', 'message')).toBe(false);
    expect(queue.isActive('group1@g.us', 'task')).toBe(true);

    taskResolve!();
    await Bun.sleep(10);
  });

  // --- Task deduplication ---

  it('prevents double-queuing of the same task', async () => {
    let taskRunCount = 0;
    let taskResolve: () => void;

    queue.setProcessMessagesFn(mock(async () => true));

    // Start a task to occupy the lane
    queue.enqueueTask('group1@g.us', 'task-blocker', () =>
      new Promise<void>((resolve) => { taskResolve = resolve; }),
      'Blocker',
    );
    await Bun.sleep(10);

    // Try to enqueue the same task twice while lane is occupied
    queue.enqueueTask('group1@g.us', 'task-dup', async () => { taskRunCount++; }, 'Dup');
    queue.enqueueTask('group1@g.us', 'task-dup', async () => { taskRunCount++; }, 'Dup');

    // Release the blocker
    taskResolve!();
    await Bun.sleep(10);

    expect(taskRunCount).toBe(1);
  });
});
