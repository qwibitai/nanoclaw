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
import { execFile } from 'child_process';
import crypto from 'crypto';
import { CronExpressionParser } from 'cron-parser';
import { transcribeAudio } from './audio.js';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

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

// --- Cross-channel conversation query tool ---

const MESSAGES_DB_PATH = '/workspace/extra/messages-db/messages.db';
const DEFAULT_LINES = 20;
const MAX_LINES = 100;
const DEFAULT_HOURS = 4;

/**
 * Build a Python script that queries messages.db with parameterized inputs.
 * All user values are passed as a base64-encoded JSON blob to prevent injection.
 */
function buildConversationQueryScript(dbPath: string, options: {
  lines: number;
  hours: number;
  channel?: string | null;
  search?: string | null;
}): string {
  const config = JSON.stringify({
    db_path: dbPath,
    hours: options.hours,
    lines: options.lines,
    channel: options.channel ?? null,
    search: options.search ?? null,
  });
  const b64Config = Buffer.from(config).toString('base64');

  return `
import sqlite3, os, json, base64

config = json.loads(base64.b64decode('${b64Config}').decode())
db_path = os.path.expanduser(config['db_path'])
conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
cursor = conn.cursor()

where_clauses = ["m.timestamp >= datetime('now', '-' || ? || ' hours')"]
params = [config['hours']]

if config['channel']:
    where_clauses.append("c.channel = ?")
    params.append(config['channel'])

if config['search']:
    where_clauses.append("m.content LIKE '%' || ? || '%'")
    params.append(config['search'])

params.append(config['lines'])
where_str = ' AND '.join(where_clauses)

cursor.execute(f"""
  SELECT m.timestamp, c.channel, m.sender_name, m.is_from_me, m.content
  FROM messages m
  JOIN chats c ON m.chat_jid = c.jid
  WHERE {where_str}
  ORDER BY m.timestamp DESC
  LIMIT ?
""", params)
rows = cursor.fetchall()
conn.close()
for row in rows:
    ts, ch, sender, is_me, content = row
    print(f"{ts} | {ch} | {sender} | {bool(is_me)} | {content}")
`.trim();
}

function execPythonLocal(script: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile('python3', ['-c', script], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
        exitCode: error ? ((error as NodeJS.ErrnoException).code as unknown as number ?? 1) : 0,
      });
    });
  });
}

server.tool(
  'read_own_conversations',
  "Read your own conversation history across all channels (Slack, Telegram, etc). Queries the messages database directly. Use this for cross-channel context awareness — e.g., to check what was discussed on another channel.",
  {
    channel: z.enum(['slack', 'telegram', 'whatsapp', 'discord']).optional().describe('Filter by channel. Omit to get all channels.'),
    lines: z.number().optional().describe('Number of messages to return (default 20, max 100)'),
    search: z.string().optional().describe('Search term to filter messages by content'),
    hours: z.number().optional().describe('How many hours back to search (default 4)'),
  },
  async (args) => {
    if (!fs.existsSync(MESSAGES_DB_PATH)) {
      return {
        content: [{ type: 'text' as const, text: 'Messages database not available. The messages-db mount may not be configured.' }],
        isError: true,
      };
    }

    const lines = Math.min(Math.max(args.lines ?? DEFAULT_LINES, 1), MAX_LINES);
    const hours = args.hours ?? DEFAULT_HOURS;

    const script = buildConversationQueryScript(MESSAGES_DB_PATH, {
      lines,
      hours,
      channel: args.channel,
      search: args.search,
    });

    const result = await execPythonLocal(script);

    if (result.exitCode !== 0) {
      return {
        content: [{ type: 'text' as const, text: `Error reading conversations: ${result.stderr.trim()}` }],
        isError: true,
      };
    }

    const output = result.stdout.trim();
    if (!output) {
      return {
        content: [{ type: 'text' as const, text: 'No conversations found in the specified time range.' }],
      };
    }

    return {
      content: [{ type: 'text' as const, text: output }],
    };
  },
);

// --- Direct Slack channel post ---


