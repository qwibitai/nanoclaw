/**
 * Unit tests for every NanoClaw MCP tool handler. The factories
 * accept a ToolContext, so we inject a stub writeIpcFile and capture
 * exactly what payload each tool would write — no filesystem or
 * stdio subprocess needed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolContext } from '../context.js';

import {
  buildRegisterGroupTool,
  buildSwitchModelTool,
} from './admin-tools.js';
import { buildSendMessageTool } from './message-tools.js';
import {
  buildCancelTaskTool,
  buildListTasksTool,
  buildPauseTaskTool,
  buildResumeTaskTool,
  buildScheduleTaskTool,
  buildUpdateTaskTool,
} from './task-tools.js';
import { buildAllTools } from './register.js';

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext & {
  calls: Array<{ dir: string; data: Record<string, unknown> }>;
} {
  const calls: Array<{ dir: string; data: Record<string, unknown> }> = [];
  return {
    chatJid: 'chat@g.us',
    groupFolder: 'test-group',
    isMain: false,
    ipcDir: '/ipc',
    groupDir: '/group',
    messagesDir: '/ipc/messages',
    tasksDir: '/ipc/tasks',
    writeIpcFile: (dir, data) => {
      calls.push({ dir, data: data as Record<string, unknown> });
      return 'stub.json';
    },
    calls,
    ...overrides,
  };
}

// --- send_message -----------------------------------------------------

describe('send_message tool', () => {
  it('writes an IPC file with the chat context', async () => {
    const ctx = makeContext();
    const tool = buildSendMessageTool(ctx);
    const res = await tool.handler({ text: 'hello' });
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].dir).toBe('/ipc/messages');
    expect(ctx.calls[0].data).toMatchObject({
      type: 'message',
      chatJid: 'chat@g.us',
      text: 'hello',
      groupFolder: 'test-group',
    });
    expect(ctx.calls[0].data.sender).toBeUndefined();
    expect(res.content[0].text).toBe('Message sent.');
  });

  it('forwards the sender label when provided', async () => {
    const ctx = makeContext();
    const tool = buildSendMessageTool(ctx);
    await tool.handler({ text: 'hi', sender: 'Researcher' });
    expect(ctx.calls[0].data.sender).toBe('Researcher');
  });
});

// --- schedule_task ----------------------------------------------------

describe('schedule_task tool', () => {
  it('creates a task with a generated id and default context_mode', async () => {
    const ctx = makeContext();
    const tool = buildScheduleTaskTool(ctx);
    const res = await tool.handler({
      prompt: 'do thing',
      schedule_type: 'interval',
      schedule_value: '60000',
    });
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].dir).toBe('/ipc/tasks');
    expect(ctx.calls[0].data.type).toBe('schedule_task');
    expect(ctx.calls[0].data.taskId).toMatch(/^task-\d+-[a-z0-9]+/);
    expect(ctx.calls[0].data.context_mode).toBe('group');
    expect(ctx.calls[0].data.targetJid).toBe('chat@g.us'); // non-main → self
    expect((res as { isError?: boolean }).isError).not.toBe(true);
  });

  it('honours target_group_jid only for main groups', async () => {
    const mainCtx = makeContext({ isMain: true });
    const mainTool = buildScheduleTaskTool(mainCtx);
    await mainTool.handler({
      prompt: 'from main',
      schedule_type: 'once',
      schedule_value: '2026-12-31T00:00:00',
      target_group_jid: 'other@g.us',
    });
    expect(mainCtx.calls[0].data.targetJid).toBe('other@g.us');

    const nonMainCtx = makeContext({ isMain: false });
    const nonMainTool = buildScheduleTaskTool(nonMainCtx);
    await nonMainTool.handler({
      prompt: 'from child',
      schedule_type: 'once',
      schedule_value: '2026-12-31T00:00:00',
      target_group_jid: 'other@g.us',
    });
    expect(nonMainCtx.calls[0].data.targetJid).toBe('chat@g.us');
  });

  it('rejects an invalid cron expression with isError=true and no IPC write', async () => {
    const ctx = makeContext();
    const tool = buildScheduleTaskTool(ctx);
    const res = (await tool.handler({
      prompt: 'x',
      schedule_type: 'cron',
      schedule_value: 'garbage',
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(ctx.calls).toHaveLength(0);
    expect(res.content[0].text).toMatch(/Invalid cron/);
  });

  it('rejects a once timestamp with a Z suffix', async () => {
    const ctx = makeContext();
    const tool = buildScheduleTaskTool(ctx);
    const res = (await tool.handler({
      prompt: 'x',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00Z',
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(ctx.calls).toHaveLength(0);
  });

  it('rejects a non-positive interval', async () => {
    const ctx = makeContext();
    const tool = buildScheduleTaskTool(ctx);
    const res = (await tool.handler({
      prompt: 'x',
      schedule_type: 'interval',
      schedule_value: '0',
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(ctx.calls).toHaveLength(0);
  });

  it('forwards optional script and model fields', async () => {
    const ctx = makeContext();
    const tool = buildScheduleTaskTool(ctx);
    await tool.handler({
      prompt: 'go',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      script: 'echo hi',
      model: 'opus',
      context_mode: 'isolated',
    });
    expect(ctx.calls[0].data.script).toBe('echo hi');
    expect(ctx.calls[0].data.model).toBe('opus');
    expect(ctx.calls[0].data.context_mode).toBe('isolated');
  });
});

// --- list_tasks -------------------------------------------------------

describe('list_tasks tool', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'list-tasks-'));
  });
  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function writeTasksFile(entries: unknown[]): string {
    const p = path.join(sandbox, 'current_tasks.json');
    fs.writeFileSync(p, JSON.stringify(entries));
    return sandbox;
  }

  it('reports "not found" when the tasks file is missing', async () => {
    const ctx = makeContext({ groupDir: sandbox });
    const tool = buildListTasksTool(ctx);
    const res = await tool.handler({});
    expect(res.content[0].text).toMatch(/No scheduled tasks found/);
  });

  it('returns only the calling group\'s tasks for non-main callers', async () => {
    writeTasksFile([
      {
        id: 'a',
        prompt: 'mine',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        status: 'active',
        next_run: '2026-01-01',
        groupFolder: 'test-group',
      },
      {
        id: 'b',
        prompt: 'theirs',
        schedule_type: 'cron',
        schedule_value: '0 10 * * *',
        status: 'active',
        next_run: '2026-01-01',
        groupFolder: 'other-group',
      },
    ]);
    const ctx = makeContext({ groupDir: sandbox });
    const res = await buildListTasksTool(ctx).handler({});
    expect(res.content[0].text).toContain('[a]');
    expect(res.content[0].text).not.toContain('[b]');
  });

  it('returns every task for the main group', async () => {
    writeTasksFile([
      {
        id: 'a',
        prompt: 'x',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        status: 'active',
        next_run: '2026-01-01',
        groupFolder: 'test-group',
      },
      {
        id: 'b',
        prompt: 'y',
        schedule_type: 'cron',
        schedule_value: '0 10 * * *',
        status: 'active',
        next_run: '2026-01-01',
        groupFolder: 'other-group',
      },
    ]);
    const ctx = makeContext({ isMain: true, groupDir: sandbox });
    const res = await buildListTasksTool(ctx).handler({});
    expect(res.content[0].text).toContain('[a]');
    expect(res.content[0].text).toContain('[b]');
  });

  it('emits the "zero for this folder" message when filters produce empty result', async () => {
    writeTasksFile([
      {
        id: 'b',
        prompt: 'x',
        schedule_type: 'cron',
        schedule_value: '0 10 * * *',
        status: 'active',
        next_run: '2026-01-01',
        groupFolder: 'other-group',
      },
    ]);
    const ctx = makeContext({ groupDir: sandbox });
    const res = await buildListTasksTool(ctx).handler({});
    expect(res.content[0].text).toContain('1 total, 0 for test-group');
  });

  it('gracefully reports an error when the file is malformed', async () => {
    fs.writeFileSync(path.join(sandbox, 'current_tasks.json'), 'not-json');
    const ctx = makeContext({ groupDir: sandbox });
    const res = await buildListTasksTool(ctx).handler({});
    expect(res.content[0].text).toMatch(/Error reading tasks/);
  });
});

// --- pause / resume / cancel ------------------------------------------

describe('pause/resume/cancel tools', () => {
  it('pause_task writes the correct IPC payload', async () => {
    const ctx = makeContext();
    await buildPauseTaskTool(ctx).handler({ task_id: 't1' });
    expect(ctx.calls[0].data).toMatchObject({
      type: 'pause_task',
      taskId: 't1',
      groupFolder: 'test-group',
      isMain: false,
    });
  });

  it('resume_task writes the correct IPC payload', async () => {
    const ctx = makeContext({ isMain: true });
    await buildResumeTaskTool(ctx).handler({ task_id: 't2' });
    expect(ctx.calls[0].data).toMatchObject({
      type: 'resume_task',
      taskId: 't2',
      isMain: true,
    });
  });

  it('cancel_task writes the correct IPC payload', async () => {
    const ctx = makeContext();
    await buildCancelTaskTool(ctx).handler({ task_id: 't3' });
    expect(ctx.calls[0].data).toMatchObject({
      type: 'cancel_task',
      taskId: 't3',
    });
  });
});

// --- update_task ------------------------------------------------------

describe('update_task tool', () => {
  it('writes only the fields that were provided', async () => {
    const ctx = makeContext();
    await buildUpdateTaskTool(ctx).handler({
      task_id: 't1',
      prompt: 'new prompt',
    });
    const data = ctx.calls[0].data;
    expect(data.type).toBe('update_task');
    expect(data.prompt).toBe('new prompt');
    expect(data.taskName).toBeUndefined();
    expect(data.script).toBeUndefined();
    expect(data.schedule_type).toBeUndefined();
    expect(data.schedule_value).toBeUndefined();
  });

  it('allows name: "" to clear the name and script: "" to remove the script', async () => {
    const ctx = makeContext();
    await buildUpdateTaskTool(ctx).handler({
      task_id: 't1',
      name: '',
      script: '',
    });
    expect(ctx.calls[0].data.taskName).toBe('');
    expect(ctx.calls[0].data.script).toBe('');
  });

  it('rejects an invalid cron when schedule_type + schedule_value supplied together', async () => {
    const ctx = makeContext();
    const res = (await buildUpdateTaskTool(ctx).handler({
      task_id: 't1',
      schedule_type: 'cron',
      schedule_value: 'not-cron',
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(ctx.calls).toHaveLength(0);
  });

  it('rejects an invalid interval', async () => {
    const ctx = makeContext();
    const res = (await buildUpdateTaskTool(ctx).handler({
      task_id: 't1',
      schedule_type: 'interval',
      schedule_value: '-5',
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });

  it('accepts a valid schedule update', async () => {
    const ctx = makeContext();
    const res = (await buildUpdateTaskTool(ctx).handler({
      task_id: 't1',
      schedule_type: 'interval',
      schedule_value: '60000',
    })) as { isError?: boolean };
    expect(res.isError).not.toBe(true);
    expect(ctx.calls[0].data.schedule_value).toBe('60000');
  });
});

// --- register_group ---------------------------------------------------

describe('register_group tool', () => {
  it('rejects calls from non-main groups without writing IPC', async () => {
    const ctx = makeContext({ isMain: false });
    const res = (await buildRegisterGroupTool(ctx).handler({
      jid: 'x@g.us',
      name: 'X',
      folder: 'telegram_x',
      trigger: '@Andy',
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(ctx.calls).toHaveLength(0);
  });

  it('writes an IPC file for main-group callers, defaulting requiresTrigger to false', async () => {
    const ctx = makeContext({ isMain: true });
    await buildRegisterGroupTool(ctx).handler({
      jid: 'new@g.us',
      name: 'New',
      folder: 'telegram_new',
      trigger: '@Andy',
    });
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].data).toMatchObject({
      type: 'register_group',
      jid: 'new@g.us',
      name: 'New',
      folder: 'telegram_new',
      trigger: '@Andy',
      requiresTrigger: false,
    });
  });

  it('honours an explicit requiresTrigger=true', async () => {
    const ctx = makeContext({ isMain: true });
    await buildRegisterGroupTool(ctx).handler({
      jid: 'loud@g.us',
      name: 'Loud',
      folder: 'whatsapp_loud',
      trigger: '@Andy',
      requiresTrigger: true,
    });
    expect(ctx.calls[0].data.requiresTrigger).toBe(true);
  });
});

// --- switch_model -----------------------------------------------------

describe('switch_model tool', () => {
  it('writes a switch_model IPC entry and returns a confirmation string', async () => {
    const ctx = makeContext();
    const res = await buildSwitchModelTool(ctx).handler({ model: 'opus' });
    expect(ctx.calls[0].data).toMatchObject({
      type: 'switch_model',
      model: 'opus',
      chatJid: 'chat@g.us',
      groupFolder: 'test-group',
    });
    expect(res.content[0].text).toContain('opus');
    expect(res.content[0].text).toContain('revert');
  });

  it('returns "override cleared" for model=reset', async () => {
    const ctx = makeContext();
    const res = await buildSwitchModelTool(ctx).handler({ model: 'reset' });
    expect(res.content[0].text).toContain('Model override cleared');
  });

  it('includes effort + thinking_budget when provided', async () => {
    const ctx = makeContext();
    const res = await buildSwitchModelTool(ctx).handler({
      model: 'opus',
      effort: 'high',
      thinking_budget: 'medium',
    });
    expect(res.content[0].text).toContain('Effort set to "high"');
    expect(res.content[0].text).toContain('Thinking budget set to "medium"');
  });

  it('describes "reset" for effort + thinking_budget', async () => {
    const ctx = makeContext();
    const res = await buildSwitchModelTool(ctx).handler({
      model: 'reset',
      effort: 'reset',
      thinking_budget: 'reset',
    });
    expect(res.content[0].text).toContain('Effort reset to default');
    expect(res.content[0].text).toContain(
      'Thinking budget reset to default',
    );
  });
});

// --- buildAllTools ----------------------------------------------------

describe('buildAllTools', () => {
  it('builds every tool in a stable order', () => {
    const ctx = makeContext();
    const names = buildAllTools(ctx).map((t) => t.name);
    expect(names).toEqual([
      'send_message',
      'schedule_task',
      'list_tasks',
      'pause_task',
      'resume_task',
      'cancel_task',
      'update_task',
      'register_group',
      'switch_model',
    ]);
  });

  it('registerAllTools calls server.tool for each tool', async () => {
    const { registerAllTools } = await import('./register.js');
    const tool = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeServer = { tool } as any;
    registerAllTools(fakeServer, makeContext());
    expect(tool).toHaveBeenCalledTimes(9);
  });
});
