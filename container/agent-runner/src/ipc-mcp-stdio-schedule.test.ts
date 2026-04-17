import { describe, expect, it } from 'vitest';

import {
  createClient,
  defaultEnv,
  readIpcFiles,
  setupMcpHarness,
} from './ipc-mcp-stdio-test-harness.js';

const ctx = setupMcpHarness();

describe('ipc-mcp-stdio > schedule_task', () => {
  it('writes IPC file with correct fields for cron task', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'schedule_task',
        arguments: {
          name: 'my-cron',
          prompt: 'do something',
          schedule_type: 'cron',
          schedule_value: '0 9 * * *',
          context_mode: 'isolated',
        },
      });

      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('scheduled');

      const files = readIpcFiles(ctx.tasksDir);
      expect(files).toHaveLength(1);
      const data = files[0] as Record<string, unknown>;
      expect(data.type).toBe('schedule_task');
      expect(data.taskName).toBe('my-cron');
      expect(data.prompt).toBe('do something');
      expect(data.schedule_type).toBe('cron');
      expect(data.schedule_value).toBe('0 9 * * *');
      expect(data.context_mode).toBe('isolated');
      expect(data.targetJid).toBe('tg:123');
    } finally {
      await client.close();
    }
  });

  it('writes IPC file for interval task', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      await client.callTool({
        name: 'schedule_task',
        arguments: {
          prompt: 'check status',
          schedule_type: 'interval',
          schedule_value: '300000',
        },
      });

      const files = readIpcFiles(ctx.tasksDir);
      expect(files).toHaveLength(1);
      const data = files[0] as Record<string, unknown>;
      expect(data.schedule_type).toBe('interval');
      expect(data.schedule_value).toBe('300000');
      expect(data.context_mode).toBe('group');
    } finally {
      await client.close();
    }
  });

  it('rejects invalid cron expression', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'schedule_task',
        arguments: {
          prompt: 'test',
          schedule_type: 'cron',
          schedule_value: 'not-a-cron',
        },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('Invalid cron');
    } finally {
      await client.close();
    }
  });

  it('rejects invalid interval', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'schedule_task',
        arguments: {
          prompt: 'test',
          schedule_type: 'interval',
          schedule_value: '-100',
        },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('Invalid interval');
    } finally {
      await client.close();
    }
  });

  it('rejects once timestamp with Z suffix', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'schedule_task',
        arguments: {
          prompt: 'test',
          schedule_type: 'once',
          schedule_value: '2026-02-01T15:30:00Z',
        },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('local time');
    } finally {
      await client.close();
    }
  });

  it('rejects invalid once timestamp', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'schedule_task',
        arguments: {
          prompt: 'test',
          schedule_type: 'once',
          schedule_value: 'not-a-date',
        },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('Invalid timestamp');
    } finally {
      await client.close();
    }
  });

  it('accepts valid once timestamp without Z', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'schedule_task',
        arguments: {
          prompt: 'remind me',
          schedule_type: 'once',
          schedule_value: '2026-12-01T15:30:00',
        },
      });

      expect(result.isError).toBeFalsy();
      const files = readIpcFiles(ctx.tasksDir);
      expect(files).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it('omits taskName when name is not provided', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      await client.callTool({
        name: 'schedule_task',
        arguments: {
          prompt: 'no name task',
          schedule_type: 'cron',
          schedule_value: '0 9 * * *',
        },
      });

      const files = readIpcFiles(ctx.tasksDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.taskName).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});
