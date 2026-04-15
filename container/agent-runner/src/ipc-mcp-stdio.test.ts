import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── helpers ────────────────────────────────────────────────────

let tmpDir: string;
let ipcDir: string;
let groupDir: string;
let tasksDir: string;
let messagesDir: string;

function tmpIpcDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
  return dir;
}

async function createClient(
  env: Record<string, string>,
): Promise<Client> {
  const serverPath = path.resolve(
    import.meta.dirname,
    '../dist/ipc-mcp-stdio.js',
  );
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: 'test', version: '0.0.1' });
  await client.connect(transport);
  return client;
}

function readIpcFiles(dir: string): object[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
}

function defaultEnv(): Record<string, string> {
  return {
    NANOCLAW_IPC_DIR: ipcDir,
    NANOCLAW_GROUP_DIR: groupDir,
    NANOCLAW_CHAT_JID: 'tg:123',
    NANOCLAW_GROUP_FOLDER: 'telegram_main',
    NANOCLAW_IS_MAIN: '1',
  };
}

// ─── setup ──────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = tmpIpcDir();
  ipcDir = tmpDir;
  groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-group-'));
  tasksDir = path.join(tmpDir, 'tasks');
  messagesDir = path.join(tmpDir, 'messages');
});

// ─── schedule_task ──────────────────────────────────────────────

