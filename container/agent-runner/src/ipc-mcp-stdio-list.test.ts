import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  createClient,
  defaultEnv,
  setupMcpHarness,
} from './ipc-mcp-stdio-test-harness.js';

const ctx = setupMcpHarness();

describe('ipc-mcp-stdio > list_tasks', () => {
  it('reports file not found when no snapshot file exists', async () => {
    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'list_tasks',
        arguments: {},
      });

      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('file not found');
    } finally {
      await client.close();
    }
  });

  it('formats tasks with name and context_mode', async () => {
    const snapshot = [
      {
        id: 'cron-test',
        name: 'My Test Task',
        groupFolder: 'telegram_main',
        prompt: 'Do the thing every morning',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        context_mode: 'group',
        status: 'active',
        next_run: '2026-04-16T00:00:00.000Z',
      },
    ];
    fs.writeFileSync(
      path.join(ctx.groupDir, 'current_tasks.json'),
      JSON.stringify(snapshot),
    );

    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'list_tasks',
        arguments: {},
      });

      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('cron-test');
      expect(text).toContain('"My Test Task"');
      expect(text).toContain('group');
      expect(text).toContain('active');
    } finally {
      await client.close();
    }
  });

  it('shows isolated as default context_mode when missing', async () => {
    const snapshot = [
      {
        id: 'task-old',
        groupFolder: 'telegram_main',
        prompt: 'Legacy task without context_mode',
        schedule_type: 'interval',
        schedule_value: '60000',
        status: 'active',
        next_run: null,
      },
    ];
    fs.writeFileSync(
      path.join(ctx.groupDir, 'current_tasks.json'),
      JSON.stringify(snapshot),
    );

    const client = await createClient(defaultEnv(ctx));
    try {
      const result = await client.callTool({
        name: 'list_tasks',
        arguments: {},
      });

      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('isolated');
    } finally {
      await client.close();
    }
  });

  it('non-main group only sees own tasks', async () => {
    const snapshot = [
      {
        id: 'task-main',
        groupFolder: 'telegram_main',
        prompt: 'Main task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        status: 'active',
        next_run: null,
      },
      {
        id: 'task-other',
        groupFolder: 'telegram_other',
        prompt: 'Other task',
        schedule_type: 'cron',
        schedule_value: '0 10 * * *',
        status: 'active',
        next_run: null,
      },
    ];
    fs.writeFileSync(
      path.join(ctx.groupDir, 'current_tasks.json'),
      JSON.stringify(snapshot),
    );

    const client = await createClient({
      ...defaultEnv(ctx),
      NANOCLAW_GROUP_FOLDER: 'telegram_other',
      NANOCLAW_IS_MAIN: '0',
    });
    try {
      const result = await client.callTool({
        name: 'list_tasks',
        arguments: {},
      });

      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('task-other');
      expect(text).not.toContain('task-main');
    } finally {
      await client.close();
    }
  });
});
