import { describe, expect, it } from 'vitest';

import {
  createClient,
  defaultEnv,
  readIpcFiles,
  setupMcpHarness,
} from './ipc-mcp-stdio-test-harness.js';

const ctx = setupMcpHarness();

describe('ipc-mcp-stdio > update_task', () => {
  it('writes IPC file with name update', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      await client.callTool({
        name: 'update_task',
        arguments: { task_id: 'task-123', name: 'new-name' },
      });

      const files = readIpcFiles(ctx.tasksDir);
      expect(files).toHaveLength(1);
      const data = files[0] as Record<string, unknown>;
      expect(data.type).toBe('update_task');
      expect(data.taskId).toBe('task-123');
      expect(data.taskName).toBe('new-name');
    } finally {
      await client.close();
    }
  });

  it('writes IPC file with prompt and model update', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      await client.callTool({
        name: 'update_task',
        arguments: {
          task_id: 'task-456',
          prompt: 'updated prompt',
          model: 'haiku',
        },
      });

      const files = readIpcFiles(ctx.tasksDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.prompt).toBe('updated prompt');
      expect(data.model).toBe('haiku');
      expect(data.taskName).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('clears name with empty string', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      await client.callTool({
        name: 'update_task',
        arguments: { task_id: 'task-789', name: '' },
      });

      const files = readIpcFiles(ctx.tasksDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.taskName).toBe('');
    } finally {
      await client.close();
    }
  });

  it('rejects invalid cron in update', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'update_task',
        arguments: {
          task_id: 'task-123',
          schedule_type: 'cron',
          schedule_value: 'bad-cron',
        },
      });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('rejects invalid interval in update', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'update_task',
        arguments: {
          task_id: 'task-123',
          schedule_type: 'interval',
          schedule_value: '0',
        },
      });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