server.tool(
  'transcribe_audio',
  'Transcribe a Telegram voice message or audio file using Groq Whisper. Pass the telegram_file_id from the voice message placeholder.',
  {
    telegram_file_id: z.string().optional().describe('Telegram file_id from a voice or audio message'),
    audio_url: z.string().optional().describe('Direct URL to audio file (if not using Telegram file_id)'),
  },
  async (args) => {
    const result = await transcribeAudio(args.audio_url ?? '', args.telegram_file_id);
    return { content: [{ type: 'text' as const, text: result }] };
  },
);

server.tool(
  'slack_post_to_channel',
  "Post a Slack message directly to a specific channel by its ID or name (#channel or C0XXXXXXX). Use this when you've been instructed in one context (e.g. a DM with the user) to post into a different channel. The bot must be a member of the target channel; if not, the tool returns a clear error including a hint about asking the operator to /invite the bot. For peer-to-peer agent messaging in your current channel, prefer `send_message` instead.",
  {
    channel: z
      .string()
      .describe('Channel ID (e.g. "C0AP24V9695") or name with hash (e.g. "#x-relay"). Slack resolves both.'),
    text: z.string().describe('Message text. Slack mrkdwn supported.'),
    thread_ts: z
      .string()
      .optional()
      .describe('Optional: parent message ts (e.g. "1778425063.986949") to reply in-thread.'),
  },
  async (args) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'slack_post_to_channel',
      requestId,
      channel: args.channel,
      text: args.text,
      thread_ts: args.thread_ts,
      sourceGroup: groupFolder,
      timestamp: new Date().toISOString(),
    });

    const responseFile = path.join(RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(responseFile)) {
        try {
          const raw = fs.readFileSync(responseFile, 'utf-8');
          const response = JSON.parse(raw);
          try {
            fs.unlinkSync(responseFile);
          } catch {
            // best-effort cleanup
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(response) }],
            isError: response.ok === false,
          };
        } catch {
          // mid-write; retry
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error: 'timeout',
            hint: 'No response from host within 15s. Host IPC watcher may be stalled — check bot logs.',
            requestId,
          }),
        },
      ],
      isError: true,
    };
  },
);

// =====================================================================
// Phase 4: bash_tool + python_tool
// Inserted before the "// Start the stdio transport" block.
//
// Design ref: ~/work/projects/neuronbox/fleet-host-mcp/docs/phase-4-design.md
// Deviations from design (documented in commit):
//   - SCRATCH at /tmp/nanoclaw-scratch (container-local), not host path.
//     Container ephemeral, scratch dies with it. Audit log persists to
//     /workspace/ipc/audit/ which IS host-mounted.
//   - Added a minimal bash destructive-pattern denylist beyond the
//     design's temp-file+execFile pattern. Blocks only egregious cases
//     (rm -rf /, dd to disk devices, mkfs, fork-bomb, curl|sh, /dev/tcp/).
//     Valid `rm -rf node_modules/` etc. still works.
//   - Bot detection via mount-existence (no new env vars needed).
// =====================================================================


const SCRATCH_DIR = '/tmp/nanoclaw-scratch';
const AUDIT_DIR = '/workspace/ipc/audit';
const BASH_AUDIT_LOG = `${AUDIT_DIR}/bash-tool.jsonl`;
const PYTHON_AUDIT_LOG = `${AUDIT_DIR}/python-tool.jsonl`;
const STDOUT_TRUNC_BYTES = 64 * 1024;
const MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const SCRATCH_KEEP = 50;

