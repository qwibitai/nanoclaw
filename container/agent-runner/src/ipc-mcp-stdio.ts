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
const discordGuildId = process.env.NANOCLAW_DISCORD_GUILD_ID || undefined;
const serverFolder = process.env.NANOCLAW_SERVER_FOLDER || undefined;

// S3 mode detection
const S3_ENDPOINT = process.env.NANOCLAW_S3_ENDPOINT || '';
const S3_ACCESS_KEY_ID = process.env.NANOCLAW_S3_ACCESS_KEY_ID || '';
const S3_SECRET_ACCESS_KEY = process.env.NANOCLAW_S3_SECRET_ACCESS_KEY || '';
const S3_BUCKET = process.env.NANOCLAW_S3_BUCKET || '';
const S3_REGION = process.env.NANOCLAW_S3_REGION || '';
const S3_AGENT_ID = process.env.NANOCLAW_AGENT_ID || groupFolder;
const IS_S3_MODE = !!S3_ENDPOINT;

let s3Client: any = null;

function getS3Client() {
  if (s3Client) return s3Client;
  if (!IS_S3_MODE) return null;
  s3Client = new (globalThis as any).Bun.S3Client({
    endpoint: S3_ENDPOINT,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    bucket: S3_BUCKET,
    region: S3_REGION || undefined,
  });
  return s3Client;
}

async function writeS3File(key: string, data: string): Promise<void> {
  const client = getS3Client();
  if (!client) throw new Error('S3 client not available');
  await client.write(key, data);
}

async function readS3File(key: string): Promise<string | null> {
  const client = getS3Client();
  if (!client) return null;
  try {
    const file = client.file(key);
    const exists = await file.exists();
    if (!exists) return null;
    return await file.text();
  } catch {
    return null;
  }
}

function writeIpcFile(dir: string, data: object): string {
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;

  if (IS_S3_MODE) {
    // S3 mode: write to agent's IPC prefix in S3
    // dir is like '/workspace/ipc/messages' → extract the last segment
    const ipcType = path.basename(dir); // 'messages' or 'tasks'
    const key = `agents/${S3_AGENT_ID}/ipc/${ipcType}/${filename}`;
    writeS3File(key, JSON.stringify(data, null, 2)).catch((err) => {
      // Fallback to filesystem
      fs.mkdirSync(dir, { recursive: true });
      const filepath = path.join(dir, filename);
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    });
  } else {
    // Filesystem mode
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    // Atomic write: temp file then rename
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filepath);
  }

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  `Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group. You can also send to other agents by specifying target_jid (check agent_registry.json for available agents and their JIDs).`,
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
    target_jid: z.string().optional().describe('Send to a different group/agent by JID. Check /workspace/ipc/agent_registry.json for available targets. Defaults to current group.'),
  },
  async (args) => {
    const targetJid = args.target_jid || chatJid;

    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid: targetJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `Message sent${targetJid !== chatJid ? ` to ${targetJid}` : ''}.` }] };
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
  'configure_heartbeat',
  `Enable or disable the heartbeat for a group. The heartbeat is a recurring background task that runs on a schedule.

What the heartbeat does is controlled by the ## Heartbeat section in CLAUDE.md — edit that to customize behavior. The heartbeat also reads ## Goals from CLAUDE.md, so maintain your goals there.

After enabling, edit your CLAUDE.md to add/update the ## Heartbeat and ## Goals sections to control what the heartbeat does.`,
  {
    enabled: z.boolean().describe('Whether to enable or disable the heartbeat'),
    interval: z.string().default('1800000').describe('Schedule: milliseconds for interval type, or cron expression for cron type (default: "1800000" = 30 min)'),
    schedule_type: z.enum(['cron', 'interval']).default('interval').describe('Type of schedule (default: "interval")'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to configure. Defaults to current group.'),
  },
  async (args) => {
    // Non-main groups can only configure themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    if (args.enabled && args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.interval);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron expression: "${args.interval}". Use format like "0 */30 * * *" (every 30 min) or "0 9 * * *" (daily 9am).` }],
          isError: true,
        };
      }
    } else if (args.enabled && args.schedule_type === 'interval') {
      const ms = parseInt(args.interval, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.interval}". Must be positive milliseconds (e.g., "1800000" for 30 min).` }],
          isError: true,
        };
      }
    }

    const data = {
      type: 'configure_heartbeat',
      enabled: args.enabled,
      interval: args.interval,
      heartbeat_schedule_type: args.schedule_type,
      target_group_jid: targetJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    if (args.enabled) {
      return {
        content: [{ type: 'text' as const, text: `Heartbeat enabled (${args.schedule_type}: ${args.interval}). Edit ## Heartbeat and ## Goals in your CLAUDE.md to customize what the heartbeat does.` }],
      };
    } else {
      return {
        content: [{ type: 'text' as const, text: 'Heartbeat disabled. The recurring heartbeat task has been removed.' }],
      };
    }
  },
);

