import { describe, expect, it } from 'vitest';

import { createToolContextFromEnv } from './context.js';

describe('createToolContextFromEnv', () => {
  it('populates every field from NANOCLAW_ environment variables', () => {
    const ctx = createToolContextFromEnv({
      NANOCLAW_IPC_DIR: '/workspace/ipc',
      NANOCLAW_GROUP_DIR: '/workspace',
      NANOCLAW_CHAT_JID: 'chat@g.us',
      NANOCLAW_GROUP_FOLDER: 'test-group',
      NANOCLAW_IS_MAIN: '1',
    });
    expect(ctx.chatJid).toBe('chat@g.us');
    expect(ctx.groupFolder).toBe('test-group');
    expect(ctx.isMain).toBe(true);
    expect(ctx.ipcDir).toBe('/workspace/ipc');
    expect(ctx.groupDir).toBe('/workspace');
    expect(ctx.messagesDir).toBe('/workspace/ipc/messages');
    expect(ctx.tasksDir).toBe('/workspace/ipc/tasks');
  });

  it('treats isMain as false unless NANOCLAW_IS_MAIN is exactly "1"', () => {
    for (const value of ['0', 'true', 'yes', '']) {
      const ctx = createToolContextFromEnv({
        NANOCLAW_IS_MAIN: value,
      });
      expect(ctx.isMain).toBe(false);
    }
  });

  it('falls back to /workspace defaults when directory env vars are missing', () => {
    const ctx = createToolContextFromEnv({});
    expect(ctx.ipcDir).toBe('/workspace/ipc');
    expect(ctx.groupDir).toBe('/workspace');
    expect(ctx.messagesDir).toBe('/workspace/ipc/messages');
    expect(ctx.tasksDir).toBe('/workspace/ipc/tasks');
  });

  it('yields an empty string for chatJid/groupFolder when not set', () => {
    const ctx = createToolContextFromEnv({});
    expect(ctx.chatJid).toBe('');
    expect(ctx.groupFolder).toBe('');
  });
});
