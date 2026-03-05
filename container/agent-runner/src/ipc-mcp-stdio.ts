/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, communicates with host via WebSocket.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { WsClient } from './ws-client.js';

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const wsUrl = process.env.NANOCLAW_WS_URL;
const wsToken = process.env.NANOCLAW_WS_TOKEN;

if (!chatJid || !groupFolder || !wsUrl || !wsToken) {
  console.error(
    `[ipc-mcp] Missing required env vars: ${['NANOCLAW_CHAT_JID', 'NANOCLAW_GROUP_FOLDER', 'NANOCLAW_WS_URL', 'NANOCLAW_WS_TOKEN'].filter((k) => !process.env[k]).join(', ')}`,
  );
  process.exit(1);
}

// Create WS client for communicating with the host
const wsClient = new WsClient(wsUrl, wsToken, 'mcp');

// Connect with a single retry for transient startup timing issues
async function connectWithRetry(): Promise<void> {
  try {
    await wsClient.connect();
  } catch (err) {
    console.error(`[ipc-mcp] WS connect failed, retrying in 1s: ${err instanceof Error ? err.message : String(err)}`);
    await new Promise((r) => setTimeout(r, 1000));
    await wsClient.connect();
  }
}

const wsConnectPromise = connectWithRetry().catch((err) => {
  const msg = `WS connect failed after retry: ${err instanceof Error ? err.message : String(err)}`;
  console.error(`[ipc-mcp] ${msg}`);
  throw new Error(msg);
});

async function ensureWs(): Promise<void> {
  await wsConnectPromise;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    await ensureWs();
    try {
      await wsClient.sendMessage(chatJid, args.text, args.sender || undefined);
      return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to send message: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before sending
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    await ensureWs();
    try {
      const resp = await wsClient.request('schedule_task', {
        prompt: args.prompt,
        schedule_type: args.schedule_type,
        schedule_value: args.schedule_value,
        context_mode: args.context_mode || 'group',
        targetJid,
      });
      return {
        content: [{ type: 'text' as const, text: `Task scheduled (${resp.taskId}): ${args.schedule_type} - ${args.schedule_value}` }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to schedule task: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    await ensureWs();
    try {
      const tasks = await wsClient.listTasks();

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string | null }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error listing tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    await ensureWs();
    try {
      await wsClient.request('pause_task', { taskId: args.task_id });
      return { content: [{ type: 'text' as const, text: `Task ${args.task_id} paused.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to pause task: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    await ensureWs();
    try {
      await wsClient.request('resume_task', { taskId: args.task_id });
      return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resumed.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to resume task: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    await ensureWs();
    try {
      await wsClient.request('cancel_task', { taskId: args.task_id });
      return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancelled.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to cancel task: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

The groups data provided when the agent connects includes available groups with their JIDs. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    await ensureWs();
    try {
      await wsClient.request('register_group', {
        jid: args.jid,
        name: args.name,
        folder: args.folder,
        trigger: args.trigger,
      });
      return {
        content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to register group: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
