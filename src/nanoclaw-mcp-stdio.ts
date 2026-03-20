/**
 * NanoClaw IPC MCP Server (host-side).
 * Provides send_message, task scheduling, host_exec, and group registration.
 * Runs as a stdio subprocess spawned by the Agent SDK.
 *
 * IPC files are written to NANOCLAW_IPC_DIR (per-group directory on host).
 * The host ipc.ts watcher processes these files.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/tmp/nanoclaw-ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

const server = new McpServer({ name: 'nanoclaw', version: '1.0.0' });

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name'),
  },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task.

CONTEXT MODE:
- "group": Task runs with chat history context.
- "isolated": Task runs in a fresh session.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
- cron: Standard cron expression (e.g., "0 9 * * *" for daily 9am)
- interval: Milliseconds between runs (e.g., "300000" for 5 minutes)
- once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00")`,
  {
    prompt: z.string().describe('What the agent should do'),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string(),
    context_mode: z.enum(['group', 'isolated']).default('group'),
    target_group_jid: z
      .string()
      .optional()
      .describe('(Main group only) Target group JID'),
  },
  async (args) => {
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      )
        return {
          content: [
            {
              type: 'text' as const,
              text: `Use local time without timezone suffix.`,
            },
          ],
          isError: true,
        };
      if (isNaN(new Date(args.schedule_value).getTime()))
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
    }

    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool('list_tasks', 'List all scheduled tasks.', {}, async () => {
  const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
  try {
    if (!fs.existsSync(tasksFile))
      return {
        content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }],
      };
    const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
    const tasks = isMain
      ? allTasks
      : allTasks.filter(
          (t: { groupFolder: string }) => t.groupFolder === groupFolder,
        );
    if (tasks.length === 0)
      return {
        content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }],
      };
    const formatted = tasks
      .map(
        (t: {
          id: string;
          prompt: string;
          schedule_type: string;
          schedule_value: string;
          status: string;
          next_run: string;
        }) =>
          `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
      )
      .join('\n');
    return {
      content: [
        { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
});

server.tool(
  'pause_task',
  'Pause a scheduled task.',
  {
    task_id: z.string(),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  {
    task_id: z.string(),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  {
    task_id: z.string(),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task.',
  {
    task_id: z.string(),
    prompt: z.string().optional(),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
    schedule_value: z.string().optional(),
  },
  async (args) => {
    if (args.schedule_type === 'cron' && args.schedule_value) {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }
    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;
    writeIpcFile(TASKS_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  'Register a new chat/group. Main group only.',
  {
    jid: z.string(),
    name: z.string(),
    folder: z.string(),
    trigger: z.string(),
  },
  async (args) => {
    if (!isMain)
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    writeIpcFile(TASKS_DIR, {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        { type: 'text' as const, text: `Group "${args.name}" registered.` },
      ],
    };
  },
);

server.tool(
  'host_exec',
  `Run a whitelisted command on the WSL host. Available commands:
  restart-nanoclaw, status-nanoclaw, logs-nanoclaw, build-nanoclaw,
  build-container, docker-ps, docker-images, git-status, git-log.`,
  { command: z.string().describe('Command name from the whitelist') },
  async (args) => {
    const requestId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'host_exec',
      command: args.command,
      requestId,
      timestamp: new Date().toISOString(),
    });

    const resultsDir = path.join(IPC_DIR, 'exec-results');
    const resultFile = path.join(resultsDir, `${requestId}.json`);
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      try {
        if (fs.existsSync(resultFile)) {
          const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
          fs.unlinkSync(resultFile);
          const output = [result.stdout, result.stderr]
            .filter(Boolean)
            .join('\n---stderr---\n');
          return {
            content: [{ type: 'text' as const, text: output || '(no output)' }],
            isError: !result.ok,
          };
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Timeout waiting for host command result',
        },
      ],
      isError: true,
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
