import { describe, expect, it } from 'vitest';

import {
  createClient,
  defaultEnv,
  readIpcFiles,
  setupMcpHarness,
} from './ipc-mcp-stdio-test-harness.js';

const ctx = setupMcpHarness();

describe('ipc-mcp-stdio > send_message', () => {
  it('writes IPC message file', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'send_message',
        arguments: { text: 'Hello world' },
      });

      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('sent');

      const files = readIpcFiles(ctx.messagesDir);
      expect(files).toHaveLength(1);
      const data = files[0] as Record<string, unknown>;
      expect(data.type).toBe('message');
      expect(data.text).toBe('Hello world');
      expect(data.chatJid).toBe('tg:123');
    } finally {
      await client.close();
    }
  });

  it('includes sender when provided', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      await client.callTool({
        name: 'send_message',
        arguments: { text: 'Update', sender: 'Researcher' },
      });

      const files = readIpcFiles(ctx.messagesDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.sender).toBe('Researcher');
    } finally {
      await client.close();
    }
  });
});
