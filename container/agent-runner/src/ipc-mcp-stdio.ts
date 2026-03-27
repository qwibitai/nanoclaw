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
const BRAIN_DIR = path.join(IPC_DIR, 'brain');
const BRAIN_RESPONSES_DIR = path.join(IPC_DIR, 'brain-responses');

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
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
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
    script: z.string().optional().describe('Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.'),
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
      script: args.script || undefined,
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
    script: z.string().optional().describe('New script for the task. Set to empty string to remove the script.'),
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
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.

Set listen_only=true for groups that Alfred should monitor passively — messages are stored in the database for intelligence gathering but no agent is ever spawned in response to messages.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requires_trigger: z.boolean().optional().describe('Whether trigger prefix is needed (default: true). Set false for always-active groups.'),
    listen_only: z.boolean().optional().describe('If true, messages are stored for intelligence gathering but no agent is spawned. Use for external groups you want to monitor.'),
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
      requiresTrigger: args.requires_trigger,
      listenOnly: args.listen_only,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const mode = args.listen_only
      ? 'listen-only (passive monitoring, no agent responses)'
      : args.requires_trigger === false
        ? 'always-active (responds to all messages)'
        : 'trigger-based (responds to @trigger messages)';

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered in ${mode} mode. Folder: ${args.folder}` }],
    };
  },
);

// --- Central Brain tools ---

server.tool(
  'brain_add',
  `Add an entry to the central intelligence brain — a shared knowledge store accessible across all groups.

Use this when you identify:
- *decision*: A key decision made (by the user or team)
- *action_item*: A task or follow-up that needs to happen
- *insight*: A useful piece of information or pattern discovered
- *follow_up*: Something that needs to be checked on or revisited later

Entries are stored in SQLite and synced to markdown files readable by all group agents.`,
  {
    entry_type: z
      .enum(['decision', 'action_item', 'insight', 'follow_up'])
      .describe('Type of intelligence entry'),
    content: z.string().describe('The entry content — be specific and actionable'),
    status: z
      .enum(['open', 'done', 'cancelled'])
      .default('open')
      .describe('Status of the entry (default: open)'),
    metadata: z
      .string()
      .optional()
      .describe('Optional JSON metadata (e.g., due date, owner, priority)'),
  },
  async (args) => {
    fs.mkdirSync(BRAIN_DIR, { recursive: true });

    const data = {
      type: 'brain_add',
      entry_type: args.entry_type,
      content: args.content,
      status: args.status || 'open',
      source_group: groupFolder,
      metadata: args.metadata || undefined,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(BRAIN_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Brain entry added: [${args.entry_type}] ${args.content.slice(0, 80)}${args.content.length > 80 ? '...' : ''}` }],
    };
  },
);

server.tool(
  'brain_query',
  `Query the central intelligence brain for entries across all groups.

Returns entries matching the filters, ordered by most recent first. Use this to:
- Retrieve open action items before starting work
- Find past decisions relevant to the current discussion
- Get a cross-group intelligence summary
- Check follow-ups from other groups`,
  {
    entry_type: z
      .enum(['decision', 'action_item', 'insight', 'follow_up'])
      .optional()
      .describe('Filter by entry type'),
    source_group: z
      .string()
      .optional()
      .describe('Filter by source group folder (e.g., "whatsapp_cos")'),
    status: z
      .enum(['open', 'done', 'cancelled'])
      .optional()
      .describe('Filter by status (default: all)'),
    since: z
      .string()
      .optional()
      .describe('Only return entries created after this ISO timestamp'),
    limit: z
      .number()
      .default(50)
      .describe('Maximum number of entries to return (default: 50)'),
  },
  async (args) => {
    // Write a brain_query IPC file and wait briefly for the response
    fs.mkdirSync(BRAIN_DIR, { recursive: true });
    fs.mkdirSync(BRAIN_RESPONSES_DIR, { recursive: true });

    const queryId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'brain_query',
      queryId,
      entry_type: args.entry_type,
      source_group: args.source_group,
      status: args.status,
      since: args.since,
      limit: args.limit || 50,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(BRAIN_DIR, data);

    // Poll for response file (host writes to brain-responses/ dir)
    const responsePattern = path.join(BRAIN_RESPONSES_DIR);
    let entries: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const files = fs.readdirSync(responsePattern).filter((f) => f.endsWith('.json'));
        if (files.length > 0) {
          // Take the newest file
          const sorted = files.sort();
          const responseFile = path.join(responsePattern, sorted[sorted.length - 1]);
          entries = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          // Clean up all response files
          for (const f of files) {
            try { fs.unlinkSync(path.join(responsePattern, f)); } catch { /* ignore */ }
          }
          break;
        }
      } catch { /* dir not ready yet */ }
    }

    if (entries.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No brain entries found matching the filters.' }],
      };
    }

    const formatted = (entries as Array<{
      id: string;
      source_group: string;
      entry_type: string;
      content: string;
      status: string;
      created_at: string;
    }>)
      .map((e) => `[${e.id}] *${e.entry_type}* (${e.source_group}) [${e.status}]\n${e.content}\n→ ${e.created_at.slice(0, 10)}`)
      .join('\n\n');

    return {
      content: [{ type: 'text' as const, text: `Brain entries (${entries.length}):\n\n${formatted}` }],
    };
  },
);

server.tool(
  'brain_update',
  'Update an existing brain entry — change its status, correct its content, or add metadata.',
  {
    entry_id: z.string().describe('The brain entry ID (from brain_query results)'),
    status: z
      .enum(['open', 'done', 'cancelled'])
      .optional()
      .describe('New status'),
    content: z.string().optional().describe('Updated content'),
    metadata: z.string().optional().describe('Updated JSON metadata'),
  },
  async (args) => {
    fs.mkdirSync(BRAIN_DIR, { recursive: true });

    const data = {
      type: 'brain_update',
      entryId: args.entry_id,
      status: args.status,
      content: args.content,
      metadata: args.metadata,
      sourceGroup: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(BRAIN_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Brain entry ${args.entry_id} update requested.` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
