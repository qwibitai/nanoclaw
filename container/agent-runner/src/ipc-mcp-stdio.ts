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
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".` }],
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

// --- Governance Pipeline Tools ---

server.tool(
  'gov_create_task',
  `Create a new governance task in the pipeline. Main group only.
The task starts in INBOX state. Use gov_assign to assign it to an agent group, then transition to READY for auto-dispatch.`,
  {
    title: z.string().describe('Task title'),
    description: z.string().optional().describe('Detailed description'),
    task_type: z.enum(['EPIC', 'FEATURE', 'BUG', 'SECURITY', 'REVOPS', 'OPS', 'RESEARCH', 'CONTENT', 'DOC', 'INCIDENT']),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
    product: z.string().optional().describe('Product name (for multi-product pipelines)'),
    assigned_group: z.string().optional().describe('Group folder to assign (e.g., "developer")'),
    gate: z.enum(['None', 'Security', 'RevOps', 'Claims', 'Product']).default('None').describe('Gate required before DONE'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can create governance tasks.' }],
        isError: true,
      };
    }

    const data = {
      type: 'gov_create',
      title: args.title,
      description: args.description,
      task_type: args.task_type,
      priority: args.priority,
      product: args.product,
      assigned_group: args.assigned_group,
      gate: args.gate,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Governance task created: "${args.title}" (${args.task_type}, ${args.priority})` }],
    };
  },
);

server.tool(
  'gov_transition',
  `Transition a governance task to the next state. Validated against the state machine policy.
Pipeline: INBOX → TRIAGED → READY → DOING → REVIEW → APPROVAL → DONE
Also: any state → BLOCKED, BLOCKED → previous states, REVIEW → DOING (rework)`,
  {
    task_id: z.string().describe('The governance task ID'),
    to_state: z.enum(['INBOX', 'TRIAGED', 'READY', 'DOING', 'REVIEW', 'APPROVAL', 'DONE', 'BLOCKED']),
    reason: z.string().optional().describe('Why this transition is happening'),
    expected_version: z.number().optional().describe('Task version for staleness check (from gov_pipeline.json)'),
  },
  async (args) => {
    const data = {
      type: 'gov_transition',
      taskId: args.task_id,
      toState: args.to_state,
      reason: args.reason,
      expectedVersion: args.expected_version,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Transition requested: ${args.task_id} → ${args.to_state}` }],
    };
  },
);

server.tool(
  'gov_approve',
  `Approve a gate for a governance task. Only the designated gate approver group (or main) can approve.
Gate mapping: Security→security group, RevOps/Claims/Product→main group.
The approver cannot be the same group that executed the task.`,
  {
    task_id: z.string().describe('The governance task ID'),
    gate_type: z.enum(['Security', 'RevOps', 'Claims', 'Product']),
    notes: z.string().optional().describe('Approval notes or conditions'),
  },
  async (args) => {
    const data = {
      type: 'gov_approve',
      taskId: args.task_id,
      gate_type: args.gate_type,
      notes: args.notes,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Gate approval requested: ${args.gate_type} for ${args.task_id}` }],
    };
  },
);

server.tool(
  'gov_assign',
  'Assign a governance task to an agent group. Main group only.',
  {
    task_id: z.string().describe('The governance task ID'),
    assigned_group: z.string().describe('Group folder to assign (e.g., "developer", "security")'),
    executor: z.string().optional().describe('Specific executor identity within the group'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can assign governance tasks.' }],
        isError: true,
      };
    }

    const data = {
      type: 'gov_assign',
      taskId: args.task_id,
      assigned_group: args.assigned_group,
      executor: args.executor,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${args.task_id} assigned to ${args.assigned_group}` }],
    };
  },
);

