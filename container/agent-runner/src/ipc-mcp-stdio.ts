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

// Room API proxy URL (optional — set by container-runner when SELF_HOSTED_API_SECRET configured)
const roomApiUrl = process.env.ROOM_API_URL || '';

// ─── Room API HTTP helper ───────────────────────────────────────────────────

async function roomApiFetch(
  path: string,
  options: { method?: string; body?: string } = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!roomApiUrl) {
    return { ok: false, status: 503, data: { error: 'Room API not configured. Set SELF_HOSTED_API_SECRET in .env on the host.' } };
  }

  const url = `${roomApiUrl}${path}`;
  const method = options.method || 'GET';

  try {
    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: options.body,
      signal: AbortSignal.timeout(60_000),
    });

    let data: unknown;
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await resp.json();
    } else if (contentType.includes('audio') || contentType.includes('octet-stream')) {
      // Binary response — return size info, actual download handled by music_download
      data = { type: 'binary', contentType, size: resp.headers.get('content-length') };
    } else {
      data = { raw: await resp.text() };
    }

    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, data: { error: `Request failed: ${message}` } };
  }
}

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

// ─── Room Music Gen Tools ───────────────────────────────────────────────────

server.tool(
  'music_generate',
  `Generate an AI music track using Room's Music Gen service (ACE-Step).
Submit a job and get back a job_id to poll for completion.
Returns the job_id immediately — generation takes 30s-5min depending on duration.

Common genres: pop, rock, electronic, hip-hop, jazz, classical, lo-fi, ambient, synthwave, cinematic, chiptune
Moods: happy, sad, energetic, calm, dark, uplifting, melancholic, epic, dreamy, mysterious
Vocal types: "male vocal", "female vocal", "duet", "no vocal", "a cappella"
Tempos: very-slow, slow, moderate, fast, very-fast

For lyrics, use structure tags: [Verse 1], [Chorus], [Bridge], [Instrumental], [Intro], [Outro].
Use "[inst]" for purely instrumental tracks. Keep 6-10 syllables per line.`,
  {
    title: z.string().optional().describe('Track title'),
    genre: z.string().describe('Music genre (e.g. "lo-fi", "cinematic", "pop")'),
    mood: z.string().optional().describe('Emotional mood (e.g. "calm", "epic", "melancholic")'),
    vocal_type: z.string().optional().describe('Vocal style: "male vocal", "female vocal", "no vocal", etc.'),
    tempo: z.string().optional().describe('Speed: very-slow, slow, moderate, fast, very-fast'),
    bpm: z.number().optional().describe('Exact BPM (60-220)'),
    key: z.string().optional().describe('Musical key (e.g. "C major", "A minor")'),
    duration: z.number().default(60).describe('Length in seconds (30, 60, 90, 120, 180)'),
    instruments: z.array(z.string()).optional().describe('Instruments to use (e.g. ["piano", "guitar", "strings"])'),
    texture: z.array(z.string()).optional().describe('Production feel: warm, crisp, bright, dark, airy, punchy, lush, vintage'),
    lyrics: z.string().optional().describe('Song lyrics with structure tags [Verse], [Chorus], etc. Use "[inst]" for instrumental.'),
    prompt: z.string().optional().describe('Free-text description of desired music'),
  },
  async (args) => {
    const result = await roomApiFetch('/music-gen/jobs', {
      method: 'POST',
      body: JSON.stringify(args),
    });

    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Music generation failed (${result.status}): ${JSON.stringify(result.data)}` }],
        isError: true,
      };
    }

    const data = result.data as { job_id?: string };
    return {
      content: [{ type: 'text' as const, text: `Music generation job submitted!\nJob ID: ${data.job_id}\n\nUse music_status to check progress, then music_download when completed.` }],
    };
  },
);

server.tool(
  'music_status',
  'Check the status of a music generation job. Returns: queued, processing, completed, or failed.',
  {
    job_id: z.string().describe('The job ID returned by music_generate'),
  },
  async (args) => {
    const result = await roomApiFetch(`/music-gen/jobs/${args.job_id}`);

    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get status (${result.status}): ${JSON.stringify(result.data)}` }],
        isError: true,
      };
    }

    const data = result.data as { status?: string; queue_position?: number; progress?: number };
    const parts = [`Status: ${data.status}`];
    if (data.queue_position !== undefined) parts.push(`Queue position: ${data.queue_position}`);
    if (data.progress !== undefined) parts.push(`Progress: ${data.progress}%`);

    return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
  },
);

