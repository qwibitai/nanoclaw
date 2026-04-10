import { describe, expect, it, vi } from 'vitest';

import { createControlPlaneRunner } from './control-plane-runner.js';

describe('control-plane runner', () => {
  it('claims the first backlog task and runs it once', async () => {
    const client = {
      bootstrap: vi.fn(async () => ({ agent: { id: 'agent-1' } })),
      heartbeat: vi.fn(async () => ({})),
      getTasks: vi.fn(async () => [
        {
          id: 'task-backlog',
          status: 'backlog',
          title: 'Fix bug',
          description: 'Investigate and fix the failing task.',
        },
        {
          id: 'task-review',
          status: 'review',
          description: 'Already complete.',
        },
      ]),
      updateTask: vi.fn(async () => ({})),
      postMessage: vi.fn(async () => ({})),
    };
    const executeTask = vi.fn(async (_selection, options) => {
      await options.onOutput?.({
        status: 'success',
        result: 'Work started',
      });
      return {
        status: 'success',
        result: 'Final result',
      };
    });
    const runner = createControlPlaneRunner({
      client,
      executeTask: executeTask as any,
      resolveGroup: (() => ({
        jid: 'tg:main',
        group: {
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: true,
        },
      })) as any,
    });

    await runner.pollOnce();

    expect(client.getTasks).toHaveBeenCalledWith(false);
    expect(client.updateTask).toHaveBeenNthCalledWith(1, 'task-backlog', {
      claim: true,
      status: 'in-progress',
      message: 'Picked up task-backlog and starting work.',
    });
    expect(client.postMessage).toHaveBeenNthCalledWith(1, {
      taskId: 'task-backlog',
      body: 'NanoClaw picked up task-backlog in local group "main" and is starting work.',
    });
    expect(executeTask).toHaveBeenCalledTimes(1);
    expect(client.postMessage).toHaveBeenNthCalledWith(2, {
      taskId: 'task-backlog',
      body: 'Work started',
    });
    expect(client.postMessage).toHaveBeenNthCalledWith(3, {
      taskId: 'task-backlog',
      body: 'Final result',
    });
    expect(client.updateTask).toHaveBeenNthCalledWith(2, 'task-backlog', {
      status: 'review',
      message: 'NanoClaw completed task-backlog and marked it review.',
    });
  });

  it('posts a failure message and does not crash when execution fails', async () => {
    const client = {
      bootstrap: vi.fn(async () => ({ agent: { id: 'agent-1' } })),
      heartbeat: vi.fn(async () => ({})),
      getTasks: vi.fn(async () => [
        {
          id: 'task-backlog',
          status: 'backlog',
          description: 'Broken task',
        },
      ]),
      updateTask: vi.fn(async () => ({})),
      postMessage: vi.fn(async () => ({})),
    };
    const runner = createControlPlaneRunner({
      client,
      executeTask: (async () => ({
        status: 'error',
        result: null,
        error: 'container failed',
      })) as any,
      resolveGroup: (() => ({
        jid: 'tg:main',
        group: {
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: true,
        },
      })) as any,
      failureStatus: 'blocked',
    });

    await runner.pollOnce();

    expect(client.postMessage).toHaveBeenNthCalledWith(2, {
      taskId: 'task-backlog',
      body: 'NanoClaw failed while processing task-backlog: container failed',
    });
    expect(client.updateTask).toHaveBeenNthCalledWith(2, 'task-backlog', {
      status: 'blocked',
      message:
        'NanoClaw failed while processing task-backlog: container failed',
    });
  });
});