const ENV_ALLOWLIST_BY_BOT: Record<string, readonly string[]> = {
  x: ['TELEMETRY_TOKEN', 'MONGODB_URI', 'OPENCLAW_DB_URL', 'ANTHROPIC_API_KEY'],
  relay: ['MONGODB_URI', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN'],
  unknown: [],
};

// Egregious destructive patterns. Block-list is intentionally narrow so
// legitimate ops (rm -rf node_modules, dd if=/dev/zero of=tmpfile) work.
const BASH_DENY_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'rm_rf_root_or_home', re: /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+(\/(?:\s|$|\*)|~(?:\/|\s|$))/ },
  { name: 'dd_to_block_device', re: /\bdd\b[^|;\n]*\bof=\/dev\/(?:sd[a-z]|nvme\d|disk\d|hd[a-z]|mmcblk\d)/ },
  { name: 'mkfs', re: /\bmkfs(?:\.[a-z0-9]+)?\b/ },
  { name: 'fork_bomb', re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/ },
  { name: 'pipe_to_shell', re: /\b(?:curl|wget|fetch)\b[^|;\n]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|ksh|fish|dash|python3?|perl|ruby)\b/ },
  { name: 'base64_pipe_shell', re: /\bbase64\b[^|;\n]*-d[^|;\n]*\|\s*(?:bash|sh|zsh|python3?)\b/ },
  { name: 'bash_dev_tcp', re: /\/dev\/(?:tcp|udp)\// },
  { name: 'chattr_immutable_strip', re: /\bchattr\s+[+-]i\b/ },
];

function detectBotKind(): 'x' | 'relay' | 'unknown' {
  // Mount-presence is the most reliable per-bot signal; mounts are
  // defined in each bot's docker run, no shared env keys to confuse them.
  if (fs.existsSync('/workspace/extra/service-ssh')) return 'x';
  if (fs.existsSync('/workspace/extra/relay-keys')) return 'relay';
  return 'unknown';
}

function appendAuditLine(logPath: string, entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch {
    // audit is best-effort; never fail the tool because audit failed
  }
}