server.tool(
  'music_download',
  'Download the generated audio file (MP3) for a completed music job. Saves to the group workspace.',
  {
    job_id: z.string().describe('The job ID of a completed music generation job'),
    filename: z.string().optional().describe('Output filename (default: {job_id}.mp3). Saved to /workspace/group/'),
  },
  async (args) => {
    if (!roomApiUrl) {
      return {
        content: [{ type: 'text' as const, text: 'Room API not configured.' }],
        isError: true,
      };
    }

    const url = `${roomApiUrl}/music-gen/jobs/${args.job_id}/audio?format=mp3`;

    try {
      const resp = await fetch(url, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
        signal: AbortSignal.timeout(120_000),
      });

      if (!resp.ok) {
        return {
          content: [{ type: 'text' as const, text: `Download failed (${resp.status}). Job may still be processing — check music_status first.` }],
          isError: true,
        };
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const outName = args.filename || `${args.job_id}.mp3`;
      const outPath = path.join('/workspace/group', outName);
      fs.writeFileSync(outPath, buffer);

      const sizeMb = (buffer.length / (1024 * 1024)).toFixed(2);
      return {
        content: [{ type: 'text' as const, text: `Audio saved: ${outPath} (${sizeMb} MB)\nYou can share this file with the user via send_message.` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Download error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Room Facebook Page Manager Tools ───────────────────────────────────────

server.tool(
  'facebook_list_pages',
  'List all Facebook pages managed by the Room Facebook Page Manager service.',
  {},
  async () => {
    const result = await roomApiFetch('/facebook/pages');

    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Failed to list pages (${result.status}): ${JSON.stringify(result.data)}` }],
        isError: true,
      };
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
  },
);

server.tool(
  'facebook_approval_queue',
  'View the Facebook content approval queue. Shows posts/comments/messages waiting for human review before publishing.',
  {
    status: z.enum(['pending', 'approved', 'rejected']).default('pending').describe('Filter by approval status'),
  },
  async (args) => {
    const result = await roomApiFetch(`/facebook/approval?status=${args.status}`);

    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get approval queue (${result.status}): ${JSON.stringify(result.data)}` }],
        isError: true,
      };
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
  },
);

server.tool(
  'facebook_approval_action',
  'Approve, reject, or regenerate a Facebook content item in the approval queue.',
  {
    item_id: z.string().describe('The approval item ID'),
    action: z.enum(['approve', 'reject', 'regenerate']).describe('Action to take'),
    reason: z.string().optional().describe('Reason for rejection, or instructions for regeneration'),
  },
  async (args) => {
    const body = args.reason ? JSON.stringify({ reason: args.reason, instructions: args.reason }) : '{}';

    const result = await roomApiFetch(`/facebook/approval/${args.item_id}/${args.action}`, {
      method: 'POST',
      body,
    });

    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Action failed (${result.status}): ${JSON.stringify(result.data)}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: `${args.action} action completed for item ${args.item_id}.\n${JSON.stringify(result.data, null, 2)}` }],
    };
  },
);

server.tool(
  'facebook_health',
  'Check the health and status of the Facebook Page Manager service.',
  {},
  async () => {
    const result = await roomApiFetch('/facebook/health');
    return {
      content: [{ type: 'text' as const, text: result.ok
        ? `Facebook service healthy: ${JSON.stringify(result.data, null, 2)}`
        : `Facebook service unreachable (${result.status}): ${JSON.stringify(result.data)}` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
