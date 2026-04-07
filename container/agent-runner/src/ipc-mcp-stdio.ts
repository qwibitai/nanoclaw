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
const canManageDevTasks = isMain || groupFolder.startsWith('ios_');

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

// --- Helpers for create_report ---

// Strip C0 control chars (except \t \n \r) from agent-supplied text. Same
// rule the host applies; doing it here too keeps the slug pipeline and the
// generated ID stable.
function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function slugifyTitle(title: string): string {
  const cleaned = stripControlChars(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, ''); // trim again after slice in case the cap landed inside a run
  return cleaned || 'report';
}

function todayISODate(): string {
  // Local-date YYYY-MM-DD prefix. Container's TZ env mirrors the host.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shortid(): string {
  // 6 chars of base36 — collision space ~2 billion, more than enough for
  // "two reports on the same topic on the same day".
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

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
  'get_calendar',
  `Get family calendar events. Returns events from iCloud family calendars and school calendars (6 months back through 6 months forward). Use this to answer questions about the calendar, upcoming events, past events, scheduling, and availability. This is a key source of family context — check it when questions touch on schedules, plans, or what's happening.`,
  {
    start_date: z.string().optional().describe('Filter: only events on or after this date (ISO 8601, e.g. "2026-04-01")'),
    end_date: z.string().optional().describe('Filter: only events before this date (ISO 8601, e.g. "2026-05-01")'),
  },
  async (args) => {
    const calendarFile = path.join(IPC_DIR, 'current_calendar.json');

    try {
      if (!fs.existsSync(calendarFile)) {
        return { content: [{ type: 'text' as const, text: 'No calendar data available. Calendar may not be configured.' }] };
      }

      const data = JSON.parse(fs.readFileSync(calendarFile, 'utf-8'));
      let events: Array<{
        id: string;
        summary: string;
        startDate: string;
        endDate: string | null;
        isAllDay: boolean;
        description: string | null;
        source: string;
      }> = data.events || [];

      if (events.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No calendar events available.' }] };
      }

      // Apply optional date filters
      if (args.start_date) {
        const start = new Date(args.start_date).toISOString();
        events = events.filter((e) => e.startDate >= start);
      }
      if (args.end_date) {
        const end = new Date(args.end_date).toISOString();
        events = events.filter((e) => e.startDate < end);
      }

      if (events.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No events found in that date range.' }] };
      }

      const formatted = events
        .map((e) => {
          const date = new Date(e.startDate);
          const dateStr = e.isAllDay
            ? date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
            : date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) +
              ' ' +
              date.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
          let line = `• ${dateStr} — ${e.summary}`;
          if (e.source) line += ` [${e.source}]`;
          if (e.description) line += `\n  ${e.description}`;
          return line;
        })
        .join('\n');

      return {
        content: [{ type: 'text' as const, text: `${events.length} events:\n\n${formatted}\n\nSnapshot: ${data.lastSync}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading calendar: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'create_dev_task',
  'Create a new dev task for tracking development work. Returns the created task ID.',
  {
    title: z.string().describe('Short title for the task'),
    description: z.string().optional().describe('Detailed description of what needs to be done'),
  },
  async (args) => {
    if (!canManageDevTasks) {
      return {
        content: [{ type: 'text' as const, text: 'Dev task management requires main group or FamBot.' }],
        isError: true,
      };
    }

    const data: Record<string, string | undefined> = {
      type: 'create_dev_task',
      title: args.title,
      description: args.description,
      targetJid: chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Dev task creation requested: "${args.title}"` }],
    };
  },
);