function pruneScratch(extension: string): void {
  try {
    const files = fs
      .readdirSync(SCRATCH_DIR)
      .filter((f) => f.endsWith(extension))
      .map((f) => ({ f, t: fs.statSync(path.join(SCRATCH_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(SCRATCH_KEEP)) {
      try {
        fs.unlinkSync(path.join(SCRATCH_DIR, f));
      } catch {
        // ignore individual file failures
      }
    }
  } catch {
    // ignore — pruning is best-effort
  }
}

function execFileAsync(
  cmd: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv },
): Promise<{ error: (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, options, (error, stdout, stderr) => {
      resolve({
        error: error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null,
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
      });
    });
  });
}

server.tool(
  'bash_tool',
  `Run a bash script. Script is written to a temp file and run with 'bash <file>' — no shell quoting layer, nested quotes pass through intact. Returns {ok, rc, stdout, stderr, duration_ms, timeout_hit}. stdout/stderr truncated at 64 KB. Default timeout 60s, max 300s. Audited to /workspace/ipc/audit/bash-tool.jsonl. Rejects scripts matching a narrow destructive-pattern denylist (rm -rf /, dd of=/dev/sd*, mkfs, fork-bomb, curl|sh, /dev/tcp/, chattr -i). Legit ops like 'rm -rf node_modules' still work.`,
  {
    script: z.string().min(1).describe('Bash script source. Use any quoting you like; it is written verbatim to a file and executed.'),
    timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe(`Timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
  },
  async (args) => {
    // Denylist check on raw script
    for (const { name, re } of BASH_DENY_PATTERNS) {
      if (re.test(args.script)) {
        const rejection = {
          ok: false,
          rc: -1,
          stdout: '',
          stderr: '',
          duration_ms: 0,
          error: 'denylist_match',
          pattern: name,
        };
        appendAuditLine(BASH_AUDIT_LOG, {
          ts: new Date().toISOString(),
          groupFolder,
          ok: false,
          error: 'denylist_match',
          pattern: name,
          script_len: args.script.length,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(rejection) }],
          isError: true,
        };
      }
    }

    fs.mkdirSync(SCRATCH_DIR, { recursive: true, mode: 0o700 });
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const scriptPath = path.join(SCRATCH_DIR, `${id}.sh`);
    fs.writeFileSync(scriptPath, args.script, { mode: 0o700 });
    const timeout = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();
    const { error, stdout, stderr } = await execFileAsync('bash', [scriptPath], {
      timeout,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    const duration_ms = Date.now() - start;
    const ok = !error;
    const rc = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
    const timeout_hit = error?.killed === true && error?.signal === 'SIGTERM';
    const result = {
      ok,
      rc,
      stdout: stdout.slice(0, STDOUT_TRUNC_BYTES),
      stderr: stderr.slice(0, STDOUT_TRUNC_BYTES),
      duration_ms,
      timeout_hit,
    };
    appendAuditLine(BASH_AUDIT_LOG, {
      ts: new Date().toISOString(),
      id,
      groupFolder,
      ok,
      rc,
      duration_ms,
      timeout_ms: timeout,
      timeout_hit,
      script_len: args.script.length,
    });
    pruneScratch('.sh');
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      isError: !ok,
    };
  },
);

server.tool(
  'python_tool',
  `Run a Python 3 script. Script is written to a temp file and run with 'python3 <file>'. Returns {ok, rc, stdout, stderr, duration_ms, timeout_hit, bot_kind, env_keys_passed, env_keys_missing}. stdout/stderr truncated at 64 KB. Default timeout 60s, max 300s. Audited to /workspace/ipc/audit/python-tool.jsonl.

env_keys: array of env var names to pass through from the agent-runner's env to the child python process. Per-bot allow-list:
  - X bot:     TELEMETRY_TOKEN, MONGODB_URI, OPENCLAW_DB_URL, ANTHROPIC_API_KEY
  - Relay bot: MONGODB_URI, ANTHROPIC_API_KEY, GITHUB_TOKEN
Requesting a key outside the allow-list returns a structured rejection (no execution). Allowed keys that are not actually set in the container env are silently skipped and reported in env_keys_missing.`,
  {
    script: z.string().min(1).describe('Python script source.'),
    env_keys: z.array(z.string()).optional().describe('Env var names to pass through (subject to per-bot allow-list).'),
    timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe(`Timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
  },
  async (args) => {
    const botKind = detectBotKind();
    const allowed = ENV_ALLOWLIST_BY_BOT[botKind] ?? [];
    const requested = args.env_keys ?? [];
    const rejected = requested.filter((k) => !allowed.includes(k));
    if (rejected.length > 0) {
      const rejection = {
        ok: false,
        rc: -1,
        stdout: '',
        stderr: '',
        duration_ms: 0,
        error: 'env_key_rejected',
        bot_kind: botKind,
        rejected_keys: rejected,
        allowed_keys: allowed,
      };
      appendAuditLine(PYTHON_AUDIT_LOG, {
        ts: new Date().toISOString(),
        groupFolder,
        bot_kind: botKind,
        ok: false,
        error: 'env_key_rejected',
        rejected_keys: rejected,
        script_len: args.script.length,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rejection) }],
        isError: true,
      };
    }

    fs.mkdirSync(SCRATCH_DIR, { recursive: true, mode: 0o700 });
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const scriptPath = path.join(SCRATCH_DIR, `${id}.py`);
    fs.writeFileSync(scriptPath, args.script, { mode: 0o700 });

    const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
    const env_keys_passed: string[] = [];
    const env_keys_missing: string[] = [];
    for (const k of requested) {
      if (process.env[k] !== undefined) {
        childEnv[k] = process.env[k];
        env_keys_passed.push(k);
      } else {
        env_keys_missing.push(k);
      }
    }

    const timeout = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();
    const { error, stdout, stderr } = await execFileAsync('python3', [scriptPath], {
      timeout,
      maxBuffer: MAX_BUFFER_BYTES,
      env: childEnv,
    });
    const duration_ms = Date.now() - start;
    const ok = !error;
    const rc = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
    const timeout_hit = error?.killed === true && error?.signal === 'SIGTERM';
    const result = {
      ok,
      rc,
      stdout: stdout.slice(0, STDOUT_TRUNC_BYTES),
      stderr: stderr.slice(0, STDOUT_TRUNC_BYTES),
      duration_ms,
      timeout_hit,
      bot_kind: botKind,
      env_keys_passed,
      env_keys_missing,
    };
    appendAuditLine(PYTHON_AUDIT_LOG, {
      ts: new Date().toISOString(),
      id,
      groupFolder,
      bot_kind: botKind,
      ok,
      rc,
      duration_ms,
      timeout_ms: timeout,
      timeout_hit,
      script_len: args.script.length,
      env_keys_passed,
      env_keys_missing,
    });
    pruneScratch('.py');
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      isError: !ok,
    };
  },
);
// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
