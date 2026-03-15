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
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. When sender is set, the message appears from a distinct identity (agent swarm mode).",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a distinct identity in Discord (via webhook) and Slack (via username override). Channels without identity support show the name as a prefix.'),
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
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

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

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
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
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
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
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
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

server.tool(
  'set_group_model',
  `Set the default model for a registered group. Main group only.

Use this to configure which Claude model a group uses by default (e.g. "opus", "sonnet", "haiku", or a full model ID like "claude-opus-4-6"). Pass an empty string to clear the override and revert to the global default.`,
  {
    jid: z.string().describe('The JID of the group to update (e.g., "dc:1479489865702703155")'),
    model: z.string().describe('Model alias ("opus", "sonnet", "haiku") or full model ID. Empty string to clear.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can update group model.' }],
        isError: true,
      };
    }

    const data = {
      type: 'set_group_model',
      jid: args.jid,
      model: args.model,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const label = args.model || '(cleared — reverts to global default)';
    return {
      content: [{ type: 'text' as const, text: `Group model set to ${label} for JID ${args.jid}.` }],
    };
  },
);

server.tool(
  'set_group_notify_jid',
  `Set the notification channel JID for a registered group. Main group only.

When set, ship log and backlog notifications from that group will be sent to this JID *in addition to* the group's default channel. Useful for also routing notifications to a shared team channel (e.g. a Slack channel). Pass an empty string to clear.`,
  {
    jid: z.string().describe('The JID of the group whose notification target you want to configure (e.g., "dc:1479516831168593974" for the illysium Discord entry)'),
    notifyJid: z.string().describe('Target JID for notifications (e.g., "slack:C0AJA89MN2E"). Empty string to clear.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can configure notification channels.' }],
        isError: true,
      };
    }

    const data = {
      type: 'set_group_model',
      jid: args.jid,
      notifyJid: args.notifyJid,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const label = args.notifyJid || '(cleared — reverts to default channel)';
    return {
      content: [{ type: 'text' as const, text: `Notification channel set to ${label} for JID ${args.jid}.` }],
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

server.tool(
  'search_threads',
  `Search past conversation threads in this group by keyword or topic. Returns matching threads ranked by relevance.

Use this when you need to:
• Find a past discussion about a specific topic
• Recall context from a previous thread
• Reference earlier work or decisions
• Answer "did we discuss X before?"

Returns thread summaries with thread keys. Use read_thread_by_key to get full messages from a found thread.

Note: only threads with a generated summary are searchable. Very new or short threads that haven't been compacted may not appear in results.`,
  {
    query: z.string().describe('Search query — keywords or natural language description of the topic'),
    limit: z.number().max(20).optional().default(5).describe('Maximum number of results (default: 5, max: 20)'),
  },
  async (args) => {
    try {
      const requestId = writeQueryFile({
        type: 'search_threads',
        query: args.query,
        limit: args.limit,
      });

      const response = await waitForResponse(requestId) as {
        status: string;
        error?: string;
        results?: Array<{
          thread_key: string;
          thread_id: string;
          platform: string;
          topic_summary: string;
          last_activity: string;
        }>;
      };

      if (response.status !== 'ok') {
        return {
          content: [{ type: 'text' as const, text: `Error: ${response.error || 'Unknown error'}` }],
          isError: true,
        };
      }

      const results = response.results || [];
      if (results.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No threads found matching "${args.query}".` }],
        };
      }

      const formatted = results
        .map((r, i) => `${i + 1}. **${r.topic_summary}**\n   Thread: ${r.thread_id} (${r.platform})\n   Last active: ${r.last_activity}`)
        .join('\n\n');

      return {
        content: [{ type: 'text' as const, text: `Found ${results.length} matching thread(s):\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error searching threads: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'read_thread_by_key',
  `Read full messages from a thread using its thread_key (returned by search_threads).

This is the companion tool to search_threads. After finding relevant threads via search, use this tool to load the full conversation.

Workflow: search_threads → get thread_key → read_thread_by_key → full messages`,
  {
    thread_key: z.string().describe('Thread key from search_threads results (e.g., "illysium:thread:1773071476.205929")'),
    limit: z.number().optional().default(100).describe('Maximum number of messages to return (default: 100)'),
  },
  async (args) => {
    try {
      const requestId = writeQueryFile({
        type: 'read_thread_by_key',
        threadKey: args.thread_key,
        limit: args.limit,
      });

      const response = await waitForResponse(requestId) as {
        status: string;
        error?: string;
        chatJid?: string;
        threadKey?: string;
        messages?: Array<{ sender: string; content: string; timestamp: string; is_from_me: boolean }>;
      };

      if (response.status !== 'ok') {
        return {
          content: [{ type: 'text' as const, text: `Error: ${response.error || 'Unknown error'}` }],
          isError: true,
        };
      }

      const messages = response.messages || [];
      if (messages.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No messages found for thread ${args.thread_key}. The thread may have been archived or messages may have been purged.` }],
        };
      }

      const formatted = messages
        .map((m) => `[${m.timestamp}] ${m.sender}: ${m.content}`)
        .join('\n\n');

      return {
        content: [{ type: 'text' as const, text: `Messages from thread ${args.thread_key} (${messages.length} total):\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading thread: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'list_groups',
  `List all registered groups with their JIDs, folder names, triggers, and container configs.

Use this to understand the current NanoClaw deployment:
• Which channels/groups are registered
• What folder each group maps to
• Container configuration (mounts, tools, thread sessions)
• Trigger patterns and main group identification`,
  {},
  async () => {
    try {
      const requestId = writeQueryFile({
        type: 'list_groups',
      });

      const response = await waitForResponse(requestId) as {
        status: string;
        error?: string;
        groups?: Array<{
          jid: string;
          name: string;
          folder: string;
          trigger: string;
          isMain: boolean;
          requiresTrigger?: boolean;
          containerConfig?: object;
        }>;
      };

      if (response.status !== 'ok') {
        return {
          content: [{ type: 'text' as const, text: `Error: ${response.error || 'Unknown error'}` }],
          isError: true,
        };
      }

      const groups = response.groups || [];
      if (groups.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No registered groups found.' }],
        };
      }

      const formatted = groups
        .map((g) => {
          const flags = [
            g.isMain ? 'MAIN' : null,
            g.requiresTrigger === false ? 'no-trigger' : null,
          ].filter(Boolean).join(', ');
          const flagStr = flags ? ` [${flags}]` : '';
          const config = g.containerConfig ? `\n   Config: ${JSON.stringify(g.containerConfig)}` : '';
          return `- **${g.name}**${flagStr}\n   JID: ${g.jid}\n   Folder: ${g.folder}\n   Trigger: ${g.trigger}${config}`;
        })
        .join('\n\n');

      return {
        content: [{ type: 'text' as const, text: `Registered groups (${groups.length}):\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error listing groups: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Ship log and backlog tools ---

server.tool(
  'add_ship_log',
  'Record a shipped feature, fix, or improvement in the ship log. Call this when work is merged/deployed.',
  {
    title: z.string().describe('Short title of what was shipped (e.g. "Fix duplicate inbox triage", "Add thread search")'),
    description: z.string().optional().describe('More detail about what was shipped and why'),
    pr_url: z.string().optional().describe('GitHub PR URL if applicable'),
    branch: z.string().optional().describe('Branch name that was merged'),
    tags: z.array(z.string()).optional().describe('Tags for categorization (e.g. ["bugfix", "nanoclaw", "discord"])'),
  },
  async (args) => {
    const data = {
      type: 'add_ship_log',
      title: args.title,
      description: args.description,
      pr_url: args.pr_url,
      branch: args.branch,
      tags: args.tags ? JSON.stringify(args.tags) : undefined,
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Logged to ship log: "${args.title}"` }] };
  },
);

server.tool(
  'add_backlog_item',
  'Add an item to the debug/fix backlog. Use this to track bugs, issues, or improvements to address later.',
  {
    title: z.string().describe('Short description of the issue or task'),
    description: z.string().optional().describe('Full details, repro steps, or context'),
    priority: z.enum(['low', 'medium', 'high']).optional().default('medium').describe('Priority level'),
    tags: z.array(z.string()).optional().describe('Tags (e.g. ["discord", "session", "auth"])'),
    notes: z.string().optional().describe('Initial notes or observations'),
  },
  async (args) => {
    const data = {
      type: 'add_backlog_item',
      title: args.title,
      description: args.description,
      priority: args.priority,
      tags: args.tags ? JSON.stringify(args.tags) : undefined,
      notes: args.notes,
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Added to backlog: "${args.title}". Use list_backlog to find the assigned ID.` }] };
  },
);

server.tool(
  'update_backlog_item',
  'Update the status, priority, title, description, notes, or tags of a backlog item.',
  {
    item_id: z.string().describe('The backlog item ID (e.g. backlog-1234567890-abc123)'),
    status: z.enum(['open', 'in_progress', 'resolved', 'wont_fix']).optional().describe('New status'),
    priority: z.enum(['low', 'medium', 'high']).optional().describe('New priority'),
    title: z.string().optional().describe('Updated title'),
    description: z.string().optional().describe('Updated description'),
    notes: z.string().optional().describe('Progress notes or resolution details'),
    tags: z.array(z.string()).optional().describe('Updated tags (replaces existing tags)'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'update_backlog_item',
      itemId: args.item_id,
    };
    if (args.status !== undefined) data.status = args.status;
    if (args.priority !== undefined) data.priority = args.priority;
    if (args.title !== undefined) data.title = args.title;
    if (args.description !== undefined) data.description = args.description;
    if (args.notes !== undefined) data.notes = args.notes;
    if (args.tags !== undefined) data.tags = JSON.stringify(args.tags);
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Backlog item ${args.item_id} updated.` }] };
  },
);

server.tool(
  'delete_backlog_item',
  'Permanently delete a backlog item.',
  {
    item_id: z.string().describe('The backlog item ID to delete'),
  },
  async (args) => {
    const data = {
      type: 'delete_backlog_item',
      itemId: args.item_id,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Backlog item ${args.item_id} deleted.` }] };
  },
);

server.tool(
  'list_backlog',
  'List backlog items. Optionally filter by status. Returns items ordered by priority (high first).',
  {
    status: z.enum(['open', 'in_progress', 'resolved', 'wont_fix']).optional().describe('Filter by status. Omit to see all items (open + in_progress first).'),
    limit: z.number().max(50).optional().default(20).describe('Maximum items to return (default: 20, max: 50). Use a larger limit only when doing a full audit.'),
  },
  async (args) => {
    try {
      const requestId = writeQueryFile({
        type: 'list_backlog',
        status: args.status,
        limit: args.limit,
      });

      const response = await waitForResponse(requestId) as {
        status: string;
        error?: string;
        items?: Array<{
          id: string;
          title: string;
          description: string | null;
          status: string;
          priority: string;
          tags: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
          resolved_at: string | null;
        }>;
      };

      if (response.status !== 'ok') {
        return {
          content: [{ type: 'text' as const, text: `Error: ${response.error || 'Unknown error'}` }],
          isError: true,
        };
      }

      const items = response.items || [];
      if (items.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No backlog items found.' }] };
      }

      const formatted = items
        .map((item) => {
          let tagStr = '';
          if (item.tags) {
            try { tagStr = ` [${(JSON.parse(item.tags) as string[]).join(', ')}]`; } catch { /* malformed tags — skip */ }
          }
          const notes = item.notes ? `\n   Notes: ${item.notes}` : '';
          return `- [${item.id}] **${item.title}**${tagStr}\n   Status: ${item.status} | Priority: ${item.priority} | Created: ${item.created_at.slice(0, 10)}${notes}`;
        })
        .join('\n\n');

      return { content: [{ type: 'text' as const, text: `Backlog (${items.length} items):\n\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'list_ship_log',
  'View the ship log — recent features, fixes, and improvements that have been shipped.',
  {
    limit: z.number().optional().default(20).describe('Maximum entries to return (default: 20)'),
  },
  async (args) => {
    try {
      const requestId = writeQueryFile({
        type: 'list_ship_log',
        limit: args.limit,
      });

      const response = await waitForResponse(requestId) as {
        status: string;
        error?: string;
        entries?: Array<{
          id: string;
          title: string;
          description: string | null;
          pr_url: string | null;
          branch: string | null;
          tags: string | null;
          shipped_at: string;
        }>;
      };

      if (response.status !== 'ok') {
        return {
          content: [{ type: 'text' as const, text: `Error: ${response.error || 'Unknown error'}` }],
          isError: true,
        };
      }

      const entries = response.entries || [];
      if (entries.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Ship log is empty.' }] };
      }

      const formatted = entries
        .map((e) => {
          let tagStr = '';
          if (e.tags) {
            try { tagStr = ` [${(JSON.parse(e.tags) as string[]).join(', ')}]`; } catch { /* malformed tags — skip */ }
          }
          const pr = e.pr_url ? `\n   PR: ${e.pr_url}` : '';
          const desc = e.description ? `\n   ${e.description}` : '';
          return `- **${e.title}**${tagStr} — ${e.shipped_at.slice(0, 10)}${desc}${pr}`;
        })
        .join('\n\n');

      return { content: [{ type: 'text' as const, text: `Ship log (${entries.length} entries):\n\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
