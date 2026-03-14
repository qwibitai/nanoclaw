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
import { memoryStore, memorySearch, memoryDelete, memoryCount, memoryList, memoryUpdate, memoryStatus } from './memory.js';
import { SmartExtractor } from './smart-extractor.js';
import { logLearning, logError } from './self-improvement-files.js';

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

// --- Semantic Memory Tools (LanceDB + Gemini embeddings) ---

server.tool(
  'memory_store',
  `Store a memory for long-term semantic recall. Use this to remember important facts, decisions, preferences, and context that should persist across sessions.

Categories:
- "profile": User identity, role, background
- "preferences": User preferences, settings, likes/dislikes
- "entities": Named entities (people, projects, tools, orgs)
- "events": Temporal events, milestones, incidents
- "cases": Problem-solution pairs, debugging sessions
- "patterns": Recurring behaviors, workflows, habits
Legacy aliases also work: "preference", "decision", "entity", "fact", "reflection", "other"

Importance: 0.0-1.0 (higher = more important to remember)`,
  {
    text: z.string().describe('The memory text to store (clear, self-contained statement)'),
    category: z.enum(['profile', 'preferences', 'entities', 'events', 'cases', 'patterns', 'preference', 'decision', 'entity', 'fact', 'reflection', 'other']).default('cases').describe('Memory category'),
    importance: z.number().min(0).max(1).default(0.7).describe('How important this memory is (0.0-1.0)'),
    scope: z.string().default('global').describe('Scope for memory isolation (e.g. group ID or topic). Defaults to "global".'),
  },
  async (args) => {
    try {
      const id = await memoryStore(args.text, args.category, args.importance, {}, args.scope);
      return { content: [{ type: 'text' as const, text: `Memory stored (${id}): "${args.text.slice(0, 80)}..."` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to store memory: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_search',
  'Search memories by semantic similarity. Returns the most relevant memories for a given query.',
  {
    query: z.string().describe('What to search for (natural language)'),
    limit: z.number().min(1).max(20).default(5).describe('Max results to return'),
    category: z.enum(['profile', 'preferences', 'entities', 'events', 'cases', 'patterns', 'preference', 'decision', 'entity', 'fact', 'reflection', 'other']).optional().describe('Filter by category'),
    scope: z.union([z.string(), z.array(z.string())]).default('global').describe('Scope filter for memory isolation. Pass a string or array of strings. Defaults to "global".'),
  },
  async (args) => {
    try {
      const results = await memorySearch(args.query, args.limit, args.category, args.scope);
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No memories found.' }] };
      }
      const formatted = results
        .map((r, i) => {
          const date = new Date(r.timestamp).toISOString().split('T')[0];
          const meta = JSON.parse(r.metadata || '{}');
          const extra = meta.l1_overview ? `\n   Detail: ${meta.l1_overview.slice(0, 200)}` : '';
          return `${i + 1}. [${r.category}] ${r.text}\n   ID: ${r.id} | Importance: ${r.importance} | Date: ${date} | Distance: ${r._distance.toFixed(3)}${extra}`;
        })
        .join('\n\n');
      return { content: [{ type: 'text' as const, text: `Found ${results.length} memories:\n\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Memory search failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_delete',
  'Delete a specific memory by ID.',
  {
    id: z.string().describe('The memory ID to delete'),
    scope: z.string().optional().describe('Scope to verify ownership. If provided, deletion fails if the memory belongs to a different scope.'),
  },
  async (args) => {
    try {
      await memoryDelete(args.id, args.scope);
      return { content: [{ type: 'text' as const, text: `Memory ${args.id} deleted.` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to delete memory: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_count',
  'Get the total number of stored memories.',
  {
    scope: z.string().optional().describe('Optional scope filter. If provided, counts only memories in this scope.'),
  },
  async (args) => {
    try {
      const count = await memoryCount(args.scope);
      return { content: [{ type: 'text' as const, text: `Total memories: ${count}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to count memories: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Memory List Tool ---

server.tool(
  'memory_list',
  'List stored memories with optional filters. Returns paginated results sorted by timestamp.',
  {
    scope: z.string().optional().describe('Filter by scope'),
    category: z.string().optional().describe('Filter by category (profile, preferences, entities, events, cases, patterns)'),
    limit: z.number().min(1).max(100).default(20).describe('Max results per page'),
    offset: z.number().min(0).default(0).describe('Pagination offset'),
  },
  async (args) => {
    try {
      const results = await memoryList(args.scope, args.category, args.limit, args.offset);
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No memories found.' }] };
      }
      const formatted = results.map((r, i) => {
        const date = new Date(r.timestamp).toISOString().split('T')[0];
        return `${args.offset + i + 1}. [${r.category}] ${r.text.slice(0, 120)}\n   ID: ${r.id} | Importance: ${r.importance} | Date: ${date}`;
      }).join('\n\n');
      return { content: [{ type: 'text' as const, text: `Memories (${args.offset + 1}-${args.offset + results.length}):\n\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to list memories: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Memory Status Tool ---

server.tool(
  'memory_status',
  'Get memory system stats: total count, tier distribution, category breakdown, FTS health.',
  {
    scope: z.string().optional().describe('Optional scope filter'),
  },
  async (args) => {
    try {
      const status = await memoryStatus(args.scope);
      const lines: string[] = [
        `Total memories: ${status.totalCount}`,
        '',
        'Tier distribution:',
        ...Object.entries(status.tierDistribution).map(([tier, count]) => `  ${tier}: ${count}`),
        '',
        'Category breakdown:',
        ...Object.entries(status.categoryCounts).map(([cat, count]) => `  ${cat}: ${count}`),
        '',
        'Scope breakdown:',
        ...Object.entries(status.scopeCounts).map(([scope, count]) => `  ${scope}: ${count}`),
        '',
        `FTS: supported=${status.ftsHealth.supported}, index=${status.ftsHealth.indexExists}${status.ftsHealth.lastError ? `, error: ${status.ftsHealth.lastError}` : ''}`,
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get status: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Memory Update Tool ---

server.tool(
  'memory_update',
  'Update an existing memory. Only provided fields are changed.',
  {
    id: z.string().describe('The memory ID to update'),
    text: z.string().optional().describe('New memory text (will re-embed)'),
    importance: z.number().min(0).max(1).optional().describe('New importance value'),
    category: z.string().optional().describe('New category'),
    scope: z.string().optional().describe('Scope to verify ownership'),
  },
  async (args) => {
    try {
      const updates: Record<string, unknown> = {};
      if (args.text !== undefined) updates.text = args.text;
      if (args.importance !== undefined) updates.importance = args.importance;
      if (args.category !== undefined) updates.category = args.category;

      const success = await memoryUpdate(args.id, updates, args.scope);
      if (!success) {
        return { content: [{ type: 'text' as const, text: `Memory ${args.id} not found or not accessible.` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `Memory ${args.id} updated.` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to update memory: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Memory Extract Tool ---

server.tool(
  'memory_extract',
  'Manually trigger smart memory extraction from conversation text. Requires EXTRACTION_PROVIDER to be configured.',
  {
    conversation_text: z.string().describe('The conversation text to extract memories from'),
    scope: z.string().default('global').describe('Scope for extracted memories'),
  },
  async (args) => {
    try {
      const extractor = SmartExtractor.getInstance();
      if (!extractor.isAvailable()) {
        return {
          content: [{ type: 'text' as const, text: 'Smart extraction is not available. Set EXTRACTION_PROVIDER to enable it.' }],
          isError: true,
        };
      }

      const stats = await extractor.extractAndPersist(args.conversation_text, args.scope);
      const lines = [
        `Extraction complete:`,
        `  Extracted: ${stats.extracted}`,
        `  Created: ${stats.created}`,
        `  Merged: ${stats.merged}`,
        `  Skipped: ${stats.skipped}`,
        `  Supported: ${stats.supported}`,
        `  Superseded: ${stats.superseded}`,
        `  Contradicted: ${stats.contradicted}`,
        `  Errors: ${stats.errors}`,
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Extraction failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Self-Improvement Log Tool ---

server.tool(
  'self_improvement_log',
  'Log a learning, error, pattern, or insight for self-improvement. Entries are stored in .learnings/ files.',
  {
    type: z.enum(['learning', 'error', 'pattern', 'insight']).describe('Type of entry'),
    text: z.string().describe('The learning or error description'),
    context: z.string().optional().describe('Optional context about when/why this was learned'),
  },
  async (args) => {
    try {
      if (args.type === 'error') {
        await logError(args.text, args.context);
      } else {
        await logLearning(args.text, args.type, args.context);
      }
      return { content: [{ type: 'text' as const, text: `${args.type} logged successfully.` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to log ${args.type}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