server.tool(
  'register_group',
  `Register a new group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat"). For Discord channels, provide the discord_guild_id to enable server-level shared context.

Backend options: "apple-container" (local VM, default), "sprites" (cloud VM on Fly.io — persistent, always-on).`,
  {
    jid: z.string().describe('The group JID (e.g., "120363336345536173@g.us" for WhatsApp, "dc:123456" for Discord)'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    discord_guild_id: z.string().optional().describe('Discord guild/server ID — enables server-level shared context across channels'),
    backend: z.enum(['apple-container', 'docker', 'sprites']).optional().describe('Backend to run this agent on (default: apple-container)'),
    description: z.string().optional().describe('What this agent does (shown in agent registry, helps other agents route requests)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data: Record<string, string | undefined> = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      discord_guild_id: args.discord_guild_id,
      backend: args.backend,
      group_description: args.description,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const backendInfo = args.backend ? ` (backend: ${args.backend})` : '';
    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered${backendInfo}. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'share_request',
  `Request context from another agent or the admin. Use this when you need information from another project, context from a different group, or data outside your workspace.

If you know which agent has the context (check /workspace/ipc/agent_registry.json), specify target_agent to route directly to them.
You can also share files to another agent or request files from them.

The request is sent to the target agent (or admin if no target specified) who can then share the relevant context.`,
  {
    description: z.string().describe('What context or information you need and why'),
    target_agent: z.string().optional().describe('Agent ID to request from (e.g., "main", "ditto-discord"). Check agent_registry.json for available agents.'),
    scope: z.enum(['channel', 'server', 'auto']).default('auto')
      .describe('Where the shared context should go: channel (just this channel), server (all channels in this Discord server), or auto (let admin decide)'),
    files: z.array(z.string()).optional().describe('Paths to SHARE (send TO target agent). Relative to /workspace/group/.'),
    request_files: z.array(z.string()).optional().describe('Paths to REQUEST (ask target agent to send back). Relative to their /workspace/group/.'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'share_request',
      description: args.description,
      target_agent: args.target_agent,
      scope: args.scope,
      files: args.files,
      request_files: args.request_files,
      sourceGroup: groupFolder,
      chatJid,
      serverFolder,
      discordGuildId,
      timestamp: new Date().toISOString(),
    });

    const targetInfo = args.target_agent ? ` to agent "${args.target_agent}"` : ' to admin';
    const filesInfo = args.files?.length ? ` Sharing ${args.files.length} file(s).` : '';
    const requestInfo = args.request_files?.length ? ` Requesting ${args.request_files.length} file(s).` : '';

    return { content: [{ type: 'text' as const, text: `Context request sent${targetInfo}.${filesInfo}${requestInfo} They'll review it and share relevant information if approved.` }] };
  },
);

server.tool(
  'delegate_task',
  `Delegate a task to the local (admin) agent when you need access to local resources you don't have.
Use this when you need:
- Local filesystem access (git repos, project files)
- Command execution on the local machine
- Access to resources not in your workspace

The task will be sent to the admin for approval. Once approved, the local agent will execute it
and notify you when results are available via context storage.`,
  {
    description: z.string().describe('What needs to be done on the local machine'),
    callback_agent_id: z.string().optional().describe('Agent ID to notify when done (defaults to current agent)'),
    files: z.array(z.string()).optional().describe('Paths to include with the request (relative to /workspace/group/)'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'delegate_task',
      description: args.description,
      callbackAgentId: args.callback_agent_id || groupFolder,
      files: args.files,
      sourceGroup: groupFolder,
      chatJid,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `Task delegated to local agent for approval: "${args.description.slice(0, 100)}..."` }],
    };
  },
);

server.tool(
  'request_context',
  `Request context or information from the local agent or admin.
Use this when you need project status, repo information, or any context that hasn't been shared with you yet.
The request goes to the admin for approval, then the local agent writes the context to your shared storage.`,
  {
    description: z.string().describe('What context or information you need and why'),
    requested_topics: z.array(z.string()).optional().describe('Specific topic names to request (e.g., ["api-refactor", "project-overview"])'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'context_request',
      description: args.description,
      requestedTopics: args.requested_topics,
      sourceGroup: groupFolder,
      chatJid,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `Context requested from admin: "${args.description.slice(0, 100)}..."` }],
    };
  },
);