server.tool(
  'gov_list_pipeline',
  'List governance pipeline tasks. Main sees all tasks, other groups see only their assigned tasks. Reads from a snapshot written by the host.',
  {
    state: z.string().optional().describe('Filter by state (e.g., "DOING", "REVIEW")'),
    product: z.string().optional().describe('Filter by product'),
  },
  async (args) => {
    const snapshotFile = path.join(IPC_DIR, 'gov_pipeline.json');

    try {
      if (!fs.existsSync(snapshotFile)) {
        return { content: [{ type: 'text' as const, text: 'No governance pipeline data. The pipeline may not have been initialized yet.' }] };
      }

      const data = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8'));
      let tasks = data.tasks || [];

      if (args.state) {
        tasks = tasks.filter((t: { state: string }) => t.state === args.state);
      }
      if (args.product) {
        tasks = tasks.filter((t: { product: string }) => t.product === args.product);
      }

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No governance tasks match the filter.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; title: string; state: string; priority: string; assigned_group: string; gate: string; version: number }) =>
            `- [${t.id}] ${t.title} | ${t.state} | ${t.priority} | group: ${t.assigned_group || 'unassigned'} | gate: ${t.gate} | v${t.version}`,
        )
        .join('\n');

      return {
        content: [{ type: 'text' as const, text: `Governance pipeline (snapshot: ${data.generatedAt}):\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading pipeline: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

// --- External Access Broker Tools ---

import crypto from 'crypto';

// P0-7: HMAC request signing
function computeRequestSig(body: object): string | undefined {
  const secretPath = path.join(IPC_DIR, '.ipc_secret');
  if (!fs.existsSync(secretPath)) return undefined;

  const secret = fs.readFileSync(secretPath, 'utf-8').trim();
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(body))
    .digest('hex');
}

// Poll for response file with configurable timeout
async function pollForResponse(
  requestId: string,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<{ status: string; data?: unknown; error?: string; summary?: string }> {
  const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(responsePath)) {
      const raw = fs.readFileSync(responsePath, 'utf-8');
      // P0-1: Cleanup response file after reading
      try { fs.unlinkSync(responsePath); } catch { /* race ok */ }
      return JSON.parse(raw);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return { status: 'timeout', error: 'External call timed out waiting for response' };
}

server.tool(
  'ext_call',
  `Call an external service through the broker. The host executes the actual API call — you never hold credentials.
Available providers and your access levels are in ext_capabilities.json (use ext_capabilities tool to check).
For write actions (L2+), include idempotency_key to prevent duplicate operations on retry.
For production actions (L3), include task_id of the governance task with gate approvals.`,
  {
    provider: z.string().describe('Provider name (e.g., "github", "cloud-logs")'),
    action: z.string().describe('Action to perform (e.g., "list_issues", "create_pr")'),
    params: z.record(z.string(), z.unknown()).default({}).describe('Action-specific parameters'),
    task_id: z.string().optional().describe('Governance task ID (required for L3/production actions)'),
    idempotency_key: z.string().optional().describe('Unique key for write deduplication (recommended for L2+ actions)'),
  },
  async (args) => {
    const requestId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const body: Record<string, unknown> = {
      type: 'ext_call',
      request_id: requestId,
      provider: args.provider,
      action: args.action,
      params: args.params,
      task_id: args.task_id,
      idempotency_key: args.idempotency_key,
      timestamp: new Date().toISOString(),
    };

    // P0-7: Sign request
    const sig = computeRequestSig(body);
    if (sig) body.sig = sig;

    writeIpcFile(TASKS_DIR, body);

    // Poll for response
    const pollInterval = parseInt(process.env.EXT_POLL_INTERVAL_MS || '500', 10);
    const timeout = parseInt(process.env.EXT_CALL_TIMEOUT || '30000', 10);
    const response = await pollForResponse(requestId, timeout, pollInterval);

    if (response.status === 'executed') {
      return {
        content: [{
          type: 'text' as const,
          text: typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data, null, 2),
        }],
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: `External call ${response.status}: ${response.error || response.summary || 'Unknown error'}`,
      }],
      isError: true,
    };
  },
);

server.tool(
  'ext_capabilities',
  'List your external access capabilities — which providers and actions you can use, with access levels.',
  {},
  async () => {
    const capPath = path.join(IPC_DIR, 'ext_capabilities.json');
    if (!fs.existsSync(capPath)) {
      return {
        content: [{ type: 'text' as const, text: 'No external capabilities configured. Ask the coordinator to grant access.' }],
      };
    }
    const caps = JSON.parse(fs.readFileSync(capPath, 'utf-8'));

    // Format nicely
    const lines: string[] = [`External capabilities (snapshot: ${caps.generatedAt}):`];
    for (const cap of caps.capabilities || []) {
      lines.push(`\nProvider: ${cap.provider} (L${cap.access_level})`);
      if (cap.expires_at) lines.push(`  Expires: ${cap.expires_at}`);
      for (const [name, info] of Object.entries(cap.actions || {})) {
        const { level, description, status } = info as { level: number; description: string; status: string };
        const marker = status === 'available' ? '+' : status === 'DENIED' ? 'x' : '-';
        lines.push(`  [${marker}] ${name} (L${level}) - ${description}${status !== 'available' ? ` [${status}]` : ''}`);
      }
    }

    if ((caps.capabilities || []).length === 0) {
      lines.push('No capabilities granted yet.');
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

server.tool(
  'ext_grant',
  'Grant external access capability to a group. Main only. L2/L3 grants auto-expire in 7 days.',
  {
    group_folder: z.string().describe('Target group folder (e.g., "developer", "security")'),
    provider: z.string().describe('Provider name (e.g., "github", "cloud-logs")'),
    access_level: z.number().min(0).max(3).describe('0=none, 1=read, 2=write, 3=production'),
    allowed_actions: z.array(z.string()).optional().describe('Restrict to specific actions (null = all for level)'),
    denied_actions: z.array(z.string()).optional().describe('Explicitly deny specific actions (deny wins over allow)'),
    requires_task_gate: z.string().optional().describe('Gate type required for L3 actions (e.g., "Security")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can grant external capabilities.' }],
        isError: true,
      };
    }

    const data = {
      type: 'ext_grant',
      group_folder: args.group_folder,
      provider: args.provider,
      access_level: args.access_level,
      allowed_actions: args.allowed_actions || null,
      denied_actions: args.denied_actions || null,
      requires_task_gate: args.requires_task_gate,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{
        type: 'text' as const,
        text: `Capability grant requested: ${args.group_folder} -> ${args.provider} L${args.access_level}`,
      }],
    };
  },
);

server.tool(
  'ext_revoke',
  'Revoke external access capability from a group. Main only.',
  {
    group_folder: z.string().describe('Target group folder'),
    provider: z.string().describe('Provider name to revoke'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can revoke capabilities.' }],
        isError: true,
      };
    }

    const data = {
      type: 'ext_revoke',
      group_folder: args.group_folder,
      provider: args.provider,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{
        type: 'text' as const,
        text: `Capability revoke requested: ${args.group_folder} -> ${args.provider}`,
      }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