describe('schedule_task', () => {
  it('writes IPC file with correct fields for cron task', async () => {
    const client = await createClient(defaultEnv());
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

      const files = readIpcFiles(tasksDir);
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
    const client = await createClient(defaultEnv());
    try {
      await client.callTool({
        name: 'schedule_task',
        arguments: {
          prompt: 'check status',
          schedule_type: 'interval',
          schedule_value: '300000',
        },
      });

      const files = readIpcFiles(tasksDir);
      expect(files).toHaveLength(1);
      const data = files[0] as Record<string, unknown>;
      expect(data.schedule_type).toBe('interval');
      expect(data.schedule_value).toBe('300000');
      expect(data.context_mode).toBe('group'); // default
    } finally {
      await client.close();
    }
  });

  it('rejects invalid cron expression', async () => {
    const client = await createClient(defaultEnv());
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
    const client = await createClient(defaultEnv());
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
    const client = await createClient(defaultEnv());
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
    const client = await createClient(defaultEnv());
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
    const client = await createClient(defaultEnv());
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
      const files = readIpcFiles(tasksDir);
      expect(files).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it('omits taskName when name is not provided', async () => {
    const client = await createClient(defaultEnv());
    try {
      await client.callTool({
        name: 'schedule_task',
        arguments: {
          prompt: 'no name task',
          schedule_type: 'cron',
          schedule_value: '0 9 * * *',
        },
      });

      const files = readIpcFiles(tasksDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.taskName).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});

// ─── update_task ────────────────────────────────────────────────

describe('update_task', () => {
  it('writes IPC file with name update', async () => {
    const client = await createClient(defaultEnv());
    try {
      await client.callTool({
        name: 'update_task',
        arguments: {
          task_id: 'task-123',
          name: 'new-name',
        },
      });

      const files = readIpcFiles(tasksDir);
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
    const client = await createClient(defaultEnv());
    try {
      await client.callTool({
        name: 'update_task',
        arguments: {
          task_id: 'task-456',
          prompt: 'updated prompt',
          model: 'haiku',
        },
      });

      const files = readIpcFiles(tasksDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.prompt).toBe('updated prompt');
      expect(data.model).toBe('haiku');
      expect(data.taskName).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('clears name with empty string', async () => {
    const client = await createClient(defaultEnv());
    try {
      await client.callTool({
        name: 'update_task',
        arguments: {
          task_id: 'task-789',
          name: '',
        },
      });

      const files = readIpcFiles(tasksDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.taskName).toBe('');
    } finally {
      await client.close();
    }
  });

  it('rejects invalid cron in update', async () => {
    const client = await createClient(defaultEnv());
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
    const client = await createClient(defaultEnv());
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

// ─── list_tasks ─────────────────────────────────────────────────

describe('list_tasks', () => {
  it('reports file not found when no snapshot file exists', async () => {
    const client = await createClient(defaultEnv());
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
      path.join(groupDir, 'current_tasks.json'),
      JSON.stringify(snapshot),
    );

    const client = await createClient(defaultEnv());
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
      path.join(groupDir, 'current_tasks.json'),
      JSON.stringify(snapshot),
    );

    const client = await createClient(defaultEnv());
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
      path.join(groupDir, 'current_tasks.json'),
      JSON.stringify(snapshot),
    );

    const client = await createClient({
      ...defaultEnv(),
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

// ─── send_message ───────────────────────────────────────────────

describe('send_message', () => {
  it('writes IPC message file', async () => {
    const client = await createClient(defaultEnv());
    try {
      const result = await client.callTool({
        name: 'send_message',
        arguments: { text: 'Hello world' },
      });

      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('sent');

      const files = readIpcFiles(messagesDir);
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
    const client = await createClient(defaultEnv());
    try {
      await client.callTool({
        name: 'send_message',
        arguments: { text: 'Update', sender: 'Researcher' },
      });

      const files = readIpcFiles(messagesDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.sender).toBe('Researcher');
    } finally {
      await client.close();
    }
  });
});

// ─── pause_task / resume_task / cancel_task ─────────────────────

describe('pause_task', () => {
  it('writes pause IPC file', async () => {
    const client = await createClient(defaultEnv());
    try {
      await client.callTool({
        name: 'pause_task',
        arguments: { task_id: 'task-abc' },
      });

      const files = readIpcFiles(tasksDir);
      expect(files).toHaveLength(1);
      const data = files[0] as Record<string, unknown>;
      expect(data.type).toBe('pause_task');
      expect(data.taskId).toBe('task-abc');
    } finally {
      await client.close();
    }
  });
});

describe('resume_task', () => {
  it('writes resume IPC file', async () => {
    const client = await createClient(defaultEnv());
    try {
      await client.callTool({
        name: 'resume_task',
        arguments: { task_id: 'task-abc' },
      });

      const files = readIpcFiles(tasksDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.type).toBe('resume_task');
    } finally {
      await client.close();
    }
  });
});

describe('cancel_task', () => {
  it('writes cancel IPC file', async () => {
    const client = await createClient(defaultEnv());
    try {
      await client.callTool({
        name: 'cancel_task',
        arguments: { task_id: 'task-abc' },
      });

      const files = readIpcFiles(tasksDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.type).toBe('cancel_task');
    } finally {
      await client.close();
    }
  });
});

// ─── register_group ─────────────────────────────────────────────

describe('register_group', () => {
  it('rejects when not main', async () => {
    const client = await createClient({
      ...defaultEnv(),
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
    const client = await createClient(defaultEnv());
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

      const files = readIpcFiles(tasksDir);
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

// ─── switch_model ───────────────────────────────────────────────

describe('switch_model', () => {
  it('writes model switch IPC file', async () => {
    const client = await createClient(defaultEnv());
    try {
      const result = await client.callTool({
        name: 'switch_model',
        arguments: { model: 'opus' },
      });

      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain('opus');

      const files = readIpcFiles(tasksDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.type).toBe('switch_model');
      expect(data.model).toBe('opus');
    } finally {
      await client.close();
    }
  });

  it('handles reset', async () => {
    const client = await createClient(defaultEnv());
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
    const client = await createClient(defaultEnv());
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

      const files = readIpcFiles(tasksDir);
      const data = files[0] as Record<string, unknown>;
      expect(data.effort).toBe('high');
      expect(data.thinking_budget).toBe('medium');
    } finally {
      await client.close();
    }
  });
});
