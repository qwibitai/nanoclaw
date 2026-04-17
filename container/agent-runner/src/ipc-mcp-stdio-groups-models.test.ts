import { describe, expect, it } from 'vitest';

import {
  createClient,
  defaultEnv,
  readIpcFiles,
  setupMcpHarness,
} from './ipc-mcp-stdio-test-harness.js';

const ctx = setupMcpHarness();

describe('ipc-mcp-stdio > register_group', () => {
  it('rejects when not main', async () => {
    const client = await createClient({
      ...defaultEnv(ctx),
      NANOCLAW_IS_MAIN: '0',
    });
    try {
      const result = await client.callTool({
        name: 'register_group',
        arguments: {
          jid: 'tg:999',
          name: 'Test Group',
          folder: 'telegram_test',
          trigger: '@bot',
        },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('main group');
    } finally {
      await client.close();
    }
  });

  it('writes IPC file when main', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      await client.callTool({
        name: 'register_group',
        arguments: {
          jid: 'tg:999',
          name: 'Test Group',
          folder: 'telegram_test',
          trigger: '@bot',
        },
      });

      const files = readIpcFiles(ctx.tasksDir);
      expect(files).toHaveLength(1);
      const data = files[0] as Record<string, unknown>;
      expect(data.type).toBe('register_group');
      expect(data.jid).toBe('tg:999');
      expect(data.folder).toBe('telegram_test');
    } finally {
      await client.close();
    }
  });
});

describe('ipc-mcp-stdio > switch_model', () => {
  it('writes model switch IPC file', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'switch_model',
        arguments: { model: 'opus' },
      });

      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('opus');

      const files = readIpcFiles(ctx.tasksDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.type).toBe('switch_model');
      expect(data.model).toBe('opus');
    } finally {
      await client.close();
    }
  });

  it('handles reset', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'switch_model',
        arguments: { model: 'reset' },
      });

      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('cleared');
    } finally {
      await client.close();
    }
  });

  it('includes effort and thinking_budget', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'switch_model',
        arguments: {
          model: 'sonnet',
          effort: 'high',
          thinking_budget: 'medium',
        },
      });

      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('sonnet');
      expect(text).toContain('Effort set to "high"');
      expect(text).toContain('Thinking budget set to "medium"');

      const files = readIpcFiles(ctx.tasksDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.effort).toBe('high');
      expect(data.thinking_budget).toBe('medium');
    } finally {
      await client.close();
    }
  });
});
