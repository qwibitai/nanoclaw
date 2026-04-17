import { describe, expect, it } from 'vitest';

import {
  createClient,
  defaultEnv,
  readIpcFiles,
  setupMcpHarness,
} from './ipc-mcp-stdio-test-harness.js';

const ctx = setupMcpHarness();

describe('ipc-mcp-stdio > pause_task', () => {
  it('writes pause IPC file', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      await client.callTool({
        name: 'pause_task',
        arguments: { task_id: 'task-abc' },
      });

      const files = readIpcFiles(ctx.tasksDir);
      expect(files).toHaveLength(1);
      const data = files[0] as Record<string, unknown>;
      expect(data.type).toBe('pause_task');
      expect(data.taskId).toBe('task-abc');
    } finally {
      await client.close();
    }
  });
});

describe('ipc-mcp-stdio > resume_task', () => {
  it('writes resume IPC file', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      await client.callTool({
        name: 'resume_task',
        arguments: { task_id: 'task-abc' },
      });

      const files = readIpcFiles(ctx.tasksDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.type).toBe('resume_task');
    } finally {
      await client.close();
    }
  });
});

describe('ipc-mcp-stdio > cancel_task', () => {
  it('writes cancel IPC file', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      await client.callTool({
        name: 'cancel_task',
        arguments: { task_id: 'task-abc' },
      });

      const files = readIpcFiles(ctx.tasksDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.type).toBe('cancel_task');
    } finally {
      await client.close();
    }
  });
});
