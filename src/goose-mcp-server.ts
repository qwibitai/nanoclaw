/**
 * HTTP MCP Server for Goose (local model) sessions.
 *
 * Provides the same tools as the container-side ipc-mcp-stdio.ts but
 * runs on the host as an HTTP MCP endpoint. Started before Goose is
 * launched and stopped after it exits.
 *
 * Tools: send_message, send_image, schedule_task, list_tasks,
 *        pause_task, resume_task, cancel_task, register_group
 */

import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export interface GooseMcpConfig {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

export interface GooseMcpHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

function registerTools(
  server: McpServer,
  config: GooseMcpConfig,
  messagesDir: string,
  tasksDir: string,
  ipcDir: string,
  groupDir: string,
): void {
  const { chatJid, groupFolder, isMain } = config;

  server.tool(
    'send_message',
    "Send a message to the user or group immediately while you're still running. " +
      'Use this for progress updates or to send multiple messages. You can call this multiple times. ' +
      'Note: when running as a scheduled task, your final output is NOT sent to the user — ' +
      'use this tool if you need to communicate with the user or group.',
    {
      text: z.string().describe('The message text to send'),
      sender: z
        .string()
        .optional()
        .describe(
          'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot.',
        ),
    },
    async (args) => {
      writeIpcFile(messagesDir, {
        type: 'message',
        chatJid,
        text: args.text,
        sender: args.sender || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
    },
  );

  server.tool(
    'send_image',
    'Send an image to the user or group. Accepts a local file path or a URL. ' +
      'For the research-assistant dashboard, use url="http://localhost:3000/api/dashboard.png". ' +
      'For science assets, use url="http://localhost:3000/api/assets/{id}/image?fmt=jpeg&w=1600".',
    {
      file_path: z
        .string()
        .optional()
        .describe('Path to an image file (container paths like /workspace/group/... are translated automatically)'),
      url: z
        .string()
        .optional()
        .describe('URL to fetch the image from'),
      caption: z.string().optional().describe('Optional caption for the image'),
    },
    async (args) => {
      if (!args.file_path && !args.url) {
        return {
          content: [{ type: 'text' as const, text: 'Must provide file_path or url.' }],
          isError: true,
        };
      }

      let imageBuffer: Buffer;
      try {
        if (args.url) {
          const resp = await fetch(args.url);
          if (!resp.ok) {
            return {
              content: [
                { type: 'text' as const, text: `Failed to fetch image: ${resp.status} ${resp.statusText}` },
              ],
              isError: true,
            };
          }
          const contentType = resp.headers.get('content-type') || '';
          if (!contentType.startsWith('image/')) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `URL returned ${contentType} instead of an image.`,
                },
              ],
              isError: true,
            };
          }
          imageBuffer = Buffer.from(await resp.arrayBuffer());
        } else {
          // Translate container paths to host paths
          let hostPath = args.file_path!;
          if (hostPath.startsWith('/workspace/group/')) {
            hostPath = path.join(groupDir, hostPath.slice('/workspace/group/'.length));
          }
          imageBuffer = fs.readFileSync(hostPath);
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error reading image: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }

      // Write binary image to IPC
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const imageFile = `${id}.bin`;
      fs.writeFileSync(path.join(messagesDir, imageFile), imageBuffer);

      writeIpcFile(messagesDir, {
        type: 'image',
        chatJid,
        imageFile,
        caption: args.caption,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      return { content: [{ type: 'text' as const, text: 'Image sent.' }] };
    },
  );

  server.tool(
    'schedule_task',
    `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE:
- "group": Task runs with chat history context.
- "isolated": Task runs in a fresh session.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
- cron: Standard cron expression (e.g., "0 9 * * *" for daily at 9am)
- interval: Milliseconds between runs (e.g., "300000" for 5 minutes)
- once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00")`,
    {
      prompt: z.string().describe('What the agent should do when the task runs'),
      schedule_type: z.enum(['cron', 'interval', 'once']),
      schedule_value: z.string(),
      context_mode: z.enum(['group', 'isolated']).default('group'),
      target_group_jid: z
        .string()
        .optional()
        .describe('(Main group only) JID of the target group'),
    },
    async (args) => {
      if (args.schedule_type === 'cron') {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      } else if (args.schedule_type === 'interval') {
        const ms = parseInt(args.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          return {
            content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      } else if (args.schedule_type === 'once') {
        if (isNaN(new Date(args.schedule_value).getTime())) {
          return {
            content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }

      const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

      writeIpcFile(tasksDir, {
        type: 'schedule_task',
        prompt: args.prompt,
        schedule_type: args.schedule_type,
        schedule_value: args.schedule_value,
        context_mode: args.context_mode || 'group',
        targetJid,
        createdBy: groupFolder,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [
          { type: 'text' as const, text: `Task scheduled: ${args.schedule_type} - ${args.schedule_value}` },
        ],
      };
    },
  );

  server.tool(
    'list_tasks',
    "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
    {},
    async () => {
      const tasksFile = path.join(ipcDir, 'current_tasks.json');
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
          content: [
            {
              type: 'text' as const,
              text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    'pause_task',
    'Pause a scheduled task. It will not run until resumed.',
    { task_id: z.string().describe('The task ID to pause') },
    async (args) => {
      writeIpcFile(tasksDir, {
        type: 'pause_task',
        taskId: args.task_id,
        groupFolder,
        isMain,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
    },
  );

  server.tool(
    'resume_task',
    'Resume a paused task.',
    { task_id: z.string().describe('The task ID to resume') },
    async (args) => {
      writeIpcFile(tasksDir, {
        type: 'resume_task',
        taskId: args.task_id,
        groupFolder,
        isMain,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
    },
  );

  server.tool(
    'cancel_task',
    'Cancel and delete a scheduled task.',
    { task_id: z.string().describe('The task ID to cancel') },
    async (args) => {
      writeIpcFile(tasksDir, {
        type: 'cancel_task',
        taskId: args.task_id,
        groupFolder,
        isMain,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
    },
  );

  server.tool(
    'register_group',
    'Register a new group so the agent can respond to messages there. Main group only.',
    {
      jid: z.string().describe('The group JID'),
      name: z.string().describe('Display name for the group'),
      folder: z.string().describe('Folder name (lowercase, hyphens)'),
      trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    },
    async (args) => {
      if (!isMain) {
        return {
          content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
          isError: true,
        };
      }
      writeIpcFile(tasksDir, {
        type: 'register_group',
        jid: args.jid,
        name: args.name,
        folder: args.folder,
        trigger: args.trigger,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [
          { type: 'text' as const, text: `Group "${args.name}" registered.` },
        ],
      };
    },
  );
}

/**
 * Start a temporary HTTP MCP server for a Goose session.
 * Returns a handle with the port, URL, and close function.
 */
export async function startGooseMcpServer(config: GooseMcpConfig): Promise<GooseMcpHandle> {
  const ipcDir = path.join(DATA_DIR, 'ipc', config.groupFolder);
  const messagesDir = path.join(ipcDir, 'messages');
  const tasksDir = path.join(ipcDir, 'tasks');
  const groupDir = path.resolve(process.cwd(), 'groups', config.groupFolder);

  fs.mkdirSync(messagesDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });

  const mcpServer = new McpServer({ name: 'nanoclaw', version: '1.0.0' });
  registerTools(mcpServer, config, messagesDir, tasksDir, ipcDir, groupDir);

  // Map of active transports keyed by session ID
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== '/mcp') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'GET') {
      // SSE stream for server-initiated messages
      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res);
      } else {
        res.writeHead(400);
        res.end('Bad Request: missing or invalid session');
      }
      return;
    }

    if (req.method === 'DELETE') {
      // Session termination
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        transports.delete(sessionId);
      } else {
        res.writeHead(404);
        res.end('Session not found');
      }
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    // POST — either new session (initialize) or existing session request
    // Parse body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    // Check if this is an existing session
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, body);
      return;
    }

    // New session — check that this is an initialize request
    const isInitialize =
      (Array.isArray(body) && body.some((m: { method?: string }) => m.method === 'initialize')) ||
      body.method === 'initialize';

    if (!isInitialize) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Request: first request must be initialize' }));
      return;
    }

    // Create new transport for this session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    // Connect a fresh McpServer to this transport
    const sessionServer = new McpServer({ name: 'nanoclaw', version: '1.0.0' });
    registerTools(sessionServer, config, messagesDir, tasksDir, ipcDir, groupDir);
    await sessionServer.connect(transport);

    // Handle the initialize request
    await transport.handleRequest(req, res, body);

    // Store transport by session ID (extracted from response headers after handleRequest)
    // The transport stores its session ID internally; we capture it from the response
    const responseSid = res.getHeader('mcp-session-id') as string | undefined;
    if (responseSid) {
      transports.set(responseSid, transport);
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/mcp`;
      logger.info({ port: addr.port, url, group: config.groupFolder }, 'Goose MCP server started');
      resolve({
        port: addr.port,
        url,
        close: async () => {
          for (const transport of transports.values()) {
            await transport.close().catch(() => {});
          }
          transports.clear();
          return new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });
  });
}
