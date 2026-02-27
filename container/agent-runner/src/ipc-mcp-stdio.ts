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
import { execSync } from 'child_process';

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


// ── BM25 Search (pure JS, zero deps) ────────────────────────────────
// Indexes workspace files on-the-fly into an in-memory BM25 index.
// Future: if EMBEDDING_URL is set, also query embeddings and merge via RRF.

interface BM25Result {
  file: string;    // relative path
  snippet: string; // matching context
  score: number;   // BM25 score
}

function bm25Search(dirs: string[], query: string, maxResults: number): BM25Result[] {
  // 1. Collect all documents (split files into paragraphs for better granularity)
  interface Doc { file: string; text: string; lineStart: number; }
  const docs: Doc[] = [];

  for (const dir of dirs) {
    const walk = (d: string) => {
      let entries: string[];
      try { entries = fs.readdirSync(d); } catch { return; }
      for (const entry of entries) {
        const full = path.join(d, entry);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) { walk(full); continue; }
          if (!/\.(md|txt|json)$/i.test(entry)) continue;
          if (stat.size > 500_000) continue; // skip huge files
          const content = fs.readFileSync(full, 'utf-8');
          const relPath = full.replace('/workspace/group/', '');
          // Split into chunks of ~5 lines for better snippet granularity
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i += 5) {
            const chunk = lines.slice(i, i + 10).join('\n').trim(); // 10-line windows, 5-line stride
            if (chunk.length > 10) {
              docs.push({ file: relPath, text: chunk, lineStart: i + 1 });
            }
          }
        } catch { /* skip unreadable files */ }
      }
    };
    walk(dir);
  }

  if (docs.length === 0) return [];

  // 2. Tokenize
  const tokenize = (text: string): string[] =>
    text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 1);

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  // 3. Build IDF (inverse document frequency)
  const N = docs.length;
  const docFreq: Record<string, number> = {};
  const docTokens: string[][] = docs.map(d => {
    const tokens = tokenize(d.text);
    const seen = new Set(tokens);
    for (const t of seen) {
      docFreq[t] = (docFreq[t] || 0) + 1;
    }
    return tokens;
  });

  // 4. BM25 scoring (k1=1.2, b=0.75)
  const k1 = 1.2;
  const b = 0.75;
  const avgDl = docTokens.reduce((s, t) => s + t.length, 0) / N;

  const scored: { idx: number; score: number }[] = [];
  for (let i = 0; i < N; i++) {
    const tokens = docTokens[i];
    const dl = tokens.length;
    // Count term frequencies
    const tf: Record<string, number> = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;

    let score = 0;
    for (const term of queryTerms) {
      const f = tf[term] || 0;
      if (f === 0) continue;
      const df = docFreq[term] || 0;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgDl))));
    }

    if (score > 0) scored.push({ idx: i, score });
  }

  // 5. Sort by score, deduplicate by file, take top N
  scored.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const results: BM25Result[] = [];
  for (const { idx, score } of scored) {
    if (results.length >= maxResults) break;
    const doc = docs[idx];
    const key = `${doc.file}:${doc.lineStart}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Highlight matching lines in snippet
    const lines = doc.text.split('\n');
    const matchingLines = lines.filter(line =>
      queryTerms.some(t => line.toLowerCase().includes(t))
    );
    const snippet = matchingLines.length > 0
      ? matchingLines.slice(0, 5).join('\n')
      : lines.slice(0, 3).join('\n');

    results.push({
      file: doc.file,
      snippet: snippet.slice(0, 500),
      score: Math.round(score * 100) / 100,
    });
  }

  return results;
}

// ── Embedding hooks (future-proofing) ────────────────────────────────
// Set EMBEDDING_URL to enable semantic search alongside BM25.
// The endpoint should accept POST { text: string } and return { embedding: number[] }.
// Results are merged with BM25 via Reciprocal Rank Fusion (RRF).
const EMBEDDING_URL = process.env.EMBEDDING_URL || '';
// TODO: When EMBEDDING_URL is set:
// 1. On startup, embed all workspace files and cache vectors
// 2. On search, embed query, compute cosine similarity
// 3. Merge BM25 + embedding results via RRF: score = 1/(k+rank_bm25) + 1/(k+rank_embed)


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
    model: z.string().optional().describe('Model to use for this task (e.g. minimax/minimax-m2.5 for free grunt work, or claude-haiku-4-5 for cheap tasks). If not set, uses the default model.'),
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
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
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
  'recall',
  `Search your workspace files (knowledge, daily notes, projects, areas, conversations) for past information. Use this when you need to remember something — a decision, a conversation detail, a person's name, a preference, or anything you might have written down before.

This searches the actual files on disk, not conversation history. Your nightly consolidation writes important things here, so this is your long-term memory.

Powered by BM25 relevance ranking — results are sorted by how well they match your query, not just whether they contain the words.

Tips:
- Use specific keywords: "stripe", "brandon preference", "oauth"
- Search is case-insensitive and ranked by relevance
- Returns matching passages with filenames, sorted by score
- If you get no results, try different keywords or check daily/ for date-specific notes`,
  {
    query: z.string().describe('Search keywords (e.g. "stripe keys", "brandon", "revenue target"). Ranked by BM25 relevance.'),
    folder: z.enum(['all', 'knowledge', 'daily', 'projects', 'areas', 'conversations', 'resources']).default('all').describe('Narrow search to a specific folder, or "all" to search everywhere.'),
    max_results: z.number().default(20).describe('Maximum number of results to return.'),
  },
  async (args) => {
    const baseDir = '/workspace/group';
    const searchDirs = args.folder === 'all'
      ? ['knowledge', 'daily', 'projects', 'areas', 'conversations', 'resources']
      : [args.folder];

    const existingDirs = searchDirs
      .map(d => path.join(baseDir, d))
      .filter(d => fs.existsSync(d));

    if (existingDirs.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No workspace folders found. Your memory is empty — start writing to knowledge/ and daily/ files.' }] };
    }

    try {
      const results = bm25Search(existingDirs, args.query, args.max_results);

      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: `No results for "${args.query}". Try different keywords, or check if you have written this down yet.` }] };
      }

      let output = `## Recall results for "${args.query}"\\n\\n`;
      for (const r of results) {
        output += `**${r.file}** (score: ${r.score})\\n\`\`\`\\n${r.snippet}\\n\`\`\`\\n\\n`;
      }
      if (EMBEDDING_URL) {
        output += `\\n_Semantic search: enabled (${EMBEDDING_URL})_`;
      }

      return { content: [{ type: 'text' as const, text: output }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Recall error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);server.tool(
  'recall',
  `Search your workspace files (knowledge, daily notes, projects, areas, conversations) for past information. Use this when you need to remember something — a decision, a conversation detail, a person's name, a preference, or anything you might have written down before.

This searches the actual files on disk, not conversation history. Your nightly consolidation writes important things here, so this is your long-term memory.

Tips:
- Use specific keywords: "stripe", "brandon preference", "oauth"
- Search is case-insensitive
- Returns matching lines with filenames and context
- If you get no results, try different keywords or check daily/ for date-specific notes`,
  {
    query: z.string().describe('Search keywords (e.g. "stripe keys", "brandon", "revenue target"). Case-insensitive grep across all workspace files.'),
    folder: z.enum(['all', 'knowledge', 'daily', 'projects', 'areas', 'conversations', 'resources']).default('all').describe('Narrow search to a specific folder, or "all" to search everywhere.'),
    max_results: z.number().default(30).describe('Maximum number of matching lines to return.'),
  },
  async (args) => {
    const baseDir = '/workspace/group';
    const searchDirs = args.folder === 'all'
      ? ['knowledge', 'daily', 'projects', 'areas', 'conversations', 'resources']
      : [args.folder];

    const existingDirs = searchDirs
      .map(d => path.join(baseDir, d))
      .filter(d => fs.existsSync(d));

    if (existingDirs.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No workspace folders found. Your memory is empty — start writing to knowledge/ and daily/ files.' }] };
    }

    try {
      // Use grep for fast search across all files
      const escapedQuery = args.query.replace(/['"\\]/g, '\\$&');
      const dirsArg = existingDirs.join(' ');
      const cmd = `grep -rni --include='*.md' --include='*.txt' --include='*.json' "${escapedQuery}" ${dirsArg} 2>/dev/null | head -${args.max_results}`;

      let result: string;
      try {
        result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
      } catch {
        result = '';
      }

      if (!result) {
        return { content: [{ type: 'text' as const, text: `No results for "${args.query}". Try different keywords, or check if you have written this down yet.` }] };
      }

      // Clean up paths to be relative to workspace
      const cleaned = result.replace(/\/workspace\/group\//g, '');

      return { content: [{ type: 'text' as const, text: `## Recall results for "${args.query}"\n\n${cleaned}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Recall error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'remember',
  `Write something important to your long-term memory. Use this to save information you will need later — decisions, lessons learned, contact details, preferences, or anything that should survive session compaction.

This writes directly to your workspace knowledge files. Information stored here persists across all sessions and is searchable with the recall tool.

Choose the right file:
- knowledge/patterns.md — lessons from mistakes, things that work
- knowledge/preferences.md — Brandon's preferences, how he works
- knowledge/contacts.md — people, accounts, relationships
- knowledge/security.md — security rules, trusted channels
- daily/YYYY-MM-DD.md — today's events and decisions
- projects/<name>.md — project-specific notes`,
  {
    file: z.string().describe('Relative path within your workspace (e.g. "knowledge/patterns.md", "daily/2026-02-27.md", "projects/revenue.md")'),
    content: z.string().describe('The text to append to the file. Will be added at the end with a newline separator.'),
    mode: z.enum(['append', 'overwrite']).default('append').describe('append=add to end of file (default, safe), overwrite=replace entire file (use carefully)'),
  },
  async (args) => {
    const filePath = path.join('/workspace/group', args.file);

    // Security: prevent path traversal
    if (args.file.includes('..') || !filePath.startsWith('/workspace/group/')) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid file path. Must be within your workspace.' }],
        isError: true,
      };
    }

    try {
      // Ensure directory exists
      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      if (args.mode === 'overwrite') {
        fs.writeFileSync(filePath, args.content + '\n');
      } else {
        const separator = fs.existsSync(filePath) ? '\n\n' : '';
        fs.appendFileSync(filePath, separator + args.content + '\n');
      }

      return { content: [{ type: 'text' as const, text: `Saved to ${args.file} (${args.mode}).` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error writing: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);


// --- SignalWire Tools (Adam's phone number) ---

const SW_PROJECT_ID = process.env.SIGNALWIRE_PROJECT_ID || '';
const SW_API_TOKEN = process.env.SIGNALWIRE_API_TOKEN || '';
const SW_SPACE_URL = process.env.SIGNALWIRE_SPACE_URL || '';
const SW_PHONE = process.env.SIGNALWIRE_PHONE_NUMBER || '';
const SW_RESOLVE = `${SW_SPACE_URL}:8443:10.99.0.2`;

function swCurl(endpoint: string, method: string = 'GET', data?: string): string {
  const url = `https://${SW_SPACE_URL}:8443/api/laml/2010-04-01/Accounts/${SW_PROJECT_ID}${endpoint}`;
  let cmd = `curl -s --resolve ${SW_RESOLVE} -X ${method} -u "${SW_PROJECT_ID}:${SW_API_TOKEN}" "${url}"`;
  if (data) {
    cmd += ` -d '${data}'`;
  }
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim();
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

server.tool(
  'send_sms',
  `Send an SMS text message from your phone number (${SW_PHONE || 'not configured'}). Use this to reach people directly — follow-ups, notifications, outreach. Keep messages concise and professional.`,
  {
    to: z.string().describe('Phone number to send to (E.164 format, e.g. "+14155551234")'),
    body: z.string().describe('The message text (max 1600 chars)'),
  },
  async (args) => {
    if (!SW_PROJECT_ID || !SW_API_TOKEN) {
      return { content: [{ type: 'text' as const, text: 'SignalWire not configured. Ask Brandon to add credentials.' }], isError: true };
    }
    const data = `From=${encodeURIComponent(SW_PHONE)}&To=${encodeURIComponent(args.to)}&Body=${encodeURIComponent(args.body)}`;
    const result = swCurl('/Messages.json', 'POST', data);
    try {
      const parsed = JSON.parse(result);
      if (parsed.sid) {
        return { content: [{ type: 'text' as const, text: `SMS sent to ${args.to} (SID: ${parsed.sid}, status: ${parsed.status})` }] };
      }
      return { content: [{ type: 'text' as const, text: `SMS error: ${JSON.stringify(parsed)}` }], isError: true };
    } catch {
      return { content: [{ type: 'text' as const, text: `SMS response: ${result}` }] };
    }
  },
);

server.tool(
  'check_messages',
  'Check recent SMS messages (sent and received) on your phone number. Use this to see if anyone has texted you, or check delivery status of messages you sent.',
  {
    direction: z.enum(['inbound', 'outbound', 'all']).default('all').describe('Filter by message direction'),
    limit: z.number().default(10).describe('How many messages to return (max 50)'),
  },
  async (args) => {
    if (!SW_PROJECT_ID || !SW_API_TOKEN) {
      return { content: [{ type: 'text' as const, text: 'SignalWire not configured.' }], isError: true };
    }
    let endpoint = `/Messages.json?PageSize=${Math.min(args.limit, 50)}`;
    if (args.direction === 'inbound') {
      endpoint += `&To=${encodeURIComponent(SW_PHONE)}`;
    } else if (args.direction === 'outbound') {
      endpoint += `&From=${encodeURIComponent(SW_PHONE)}`;
    }
    const result = swCurl(endpoint);
    try {
      const parsed = JSON.parse(result);
      if (parsed.messages && parsed.messages.length > 0) {
        const msgs = parsed.messages.map((m: { date_sent: string; from: string; to: string; body: string; status: string; direction: string }) =>
          `[${m.date_sent}] ${m.direction === 'inbound' ? m.from + ' -> you' : 'you -> ' + m.to}: ${m.body} (${m.status})`
        ).join('\n');
        return { content: [{ type: 'text' as const, text: `## Recent SMS (${parsed.messages.length})\n\n${msgs}` }] };
      }
      return { content: [{ type: 'text' as const, text: 'No messages found.' }] };
    } catch {
      return { content: [{ type: 'text' as const, text: `Response: ${result.slice(0, 500)}` }] };
    }
  },
);

server.tool(
  'make_call',
  `Make a phone call from your number (${SW_PHONE || 'not configured'}). The call will play a text-to-speech message to the recipient. Use for important outreach where SMS is not enough.`,
  {
    to: z.string().describe('Phone number to call (E.164 format, e.g. "+14155551234")'),
    message: z.string().describe('Text-to-speech message the recipient will hear when they answer'),
    voice: z.enum(['man', 'woman', 'alice']).default('man').describe('Voice for text-to-speech'),
  },
  async (args) => {
    if (!SW_PROJECT_ID || !SW_API_TOKEN) {
      return { content: [{ type: 'text' as const, text: 'SignalWire not configured.' }], isError: true };
    }
    // Build TwiML for TTS
    const twiml = `<Response><Say voice="${args.voice}">${args.message.replace(/[&<>"']/g, '')}</Say></Response>`;
    const data = `From=${encodeURIComponent(SW_PHONE)}&To=${encodeURIComponent(args.to)}&Twiml=${encodeURIComponent(twiml)}`;
    const result = swCurl('/Calls.json', 'POST', data);
    try {
      const parsed = JSON.parse(result);
      if (parsed.sid) {
        return { content: [{ type: 'text' as const, text: `Call initiated to ${args.to} (SID: ${parsed.sid}, status: ${parsed.status})` }] };
      }
      return { content: [{ type: 'text' as const, text: `Call error: ${JSON.stringify(parsed)}` }], isError: true };
    } catch {
      return { content: [{ type: 'text' as const, text: `Response: ${result}` }] };
    }
  },
);

server.tool(
  'check_calls',
  'Check recent phone call logs. See who called you and calls you made.',
  {
    limit: z.number().default(10).describe('How many call records to return (max 50)'),
  },
  async (args) => {
    if (!SW_PROJECT_ID || !SW_API_TOKEN) {
      return { content: [{ type: 'text' as const, text: 'SignalWire not configured.' }], isError: true };
    }
    const endpoint = `/Calls.json?PageSize=${Math.min(args.limit, 50)}`;
    const result = swCurl(endpoint);
    try {
      const parsed = JSON.parse(result);
      if (parsed.calls && parsed.calls.length > 0) {
        const calls = parsed.calls.map((c: { date_created: string; from: string; to: string; status: string; duration: string; direction: string }) =>
          `[${c.date_created}] ${c.direction}: ${c.from} -> ${c.to} (${c.status}, ${c.duration}s)`
        ).join('\n');
        return { content: [{ type: 'text' as const, text: `## Recent Calls (${parsed.calls.length})\n\n${calls}` }] };
      }
      return { content: [{ type: 'text' as const, text: 'No call records found.' }] };
    } catch {
      return { content: [{ type: 'text' as const, text: `Response: ${result.slice(0, 500)}` }] };
    }
  },
);

// Start the stdio transport

// --- x402 Payment Fetch (host-proxied, secure pattern) ---
// Private key stays on host. Container writes request to IPC, polls for response.

const X402_REQUESTS_DIR = path.join(IPC_DIR, "x402-requests");
const X402_RESPONSES_DIR = path.join(IPC_DIR, "x402-responses");

server.tool(
  "x402_fetch",
  "Make an HTTP request that can automatically pay x402 paywalls using USDC on Base. The payment is handled securely by the host — you never touch the wallet. Use this when accessing paid APIs or x402-enabled endpoints.",
  {
    url: z.string().describe("The URL to fetch"),
    method: z.string().default("GET").describe("HTTP method (GET, POST, etc.)"),
    headers: z.record(z.string(), z.string()).optional().describe("Optional HTTP headers"),
    body: z.string().optional().describe("Optional request body"),
    max_price_usd: z.number().default(1.0).describe("Maximum USDC you are willing to pay for this request. Default $1."),
  },
  async (args) => {
    // Write request to IPC for host to process
    fs.mkdirSync(X402_REQUESTS_DIR, { recursive: true });
    fs.mkdirSync(X402_RESPONSES_DIR, { recursive: true });

    const requestId = `x402-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestPath = path.join(X402_REQUESTS_DIR, `${requestId}.json`);

    fs.writeFileSync(requestPath, JSON.stringify({
      id: requestId,
      url: args.url,
      method: args.method,
      headers: args.headers || {},
      body: args.body || null,
      max_price_usd: args.max_price_usd,
      timestamp: new Date().toISOString(),
    }));

    // Poll for response from host (200ms interval, 60s timeout)
    const responsePath = path.join(X402_RESPONSES_DIR, `${requestId}.json`);
    const timeout = 60000;
    const interval = 200;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (fs.existsSync(responsePath)) {
        try {
          const response = JSON.parse(fs.readFileSync(responsePath, "utf-8"));
          // Clean up
          try { fs.unlinkSync(responsePath); } catch {}

          if (response.error) {
            return { content: [{ type: "text" as const, text: `x402 error: ${response.error}` }], isError: true };
          }

          let summary = `**Status:** ${response.status}\n`;
          if (response.paid) {
            summary += `**Paid:** $${response.amount_usd} USDC on Base\n`;
            if (response.tx_hash) summary += `**Tx:** ${response.tx_hash}\n`;
          }
          summary += `\n${response.body || "(empty response)"}`;

          return { content: [{ type: "text" as const, text: summary }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Failed to parse x402 response: ${err}` }], isError: true };
        }
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    // Timeout — clean up request file
    try { fs.unlinkSync(requestPath); } catch {}
    return { content: [{ type: "text" as const, text: "x402 request timed out (60s). The host may not be processing x402 requests." }], isError: true };
  },
);


// --- Delegation: Spawn a worker agent for a subtask ---
// Adam writes request to IPC, host spawns a container, result comes back via IPC.

const DELEGATE_REQUESTS_DIR = path.join(IPC_DIR, "delegate-requests");
const DELEGATE_RESPONSES_DIR = path.join(IPC_DIR, "delegate-responses");

server.tool(
  "delegate_task",
  `Delegate a task to a worker agent. The worker runs in its own container with its own context — it cannot see your conversation. Use this for:
• Research tasks: "Search the web for X and summarize findings"
• Grunt work: "Format this data as a CSV"
• Parallel work: "Draft an email while I work on something else"

The worker gets the global Agent OS (tools, memory access) but NO conversation history.
You get back the worker's final output as text.

Tips:
• Use a cheap model (minimax/minimax-m2.5) for simple tasks
• Be specific in your prompt — the worker has zero context about your conversation
• Workers can use send_message, recall, remember, and other tools
• Default timeout is 5 minutes — set higher for complex tasks`,
  {
    prompt: z.string().describe("What the worker should do. Include ALL context — the worker cannot see your conversation."),
    model: z.string().optional().describe("Model for the worker (e.g. minimax/minimax-m2.5 for cheap grunt work). Defaults to your model."),
    timeout_seconds: z.number().default(300).describe("Max seconds to wait for result (default 300 = 5 min, max 600 = 10 min)"),
  },
  async (args) => {
    fs.mkdirSync(DELEGATE_REQUESTS_DIR, { recursive: true });
    fs.mkdirSync(DELEGATE_RESPONSES_DIR, { recursive: true });

    const delegateId = `delegate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestPath = path.join(DELEGATE_REQUESTS_DIR, `${delegateId}.json`);

    const timeoutSec = Math.min(Math.max(args.timeout_seconds, 30), 600);

    fs.writeFileSync(requestPath, JSON.stringify({
      id: delegateId,
      prompt: args.prompt,
      model: args.model || null,
      timeout_seconds: timeoutSec,
      source_group: groupFolder,
      source_chat_jid: chatJid,
      timestamp: new Date().toISOString(),
    }));

    // Poll for response (1s interval, up to timeout)
    const responsePath = path.join(DELEGATE_RESPONSES_DIR, `${delegateId}.json`);
    const timeout = timeoutSec * 1000;
    const interval = 1000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (fs.existsSync(responsePath)) {
        try {
          const response = JSON.parse(fs.readFileSync(responsePath, "utf-8"));
          try { fs.unlinkSync(responsePath); } catch {}

          if (response.error) {
            return { content: [{ type: "text" as const, text: `Worker failed: ${response.error}` }], isError: true };
          }

          const elapsed = Math.round((Date.now() - start) / 1000);
          let summary = `**Worker completed** (${elapsed}s, model: ${response.model || "default"})\n\n`;
          summary += response.result || "(no output)";

          return { content: [{ type: "text" as const, text: summary }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Failed to parse worker response: ${err}` }], isError: true };
        }
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    // Timeout
    try { fs.unlinkSync(requestPath); } catch {}
    return { content: [{ type: "text" as const, text: `Worker timed out after ${timeoutSec}s. The task may still be running — check back later.` }], isError: true };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
