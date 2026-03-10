/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
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
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
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
    // Validate schedule_value before writing IPC
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

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
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

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// --- Query helpers (request-response IPC) ---

const QUERIES_DIR = path.join(IPC_DIR, 'queries');
const RESPONSES_DIR = path.join(IPC_DIR, 'query_responses');
const QUERY_POLL_MS = 200;
const QUERY_TIMEOUT_MS = 10_000;

// Pre-create response dir so it's owned by this user (container uid).
// Host writes responses into it; we need write permission to unlink after reading.
fs.mkdirSync(RESPONSES_DIR, { recursive: true });

function writeQueryFile(data: object): string {
  fs.mkdirSync(QUERIES_DIR, { recursive: true });
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = `${requestId}.json`;
  const filepath = path.join(QUERIES_DIR, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ ...data, requestId }));
  fs.renameSync(tempPath, filepath);
  return requestId;
}

async function waitForResponse(requestId: string): Promise<object> {
  const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
  const deadline = Date.now() + QUERY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      const content = fs.readFileSync(responsePath, 'utf-8');
      try { fs.unlinkSync(responsePath); } catch { /* host will clean up */ }
      return JSON.parse(content);
    }
    await new Promise((resolve) => setTimeout(resolve, QUERY_POLL_MS));
  }
  throw new Error('Query timed out waiting for host response');
}

/**
 * Parse a Slack message URL into channel ID and thread timestamp.
 * Handles both thread links and standalone message links.
 */
function parseSlackUrl(url: string): { channelId: string; threadTs: string } | null {
  // https://workspace.slack.com/archives/C0AJA89MN2E/p1773071476205929
  // https://workspace.slack.com/archives/C0AJA89MN2E/p1773071476205929?thread_ts=1773071476.205929
  const archiveMatch = url.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/);
  if (!archiveMatch) return null;

  const channelId = archiveMatch[1];

  // Prefer explicit thread_ts from URL params
  const threadTsMatch = url.match(/[?&]thread_ts=([0-9.]+)/);
  if (threadTsMatch) {
    return { channelId, threadTs: threadTsMatch[1] };
  }

  // Convert p-timestamp to Slack ts: p1773071476205929 → 1773071476.205929
  const pTs = archiveMatch[2];
  const threadTs = pTs.slice(0, 10) + '.' + pTs.slice(10);
  return { channelId, threadTs };
}

/**
 * Parse a Discord message URL into guild, channel, and message IDs.
 * Format: https://discord.com/channels/{guildId}/{channelId}/{messageId}
 * The channelId may be a regular channel or a thread channel.
 */
function parseDiscordUrl(url: string): { channelId: string; messageId?: string } | null {
  const match = url.match(/https?:\/\/(?:ptb\.|canary\.)?discord\.com\/channels\/\d+\/(\d+)(?:\/(\d+))?/);
  if (!match) return null;
  return {
    channelId: match[1],
    messageId: match[2] || undefined,
  };
}

server.tool(
  'read_thread',
  `Read messages from a Slack thread or Discord channel/thread. Provide a message URL (copy link from Slack or Discord).
Returns the conversation including all replies.

Use this when you need to:
• Reference a discussion from another channel or thread
• Get context from a related conversation
• Investigate issues reported in other channels
• Answer questions about what was discussed elsewhere

Supports:
• Slack URLs: https://workspace.slack.com/archives/CHANNEL_ID/pTIMESTAMP
• Discord URLs: https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID`,
  {
    url: z.string().describe('Slack or Discord message URL'),
    limit: z.number().optional().default(50).describe('Maximum number of messages to return (default: 50)'),
  },
  async (args) => {
    // Detect URL type and route accordingly
    const slackParsed = parseSlackUrl(args.url);
    const discordParsed = parseDiscordUrl(args.url);

    if (!slackParsed && !discordParsed) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid URL. Provide a Slack URL (https://workspace.slack.com/archives/...) or Discord URL (https://discord.com/channels/...)' }],
        isError: true,
      };
    }

    try {
      let requestId: string;

      if (slackParsed) {
        requestId = writeQueryFile({
          type: 'read_thread',
          channelId: slackParsed.channelId,
          threadTs: slackParsed.threadTs,
          limit: args.limit,
        });
      } else {
        requestId = writeQueryFile({
          type: 'read_discord',
          channelId: discordParsed!.channelId,
          messageId: discordParsed!.messageId,
          limit: args.limit,
        });
      }

      const response = await waitForResponse(requestId) as {
        status: string;
        error?: string;
        chatJid?: string;
        threadJid?: string;
        messages?: Array<{ sender: string; content: string; timestamp: string; is_from_me: boolean }>;
      };

      if (response.status !== 'ok') {
        return {
          content: [{ type: 'text' as const, text: `Error: ${response.error || 'Unknown error'}` }],
          isError: true,
        };
      }

      const messages = response.messages || [];
      const jid = response.chatJid || response.threadJid || 'unknown';
      if (messages.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No messages found (${jid}). The channel may not be monitored or may have no stored messages.` }],
        };
      }

      const formatted = messages
        .map((m) => `[${m.timestamp}] ${m.sender}: ${m.content}`)
        .join('\n\n');

      return {
        content: [{ type: 'text' as const, text: `Messages (${messages.length} total from ${jid}):\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading messages: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
