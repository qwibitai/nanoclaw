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

const WORKSPACE_ROOT = process.env.NANOCLAW_WORKSPACE || '/workspace';
const IPC_DIR = path.join(WORKSPACE_ROOT, 'ipc');
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

// ---------------------------------------------------------------------------
// Learning Map API tools
// ---------------------------------------------------------------------------

const LEARNING_MAP_API_URL = process.env.LEARNING_MAP_API_URL || '';
const LEARNING_MAP_API_KEY = process.env.LEARNING_MAP_API_KEY || '';
const DEFAULT_STUDENT_ID = process.env.OLIVIA_STUDENT_ID || '32c76bee-d061-4fd5-a6b7-c37ce4e8e917';

async function learningMapFetch(path: string, options?: RequestInit): Promise<unknown> {
  const url = `${LEARNING_MAP_API_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': LEARNING_MAP_API_KEY,
      ...(options?.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Learning Map API ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

server.tool(
  'learning_map_query_context',
  'Query the Learning Map for objectives related to a topic. Returns related objectives with mastery levels, outer fringe (next things to learn), and connections.',
  {
    query: z.string().describe('The topic or question to search for'),
    student_id: z.string().optional().describe('Student ID (defaults to Olivia)'),
  },
  async (args) => {
    try {
      const sid = args.student_id || DEFAULT_STUDENT_ID;
      const params = new URLSearchParams({ query: args.query, student_id: sid });
      // Try /objectives/context first, fall back to /objectives/search
      let result: unknown;
      try {
        result = await learningMapFetch(`/objectives/context?${params}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('404') || msg.includes('Not Found')) {
          result = await learningMapFetch(`/objectives/search?${params}`);
        } else {
          throw err;
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'learning_map_record_interaction',
  'Record a learning interaction (practice, exposure, or assessment) for a student. The API auto-creates new objectives if objective_text doesn\'t match an existing one (similarity < 0.5), so you can freely record interactions for ANY topic — curriculum or organic/emergent learning. Just describe what she learned in objective_text.',
  {
    objective_text: z.string().describe('The learning objective text'),
    interaction_type: z.enum(['practice', 'exposure', 'assessment']).describe('Type of interaction'),
    outcome: z.object({}).passthrough().describe('Outcome data (e.g. { "score": 0.8, "notes": "..." })'),
    student_id: z.string().optional().describe('Student ID (defaults to Olivia)'),
  },
  async (args) => {
    try {
      const result = await learningMapFetch('/interactions/', {
        method: 'POST',
        body: JSON.stringify({
          student_id: args.student_id || DEFAULT_STUDENT_ID,
          objective_text: args.objective_text,
          interaction_type: args.interaction_type,
          outcome: args.outcome,
          source: 'telegram_agent',
        }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'learning_map_get_recommendations',
  'Get prioritized learning objective recommendations for a student.',
  {
    student_id: z.string().optional().describe('Student ID (defaults to Olivia)'),
    limit: z.number().optional().describe('Max recommendations to return (default 5)'),
  },
  async (args) => {
    try {
      const sid = args.student_id || DEFAULT_STUDENT_ID;
      const limit = args.limit || 5;
      const result = await learningMapFetch(`/mastery/student/${sid}/recommendations?limit=${limit}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'learning_map_get_mastery_summary',
  'Get the full mastery state for a student — all objectives and their mastery levels.',
  {
    student_id: z.string().optional().describe('Student ID (defaults to Olivia)'),
  },
  async (args) => {
    try {
      const sid = args.student_id || DEFAULT_STUDENT_ID;
      const result = await learningMapFetch(`/mastery/student/${sid}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'learning_map_search_resources',
  'Search for learning resources by topic, type, or keyword.',
  {
    query: z.string().describe('Search query'),
    resource_type: z.string().optional().describe('Filter by type (e.g. "video", "article", "worksheet")'),
    limit: z.number().optional().describe('Max results (default 5)'),
  },
  async (args) => {
    try {
      const params = new URLSearchParams({ query: args.query });
      if (args.resource_type) params.set('resource_type', args.resource_type);
      params.set('limit', String(args.limit || 5));
      const result = await learningMapFetch(`/resources/search?${params}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'learning_map_add_resource',
  'Add a learning resource to the Learning Map. Supports photos (with base64 image), textbook pages, homework, physical items (toys, Lego sets, books), and more. The API auto-generates embeddings for semantic search and auto-links to matching learning objectives.',
  {
    title: z.string().describe('Resource title (e.g. "Lego Technic Simple Machines Set", "Mathe-Hausaufgabe Brüche")'),
    description: z.string().describe('Detailed description of the resource and what it can be used for'),
    resource_type: z.string().describe('Type: "book_page", "homework", "drawing", "toy", "lego_set", "bookshelf", "art_supply", "book", "photo", "youtube_video", "article", "exercise", "game", "other"'),
    tags: z.array(z.string()).optional().describe('Tags for categorization (e.g. ["lego", "stem", "building"])'),
    source_url: z.string().optional().describe('URL if applicable'),
    extracted_text: z.string().optional().describe('Extracted/OCR text content from the resource'),
    objective_texts: z.array(z.string()).optional().describe('Related learning objective descriptions — auto-matched to existing objectives'),
    image_base64: z.string().optional().describe('Base64-encoded image data (for photos of physical resources, homework, etc.)'),
    added_by: z.string().default('agent').describe('Who added: "parent", "agent", or "student"'),
  },
  async (args) => {
    try {
      const result = await learningMapFetch('/resources/', {
        method: 'POST',
        body: JSON.stringify({
          title: args.title,
          description: args.description,
          resource_type: args.resource_type,
          tags: args.tags,
          source_url: args.source_url,
          extracted_text: args.extracted_text,
          objective_texts: args.objective_texts,
          image_base64: args.image_base64,
          added_by: args.added_by || 'agent',
        }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'learning_map_get_learning_map',
  'Get the hierarchical learning map showing all domains, subjects, and objectives with mastery.',
  {
    student_id: z.string().optional().describe('Student ID (defaults to Olivia)'),
  },
  async (args) => {
    try {
      const sid = args.student_id || DEFAULT_STUDENT_ID;
      const result = await learningMapFetch(`/mastery/student/${sid}/learning-map`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Image generation tool (Gemini)
// ---------------------------------------------------------------------------

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

server.tool(
  'generate_image',
  'Generate an educational illustration using Gemini. Images are optimized for an 11-year-old learner. Returns the image as a base64-encoded PNG that can be sent via Telegram.',
  {
    prompt: z.string().describe('What to illustrate (e.g. "diagram of the water cycle", "visual puzzle about fractions")'),
  },
  async (args) => {
    if (!GEMINI_API_KEY) {
      return { content: [{ type: 'text' as const, text: 'Error: GEMINI_API_KEY not configured' }], isError: true };
    }

    const fullPrompt = `Educational illustration for an 11-year-old. Clear, colorful, labeled. ${args.prompt}`;

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }],
            generationConfig: {
              responseModalities: ['IMAGE', 'TEXT'],
              responseMimeType: 'image/png',
            },
          }),
        },
      );

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
      }

      const data = await res.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              inlineData?: { mimeType: string; data: string };
              text?: string;
            }>;
          };
        }>;
      };

      const parts = data.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p) => p.inlineData?.data);

      if (!imagePart?.inlineData) {
        const textPart = parts.find((p) => p.text);
        return {
          content: [{ type: 'text' as const, text: `Image generation failed. Model response: ${textPart?.text || 'No output'}` }],
          isError: true,
        };
      }

      // Write image to temp file so agent can send it via Telegram
      const imgPath = `/tmp/generated-${Date.now()}.png`;
      fs.writeFileSync(imgPath, Buffer.from(imagePart.inlineData.data, 'base64'));

      return {
        content: [
          { type: 'text' as const, text: `Image generated and saved to ${imgPath}. Use this path to send via Telegram.` },
          {
            type: 'image' as const,
            data: imagePart.inlineData.data,
            mimeType: 'image/png',
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error generating image: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// YouTube transcript tool
// ---------------------------------------------------------------------------

function extractVideoId(url: string): string | null {
  const patterns = [
    /youtu\.be\/([^?&#]+)/,
    /youtube\.com\/watch\?.*v=([^&#]+)/,
    /youtube\.com\/embed\/([^?&#]+)/,
    /youtube\.com\/v\/([^?&#]+)/,
    /youtube\.com\/shorts\/([^?&#]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  // Could be a raw video ID
  return /^[a-zA-Z0-9_-]{11}$/.test(url) ? url : null;
}

/**
 * Fetch transcript using youtubei.js (InnerTube API).
 * Falls back to raw InnerTube ANDROID client if youtubei.js fails.
 */
async function fetchYouTubeTranscript(videoId: string): Promise<{
  title: string;
  transcript: Array<{ text: string; startMs: number }>;
  language: string;
}> {
  // Primary: youtubei.js
  try {
    const { Innertube } = await import('youtubei.js');
    const youtube = await Innertube.create();
    const info = await youtube.getInfo(videoId);
    const title = info.basic_info.title || 'Unknown';

    const transcriptData = await info.getTranscript();
    const body = (transcriptData as unknown as {
      transcript?: { content?: { body?: { initial_segments?: Array<{
        snippet?: { text?: string };
        start_ms?: string | number;
      }> } } };
    }).transcript?.content?.body;
    const segments = body?.initial_segments || [];

    const transcript = segments
      .filter((s) => s.snippet?.text)
      .map((s) => ({
        text: s.snippet!.text!,
        startMs: typeof s.start_ms === 'string' ? parseInt(s.start_ms, 10) : (s.start_ms || 0),
      }));

    if (transcript.length === 0) {
      throw new Error('No transcript segments found');
    }

    return { title, transcript, language: 'auto' };
  } catch (primaryErr) {
    const errMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);

    // Fallback: raw InnerTube ANDROID client
    try {
      const playerRes = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'ANDROID',
              clientVersion: '20.10.38',
              androidSdkVersion: 30,
            },
          },
          videoId,
        }),
      });

      if (!playerRes.ok) {
        throw new Error(`InnerTube player returned ${playerRes.status}`);
      }

      const playerData = await playerRes.json() as {
        videoDetails?: { title?: string };
        captions?: {
          playerCaptionsTracklistRenderer?: {
            captionTracks?: Array<{
              baseUrl?: string;
              languageCode?: string;
              kind?: string;
            }>;
          };
        };
      };

      const title = playerData.videoDetails?.title || 'Unknown';
      const tracks = playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

      // Prefer English, then any auto-generated, then first available
      const track =
        tracks.find((t) => t.languageCode === 'en') ||
        tracks.find((t) => t.kind === 'asr') ||
        tracks[0];

      if (!track?.baseUrl) {
        throw new Error('No caption tracks available for this video');
      }

      const captionRes = await fetch(track.baseUrl);
      const xml = await captionRes.text();

      // Parse simple caption XML: <text start="1.23" dur="4.56">content</text>
      const transcript: Array<{ text: string; startMs: number }> = [];
      const regex = /<text\s+start="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
      let match;
      while ((match = regex.exec(xml)) !== null) {
        const startSec = parseFloat(match[1]);
        const text = match[2]
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/<[^>]+>/g, '')
          .trim();
        if (text) {
          transcript.push({ text, startMs: Math.round(startSec * 1000) });
        }
      }

      if (transcript.length === 0) {
        throw new Error('Failed to parse caption XML');
      }

      return { title, transcript, language: track.languageCode || 'unknown' };
    } catch (fallbackErr) {
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(`Primary (youtubei.js): ${errMsg}. Fallback (InnerTube ANDROID): ${fallbackMsg}`);
    }
  }
}

server.tool(
  'youtube_transcript',
  `Fetch the transcript of a YouTube video. Accepts any YouTube URL format (youtu.be, youtube.com/watch, shorts) or a raw video ID. Returns the video title and full transcript with timestamps. Use this when Olivia shares a YouTube link — then analyze the content, record relevant learning interactions, and discuss the video with her.`,
  {
    url: z.string().describe('YouTube URL or video ID'),
  },
  async (args) => {
    const videoId = extractVideoId(args.url);
    if (!videoId) {
      return {
        content: [{ type: 'text' as const, text: `Could not extract video ID from: ${args.url}` }],
        isError: true,
      };
    }

    try {
      const { title, transcript, language } = await fetchYouTubeTranscript(videoId);

      // Format transcript with timestamps
      const formatted = transcript.map((s) => {
        const totalSec = Math.floor(s.startMs / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `[${min}:${sec.toString().padStart(2, '0')}] ${s.text}`;
      }).join('\n');

      const result = `*${title}*\nLanguage: ${language}\nVideo: https://youtu.be/${videoId}\n\n--- Transcript ---\n${formatted}`;

      return {
        content: [{ type: 'text' as const, text: result }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to fetch transcript: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Video analysis tool (Gemini)
// ---------------------------------------------------------------------------

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_UPLOAD_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const VIDEO_INLINE_MAX_BYTES = 20 * 1024 * 1024; // 20MB

const VIDEO_MIME_MAP: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.3gp': 'video/3gpp',
  '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg',
};

async function analyzeVideoWithGemini(
  videoPath: string,
  prompt: string,
  model: string = 'gemini-2.5-flash',
): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const videoBuffer = fs.readFileSync(videoPath);
  const ext = path.extname(videoPath).toLowerCase();
  const mimeType = VIDEO_MIME_MAP[ext] || 'video/mp4';
  const fileSize = videoBuffer.length;

  let resultText: string;

  if (fileSize <= VIDEO_INLINE_MAX_BYTES) {
    // Inline: send as base64
    const videoB64 = videoBuffer.toString('base64');
    const res = await fetch(
      `${GEMINI_API_BASE}/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType, data: videoB64 } },
              { text: prompt },
            ],
          }],
        }),
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    resultText = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '';
  } else {
    // File API: upload then analyze
    // Step 1: Start resumable upload
    const metadata = JSON.stringify({ file: { displayName: path.basename(videoPath) } });
    const initRes = await fetch(`${GEMINI_UPLOAD_BASE}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(fileSize),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: metadata,
    });
    const uploadUrl = initRes.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) throw new Error('No upload URL from Gemini File API');

    // Step 2: Upload file data
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(fileSize),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: videoBuffer,
    });
    const uploadResult = await uploadRes.json() as { file?: { name?: string; uri?: string }; name?: string; uri?: string };
    const fileInfo = uploadResult.file || uploadResult;
    const fileName = fileInfo.name || '';
    const fileUri = fileInfo.uri || '';
    if (!fileUri) throw new Error('No file URI from upload');

    // Step 3: Wait for processing
    for (let i = 0; i < 60; i++) {
      const statusRes = await fetch(`${GEMINI_API_BASE}/${fileName}?key=${GEMINI_API_KEY}`);
      const status = await statusRes.json() as { state?: string };
      if (status.state === 'ACTIVE') break;
      if (status.state === 'FAILED') throw new Error('Video processing failed on Gemini');
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Step 4: Analyze
    const analyzeRes = await fetch(
      `${GEMINI_API_BASE}/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { fileData: { mimeType, fileUri } },
              { text: prompt },
            ],
          }],
        }),
      },
    );
    if (!analyzeRes.ok) {
      const errText = await analyzeRes.text();
      // Cleanup
      await fetch(`${GEMINI_API_BASE}/${fileName}?key=${GEMINI_API_KEY}`, { method: 'DELETE' }).catch(() => {});
      throw new Error(`Gemini API ${analyzeRes.status}: ${errText.slice(0, 300)}`);
    }
    const data = await analyzeRes.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    resultText = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '';

    // Cleanup uploaded file
    await fetch(`${GEMINI_API_BASE}/${fileName}?key=${GEMINI_API_KEY}`, { method: 'DELETE' }).catch(() => {});
  }

  if (!resultText) throw new Error('No text in Gemini response');
  return resultText;
}

server.tool(
  'analyze_video',
  `Analyze a video file using Gemini AI. Returns a transcript with timestamps, visual scene descriptions, and a summary. Use when Olivia sends a video — analyze it, extract learning content, record interactions on the Learning Map, and discuss it with her.`,
  {
    video_path: z.string().describe('Path to the video file (e.g. "inbox/video-123.mp4")'),
    mode: z.enum(['full', 'transcript', 'visual', 'summary', 'custom']).default('full')
      .describe('Analysis mode: full (transcript + visual + summary), transcript, visual, summary, or custom'),
    custom_prompt: z.string().optional()
      .describe('Custom analysis prompt (only used when mode is "custom")'),
  },
  async (args) => {
    const prompts: Record<string, string> = {
      full: `Analyze this video for a homeschooling context. An 11-year-old named Olivia shared this. Provide:

## Summary
2-3 sentences about what this video covers.

## Transcript
Transcribe all spoken audio with timestamps [MM:SS]. Identify speakers when possible.

## Visual Outline
Scene-by-scene visual descriptions with timestamps.

## Learning Topics
What subjects or skills does this video relate to? List specific topics that could map to learning objectives.

## Key Moments
The most interesting or educational moments with timestamps.`,
      transcript: 'Transcribe all spoken audio with timestamps [MM:SS]. Identify speakers when possible.',
      visual: 'Describe the visual content scene by scene with timestamps [MM:SS - MM:SS].',
      summary: 'Provide a concise summary: overview (2-3 sentences), key topics (bullets), key takeaways (bullets).',
    };

    const prompt = args.mode === 'custom' && args.custom_prompt
      ? args.custom_prompt
      : prompts[args.mode] || prompts.full;

    // Resolve path relative to workspace
    const wsRoot = process.env.NANOCLAW_WORKSPACE || '/workspace';
    let fullPath = args.video_path;
    if (!path.isAbsolute(fullPath)) {
      fullPath = path.join(wsRoot, 'group', fullPath);
    }

    if (!fs.existsSync(fullPath)) {
      return {
        content: [{ type: 'text' as const, text: `Video file not found: ${fullPath}` }],
        isError: true,
      };
    }

    try {
      const sizeMB = (fs.statSync(fullPath).size / 1024 / 1024).toFixed(1);
      const result = await analyzeVideoWithGemini(fullPath, prompt);

      return {
        content: [{ type: 'text' as const, text: `Video analyzed (${sizeMB} MB):\n\n${result}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error analyzing video: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