server.tool(
  'list_dev_tasks',
  'List all dev tasks, optionally filtered by status. Shows task ID, title, status, and branch/PR info.',
  {
    status: z.enum(['open', 'working', 'pr_ready', 'done', 'needs_session', 'has_followups']).optional().describe('Filter by status (omit for all tasks)'),
  },
  async (args) => {
    if (!canManageDevTasks) {
      return {
        content: [{ type: 'text' as const, text: 'Dev task management requires main group or FamBot.' }],
        isError: true,
      };
    }

    const devTasksFile = path.join(IPC_DIR, 'current_dev_tasks.json');

    try {
      if (!fs.existsSync(devTasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No dev tasks found.' }] };
      }

      const allTasks: Array<{
        id: number;
        title: string;
        status: string;
        branch?: string;
        pr_url?: string;
        created_at: string;
      }> = JSON.parse(fs.readFileSync(devTasksFile, 'utf-8'));

      const tasks = args.status
        ? allTasks.filter((t) => t.status === args.status)
        : allTasks;

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: args.status ? `No dev tasks with status "${args.status}".` : 'No dev tasks found.' }] };
      }

      const formatted = tasks
        .map((t) => {
          let line = `#${t.id} [${t.status}] ${t.title}`;
          if (t.branch) line += ` (${t.branch})`;
          if (t.pr_url) line += ` — ${t.pr_url}`;
          return line;
        })
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Dev tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading dev tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'update_dev_task',
  'Update an existing dev task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.number().describe('The dev task ID to update'),
    title: z.string().optional().describe('New title for the task'),
    description: z.string().optional().describe('New description for the task'),
  },
  async (args) => {
    if (!canManageDevTasks) {
      return {
        content: [{ type: 'text' as const, text: 'Dev task management requires main group or FamBot.' }],
        isError: true,
      };
    }

    if (!args.title && !args.description) {
      return {
        content: [{ type: 'text' as const, text: 'Nothing to update — provide at least title or description.' }],
        isError: true,
      };
    }

    const data: Record<string, string | number | undefined> = {
      type: 'update_dev_task',
      devTaskId: args.task_id,
      targetJid: chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    if (args.title !== undefined) data.title = args.title;
    if (args.description !== undefined) data.description = args.description;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Dev task #${args.task_id} update requested.` }],
    };
  },
);

server.tool(
  'create_report',
  `Write a Markdown report to the user's dashboard instead of dumping a long answer in chat. Use this when the answer would be:
  • Research, comparisons, or option analyses
  • Anything table-shaped (multiple options × multiple criteria)
  • Anything that would otherwise be longer than ~3 paragraphs of prose
  • A summary of multiple sources, sub-investigations, or sub-agent results

After calling this tool, your reply in chat should be ONE LINE summarizing what you found, followed by the URL the tool returned. DO NOT paste the body of the report into chat — that defeats the entire purpose. Trust that the user will open the URL.

Reports are transactional: they're produced once for a single conversation and read at the user's leisure. They're not knowledge-base entries, they're not maintained, and they're not actionable on their own.

If the user explicitly asks for a short inline answer ("just give me a one-liner"), give them one — don't write a report when they wanted a sentence.

GOOD title example: "Health insurance options: ABC vs XYZ vs DEF"
GOOD summary example: "ABC wins on price, XYZ on coverage breadth; DEF only worth it if you travel a lot."
BAD summary: "Here is a comparison of health insurance options." (says nothing)
BAD: pasting the report body into chat after writing it.`,
  {
    title: z
      .string()
      .min(1)
      .max(200)
      .describe('Short, descriptive title for the report (≤ 200 chars).'),
    summary: z
      .string()
      .max(200)
      .describe(
        'One-line summary that gives the user enough context to decide whether to open the report now (≤ 200 chars). Should NOT just restate the title — say what you found.',
      ),
    body_markdown: z
      .string()
      .min(1)
      .max(256 * 1024)
      .describe(
        'The full report body in GitHub-flavored Markdown. Use headings, lists, tables, code blocks, blockquotes, links. Do not include the title as an H1 — the dashboard renders it separately. Max 256 KB.',
      ),
  },
  async (args) => {
    const date = todayISODate();
    const slug = slugifyTitle(args.title);
    const id = `${date}-${slug}-${shortid()}`;

    const data = {
      type: 'create_report',
      id,
      title: stripControlChars(args.title),
      summary: stripControlChars(args.summary || ''),
      body_markdown: args.body_markdown,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const url = `/dashboard#reports/${id}`;
    return {
      content: [
        {
          type: 'text' as const,
          text: `Report created: ${url}\n\nReply to the user with a one-line summary and this URL. Do NOT paste the report body into chat.`,
        },
      ],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
