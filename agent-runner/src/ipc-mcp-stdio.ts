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
import { MemoryIpcAction } from './memory-ipc-contract.js';

const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const MEMORY_REQUESTS_DIR = path.join(IPC_DIR, 'memory-requests');
const MEMORY_RESPONSES_DIR = path.join(IPC_DIR, 'memory-responses');
const IPC_AUTH_TOKEN = process.env.NANOCLAW_IPC_AUTH_TOKEN || '';

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
  const envelope = IPC_AUTH_TOKEN ? { ...data, authToken: IPC_AUTH_TOKEN } : data;
  fs.writeFileSync(tempPath, JSON.stringify(envelope, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function readJsonArraySnapshot(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return Array.isArray(parsed) ? parsed : [];
}

async function requestMemoryAction(
  action: MemoryIpcAction,
  payload: Record<string, unknown>,
): Promise<{
  ok: boolean;
  provider?: string;
  data?: unknown;
  error?: string;
}> {
  fs.mkdirSync(MEMORY_REQUESTS_DIR, { recursive: true });
  fs.mkdirSync(MEMORY_RESPONSES_DIR, { recursive: true });

  const requestId = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reqPath = path.join(MEMORY_REQUESTS_DIR, `${requestId}.json`);
  const tmpReqPath = `${reqPath}.tmp`;
  fs.writeFileSync(
    tmpReqPath,
    JSON.stringify(
      {
        requestId,
        action,
        payload,
        ...(IPC_AUTH_TOKEN ? { authToken: IPC_AUTH_TOKEN } : {}),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tmpReqPath, reqPath);

  const deadline = Date.now() + 15000;
  const responsePath = path.join(MEMORY_RESPONSES_DIR, `${requestId}.json`);

  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
          ok: boolean;
          provider?: string;
          data?: unknown;
          error?: string;
        };
        fs.unlinkSync(responsePath);
        return data;
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Failed to parse memory response',
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return { ok: false, error: 'Timed out waiting for memory service response' };
}

function formatMemoryToolResponse(response: {
  provider?: string;
  data?: unknown;
}): string {
  return JSON.stringify(
    {
      provider: response.provider || 'unknown',
      ...(typeof response.data === 'object' &&
      response.data !== null &&
      !Array.isArray(response.data)
        ? (response.data as Record<string, unknown>)
        : { data: response.data }),
    },
    null,
    2,
  );
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
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
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
  'scheduler_upsert_job',
  'Create or update a scheduler job. Idempotent by job ID.',
  {
    job_id: z.string().optional(),
    name: z.string(),
    prompt: z.string(),
    schedule_type: z.enum(['cron', 'interval', 'once', 'manual']),
    schedule_value: z.string().default(''),
    linked_sessions: z.array(z.string()).optional(),
    group_scope: z.string().optional(),
    timeout_ms: z.number().optional(),
    max_retries: z.number().optional(),
    retry_backoff_ms: z.number().optional(),
    max_consecutive_failures: z.number().optional(),
  },
  async (args) => {
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'Invalid cron expression.' }],
          isError: true,
        };
      }
    }
    if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: 'Invalid interval milliseconds.' }],
          isError: true,
        };
      }
    }
    if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: 'Invalid once timestamp.' }],
          isError: true,
        };
      }
    }

    const data = {
      type: 'scheduler_upsert_job',
      jobId: args.job_id,
      name: args.name,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      linkedSessions: args.linked_sessions,
      groupScope: args.group_scope,
      timeoutMs: args.timeout_ms,
      maxRetries: args.max_retries,
      retryBackoffMs: args.retry_backoff_ms,
      maxConsecutiveFailures: args.max_consecutive_failures,
      createdBy: 'agent',
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return {
      content: [{ type: 'text' as const, text: 'Scheduler job upsert requested.' }],
    };
  },
);

server.tool(
  'scheduler_get_job',
  'Get one scheduler job by ID from host snapshots.',
  { job_id: z.string() },
  async (args) => {
    const jobs = readJsonArraySnapshot(path.join(IPC_DIR, 'current_jobs.json'));
    const job =
      jobs.find(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          'id' in item &&
          (item as { id?: string }).id === args.job_id,
      ) || null;
    return {
      content: [
        {
          type: 'text' as const,
          text: job ? JSON.stringify(job, null, 2) : 'Job not found.',
        },
      ],
    };
  },
);

server.tool(
  'scheduler_list_jobs',
  'List scheduler jobs from host snapshots.',
  {
    statuses: z.array(z.string()).optional(),
    group_scope: z.string().optional(),
  },
  async (args) => {
    const jobs = readJsonArraySnapshot(path.join(IPC_DIR, 'current_jobs.json'));
    const filtered = jobs.filter((item) => {
      if (typeof item !== 'object' || item === null) return false;
      const row = item as { status?: string; group_scope?: string };
      if (args.statuses && args.statuses.length > 0) {
        if (!row.status || !args.statuses.includes(row.status)) return false;
      }
      if (args.group_scope && row.group_scope !== args.group_scope) return false;
      return true;
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(filtered, null, 2) }],
    };
  },
);

server.tool(
  'scheduler_update_job',
  'Update mutable fields on a scheduler job.',
  {
    job_id: z.string(),
    name: z.string().optional(),
    prompt: z.string().optional(),
    schedule_type: z.enum(['cron', 'interval', 'once', 'manual']).optional(),
    schedule_value: z.string().optional(),
    linked_sessions: z.array(z.string()).optional(),
    group_scope: z.string().optional(),
    timeout_ms: z.number().optional(),
    max_retries: z.number().optional(),
    retry_backoff_ms: z.number().optional(),
    max_consecutive_failures: z.number().optional(),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'scheduler_update_job',
      jobId: args.job_id,
      name: args.name,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      linkedSessions: args.linked_sessions,
      groupScope: args.group_scope,
      timeoutMs: args.timeout_ms,
      maxRetries: args.max_retries,
      retryBackoffMs: args.retry_backoff_ms,
      maxConsecutiveFailures: args.max_consecutive_failures,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: 'Scheduler job update requested.' }],
    };
  },
);