server.tool(
  'read_context',
  `Read shared context that has been written to your context storage.
Context is stored as markdown files by topic name. Use list_context_topics first to see what's available.`,
  {
    topic: z.string().describe('The topic name to read (e.g., "project-overview", "api-refactor")'),
  },
  async (args) => {
    if (IS_S3_MODE) {
      // S3 mode: read from agent's context prefix
      const key = `agents/${S3_AGENT_ID}/context/${args.topic}.md`;
      const content = await readS3File(key);
      if (!content) {
        return { content: [{ type: 'text' as const, text: `No context found for topic "${args.topic}".` }] };
      }
      return { content: [{ type: 'text' as const, text: content }] };
    } else {
      // Filesystem mode: read from workspace
      const contextPath = path.join('/workspace/group/context', `${args.topic}.md`);
      try {
        if (!fs.existsSync(contextPath)) {
          return { content: [{ type: 'text' as const, text: `No context found for topic "${args.topic}".` }] };
        }
        const content = fs.readFileSync(contextPath, 'utf-8');
        return { content: [{ type: 'text' as const, text: content }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error reading context: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  },
);

server.tool(
  'list_context_topics',
  'List all available context topics in your shared context storage.',
  {},
  async () => {
    if (IS_S3_MODE) {
      // S3 mode: list context prefix
      // We can't easily list S3 without the full client, so check known paths
      return { content: [{ type: 'text' as const, text: 'S3 context listing not yet implemented. Use read_context with a specific topic name.' }] };
    } else {
      const contextDir = '/workspace/group/context';
      try {
        if (!fs.existsSync(contextDir)) {
          return { content: [{ type: 'text' as const, text: 'No context directory found. No context has been shared yet.' }] };
        }
        const files = fs.readdirSync(contextDir).filter((f) => f.endsWith('.md'));
        if (files.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No context topics found.' }] };
        }
        const topics = files.map((f) => f.replace(/\.md$/, ''));
        return { content: [{ type: 'text' as const, text: `Available context topics:\n${topics.map((t) => `- ${t}`).join('\n')}` }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error listing context: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  },
);

server.tool(
  'list_agents',
  `List all registered agents in the NanoClaw system. Use this to discover available agents for communication.

Returns information about each agent including their ID, name, description, backend type, and JID (for messaging).
This is useful when you need to send messages to specific agents or request context from them.`,
  {
    filter_backend: z.enum(['apple-container', 'docker', 'sprites', 'daytona', 'railway', 'hetzner']).optional()
      .describe('Optional: filter agents by backend type'),
    include_self: z.boolean().default(true)
      .describe('Include the current agent in results (default: true)'),
  },
  async (args) => {
    const registryPath = path.join(IPC_DIR, 'agent_registry.json');

    try {
      if (!fs.existsSync(registryPath)) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Agent registry not found. No agents registered yet.'
          }]
        };
      }

      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));

      if (!Array.isArray(registry) || registry.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No agents found in registry.'
          }]
        };
      }

      // Filter agents
      let agents = registry;

      if (args.filter_backend) {
        agents = agents.filter((a: any) => a.backend === args.filter_backend);
      }

      if (!args.include_self) {
        agents = agents.filter((a: any) => a.id !== groupFolder);
      }

      if (agents.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No agents match your filter criteria.'
          }]
        };
      }

      // Format output as a table-like structure
      const lines = ['Available Agents:', ''];

      for (const agent of agents) {
        const isCurrent = agent.id === groupFolder ? ' (current)' : '';
        const mainBadge = agent.isMain ? ' [MAIN]' : '';
        const localBadge = agent.isLocal ? ' [LOCAL]' : ' [CLOUD]';

        lines.push(`*${agent.name}*${isCurrent}${mainBadge}${localBadge}`);
        lines.push(`  • ID: \`${agent.id}\``);
        lines.push(`  • JID: \`${agent.jid}\``);
        if (agent.jids && agent.jids.length > 1) {
          lines.push(`  • All JIDs: ${agent.jids.map((j: string) => `\`${j}\``).join(', ')}`);
        }
        lines.push(`  • Backend: ${agent.backend}`);
        lines.push(`  • Trigger: ${agent.trigger}`);

        if (agent.description) {
          lines.push(`  • Description: ${agent.description}`);
        }

        lines.push('');
      }

      const summary = `Found ${agents.length} agent${agents.length !== 1 ? 's' : ''}`;
      const text = `${summary}\n\n${lines.join('\n')}`;

      return {
        content: [{
          type: 'text' as const,
          text
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading agent registry: ${err instanceof Error ? err.message : String(err)}`
        }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