server.tool(
  'scheduler_delete_job',
  'Delete a scheduler job.',
  { job_id: z.string() },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'scheduler_delete_job',
      jobId: args.job_id,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: 'Scheduler job delete requested.' }],
    };
  },
);

server.tool(
  'scheduler_pause_job',
  'Pause a scheduler job.',
  { job_id: z.string() },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'scheduler_pause_job',
      jobId: args.job_id,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: 'Scheduler job pause requested.' }],
    };
  },
);

server.tool(
  'scheduler_resume_job',
  'Resume a paused scheduler job.',
  { job_id: z.string() },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'scheduler_resume_job',
      jobId: args.job_id,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: 'Scheduler job resume requested.' }],
    };
  },
);

server.tool(
  'scheduler_trigger_job',
  'Trigger a scheduler job immediately.',
  { job_id: z.string() },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'scheduler_trigger_job',
      jobId: args.job_id,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: 'Scheduler trigger requested.' }],
    };
  },
);

server.tool(
  'scheduler_list_runs',
  'List job runs from host snapshots.',
  {
    job_id: z.string().optional(),
    limit: z.number().optional(),
  },
  async (args) => {
    const runs = readJsonArraySnapshot(path.join(IPC_DIR, 'current_job_runs.json'));
    const filtered = runs
      .filter((item) => {
        if (typeof item !== 'object' || item === null) return false;
        if (!args.job_id) return true;
        return (item as { job_id?: string }).job_id === args.job_id;
      })
      .slice(0, args.limit ?? 50);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(filtered, null, 2) }],
    };
  },
);

server.tool(
  'scheduler_get_dead_letter',
  'List dead-lettered job runs from host snapshots.',
  { limit: z.number().optional() },
  async (args) => {
    const runs = readJsonArraySnapshot(path.join(IPC_DIR, 'current_job_runs.json'))
      .filter(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          (item as { status?: string }).status === 'dead_lettered',
      )
      .slice(0, args.limit ?? 50);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(runs, null, 2) }],
    };
  },
);

server.tool(
  'memory_search',
  'Search durable memory using lexical+embedding fusion and return scoped snippets with provenance.',
  {
    query: z.string().describe('Search query'),
    group_folder: z
      .string()
      .optional()
      .describe('Optional override group folder (defaults to current group)'),
    user_id: z.string().optional().describe('Optional user id for user-scoped facts'),
    limit: z.number().int().min(1).max(20).optional().describe('Max results'),
  },
  async (args) => {
    const response = await requestMemoryAction('memory_search', {
      query: args.query,
      group_folder: args.group_folder || groupFolder,
      user_id: args.user_id,
      limit: args.limit,
    });
    if (!response.ok) {
      return {
        content: [{ type: 'text' as const, text: `Memory search failed: ${response.error || 'unknown error'}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: formatMemoryToolResponse(response) }],
    };
  },
);

server.tool(
  'memory_save',
  'Save a durable memory fact/preference/correction item.',
  {
    scope: z.enum(['user', 'group', 'global']).optional(),
    group_folder: z.string().optional(),
    user_id: z.string().optional(),
    kind: z.enum(['preference', 'fact', 'context', 'correction', 'recent_work']).optional(),
    key: z.string(),
    value: z.string(),
    confidence: z.number().min(0).max(1).optional(),
    source: z.string().optional(),
  },
  async (args) => {
    const response = await requestMemoryAction('memory_save', args);
    if (!response.ok) {
      return {
        content: [{ type: 'text' as const, text: `Memory save failed: ${response.error || 'unknown error'}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: formatMemoryToolResponse(response) }],
    };
  },
);

server.tool(
  'memory_patch',
  'Patch an existing memory item using optimistic concurrency.',
  {
    id: z.string(),
    expected_version: z.number().int().min(1),
    key: z.string().optional(),
    value: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  },
  async (args) => {
    const response = await requestMemoryAction('memory_patch', args);
    if (!response.ok) {
      return {
        content: [{ type: 'text' as const, text: `Memory patch failed: ${response.error || 'unknown error'}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: formatMemoryToolResponse(response) }],
    };
  },
);

server.tool(
  'procedure_save',
  'Save a reusable procedure learned from successful work.',
  {
    scope: z.enum(['user', 'group', 'global']).optional(),
    group_folder: z.string().optional(),
    title: z.string(),
    body: z.string(),
    tags: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    source: z.string().optional(),
  },
  async (args) => {
    const response = await requestMemoryAction('procedure_save', args);
    if (!response.ok) {
      return {
        content: [{ type: 'text' as const, text: `Procedure save failed: ${response.error || 'unknown error'}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: formatMemoryToolResponse(response) }],
    };
  },
);

server.tool(
  'procedure_patch',
  'Patch an existing procedure using optimistic concurrency.',
  {
    id: z.string(),
    expected_version: z.number().int().min(1),
    title: z.string().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
  },
  async (args) => {
    const response = await requestMemoryAction('procedure_patch', args);
    if (!response.ok) {
      return {
        content: [{ type: 'text' as const, text: `Procedure patch failed: ${response.error || 'unknown error'}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: formatMemoryToolResponse(response) }],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
