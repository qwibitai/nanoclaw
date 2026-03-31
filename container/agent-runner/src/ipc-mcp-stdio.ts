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
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
// Report-to JID available for future use — container actions still target the group
const _reportToJid = process.env.NANOCLAW_REPORT_TO_JID || '';

const GROUP_DIR = '/workspace/group';

/** Ensure a file is inside /workspace/group/ so the host can access it via the mount. */
function ensureInGroupDir(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(GROUP_DIR + '/')) return resolved;
  const dest = path.join(GROUP_DIR, path.basename(resolved));
  fs.copyFileSync(resolved, dest);
  return dest;
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
  "Send a message, image, document, or audio to the user or group immediately while you're still running. Use this for progress updates, to send multiple messages, to deliver generated images, or to send document files (PDF, etc.). You can call this multiple times.",
  {
    text: z.string().describe('The message text to send (used as caption when sending an image)'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
    image_path: z.string().optional().describe('Absolute path to an image file (e.g. /workspace/group/generated-123.png). When provided, sends a native image with the text as caption.'),
    audio_path: z.string().optional().describe('Absolute path to an audio file (e.g. /workspace/group/tts-123.ogg). When provided, sends a native voice note. Text is ignored.'),
    video_path: z.string().optional().describe('Absolute path to a video file (e.g. /workspace/group/video-123.mp4). When provided, sends a native inline video. Text is used as caption.'),
    document_path: z.string().optional().describe('Absolute path to a document file (e.g. /workspace/group/cotizacion.pdf). When provided, sends the file as a native document attachment. Text is used as caption.'),
    sticker_path: z.string().optional().describe('Absolute path to a WebP sticker file (e.g. /workspace/group/stickers/saludo.webp). Sends a native WhatsApp sticker. Must be 512x512 WebP.'),
  },
  async (args) => {
    if (args.sticker_path) {
      const filename = path.basename(args.sticker_path);
      const subdir = path.basename(path.dirname(args.sticker_path));
      const data = {
        type: 'sticker',
        chatJid,
        filename,
        subdir: subdir !== 'group' ? subdir : undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      };
      writeIpcFile(MESSAGES_DIR, data);
      return { content: [{ type: 'text' as const, text: 'Sticker queued for delivery.' }] };
    }

    if (args.video_path) {
      const safePath = ensureInGroupDir(args.video_path);
      const filename = path.basename(safePath);
      const data = {
        type: 'video',
        chatJid,
        filename,
        caption: args.text || '',
        groupFolder,
        timestamp: new Date().toISOString(),
      };
      writeIpcFile(MESSAGES_DIR, data);
      return { content: [{ type: 'text' as const, text: 'Video queued for delivery.' }] };
    }

    if (args.document_path) {
      const safePath = ensureInGroupDir(args.document_path);
      const filename = path.basename(safePath);
      const data = {
        type: 'document',
        chatJid,
        filename,
        originalName: filename,
        caption: args.text || '',
        groupFolder,
        timestamp: new Date().toISOString(),
      };
      writeIpcFile(MESSAGES_DIR, data);
      return { content: [{ type: 'text' as const, text: 'Document queued for delivery.' }] };
    }

    if (args.audio_path) {
      const safePath = ensureInGroupDir(args.audio_path);
      const filename = path.basename(safePath);
      const data = {
        type: 'audio',
        chatJid,
        filename,
        groupFolder,
        timestamp: new Date().toISOString(),
      };
      writeIpcFile(MESSAGES_DIR, data);
      return { content: [{ type: 'text' as const, text: 'Audio queued for delivery.' }] };
    }

    if (args.image_path) {
      const safePath = ensureInGroupDir(args.image_path);
      const filename = path.basename(safePath);
      const data = {
        type: 'image',
        chatJid,
        filename,
        caption: args.text,
        groupFolder,
        timestamp: new Date().toISOString(),
      };
      writeIpcFile(MESSAGES_DIR, data);
      return { content: [{ type: 'text' as const, text: 'Image queued for delivery.' }] };
    }

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
  'send_reaction',
  'React to a message with an emoji. Use message IDs from the conversation context. Great for acknowledging messages (👍), confirming actions (✅), or showing appreciation (❤️🔥).',
  {
    message_id: z.string().describe('The message ID to react to (from the conversation context)'),
    participant: z.string().optional().describe('The sender_jid of the message to react to (required for group chats)'),
    emoji: z.string().describe('Emoji to react with (e.g., "👍", "❤️", "✅", "🔥", "😂")'),
  },
  async (args) => {
    const data = {
      type: 'reaction',
      chatJid,
      messageId: args.message_id,
      participant: args.participant || undefined,
      emoji: args.emoji,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `Reacted with ${args.emoji}` }] };
  },
);

server.tool(
  'update_profile_picture',
  'Change the group profile picture. Image should be square (640x640+ recommended).',
  {
    image_path: z.string().describe('Absolute path to the image file (e.g. /workspace/group/profile.jpg)'),
  },
  async (args) => {
    const filename = path.basename(args.image_path);
    if (filename.includes('/') || filename.includes('..')) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid filename.' }],
        isError: true,
      };
    }
    const data = {
      type: 'update_profile_picture',
      chatJid,
      filename,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return { content: [{ type: 'text' as const, text: 'Group profile picture update requested.' }] };
  },
);

server.tool(
  'update_group_name',
  'Rename the WhatsApp group. Changes the group subject/title visible to all members.',
  {
    name: z.string().describe('The new group name'),
  },
  async (args) => {
    const data = {
      type: 'update_group_name',
      chatJid,
      name: args.name,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return { content: [{ type: 'text' as const, text: `Group rename to "${args.name}" requested.` }] };
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
    requires_trigger: z.boolean().optional().describe('Whether @trigger prefix is needed. Default true for groups, set false for 1-on-1 chats.'),
    mcp_servers: z.array(z.string()).optional().describe('Which extra MCP servers to enable for this group (e.g., ["easybits", "smatch"]). "nanoclaw" is always included. Omit to enable all servers.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data: Record<string, unknown> = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };
    if (args.requires_trigger !== undefined) {
      data.requiresTrigger = args.requires_trigger;
    }
    if (args.mcp_servers) {
      data.containerConfig = { mcpServers: args.mcp_servers };
    }

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'get_invite_link',
  'Get the WhatsApp group invite link for this chat. Returns a https://chat.whatsapp.com/... URL that can be shared with others to join the group. Only works for WhatsApp groups.',
  {},
  async () => {
    const baseUrl = process.env.ANTHROPIC_BASE_URL;
    if (!baseUrl) {
      return {
        content: [{ type: 'text' as const, text: 'No proxy URL configured.' }],
        isError: true,
      };
    }

    try {
      const url = `${baseUrl}/nanoclaw/invite-link?jid=${encodeURIComponent(chatJid)}`;
      const httpGet = url.startsWith('https') ? https.get.bind(https) : http.get.bind(http);
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        httpGet(url, (resp: http.IncomingMessage) => {
          let data = '';
          resp.on('data', (c: Buffer) => data += c);
          resp.on('end', () => resolve({ status: resp.statusCode || 500, body: data }));
        }).on('error', reject);
      });

      const parsed = JSON.parse(res.body);
      if (parsed.link) {
        return { content: [{ type: 'text' as const, text: parsed.link }] };
      }
      return {
        content: [{ type: 'text' as const, text: parsed.error || 'Could not generate invite link. The bot may not be an admin in this group.' }],
        isError: true,
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- AWS SES email sending (raw HTTPS, no SDK dependency) ---

function awsSign(key: Buffer, msg: string): Buffer {
  return crypto.createHmac('sha256', key).update(msg).digest();
}

function awsSha256(msg: string): string {
  return crypto.createHash('sha256').update(msg).digest('hex');
}

function sendSesEmail(to: string, subject: string, bodyHtml: string, bodyText?: string): Promise<string> {
  const region = process.env.SES_REGION || 'us-east-2';
  const accessKey = process.env.SES_KEY!;
  const secretKey = process.env.SES_SECRET!;
  const fromEmail = process.env.SES_FROM_EMAIL!;
  const fromName = process.env.SES_FROM_NAME || 'Ghosty';

  const host = `email.${region}.amazonaws.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const dateStamp = amzDate.slice(0, 8);

  const params = new URLSearchParams();
  params.append('Action', 'SendEmail');
  params.append('Source', `${fromName} <${fromEmail}>`);
  params.append('Destination.ToAddresses.member.1', to);
  params.append('Message.Subject.Data', subject);
  params.append('Message.Subject.Charset', 'UTF-8');
  if (bodyHtml) {
    params.append('Message.Body.Html.Data', bodyHtml);
    params.append('Message.Body.Html.Charset', 'UTF-8');
  }
  params.append('Message.Body.Text.Data', bodyText || subject);
  params.append('Message.Body.Text.Charset', 'UTF-8');

  const body = params.toString();
  const payloadHash = awsSha256(body);

  const canonicalHeaders = `content-type:application/x-www-form-urlencoded\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-date';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const credScope = `${dateStamp}/${region}/ses/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credScope}\n${awsSha256(canonicalRequest)}`;

  let signingKey = awsSign(Buffer.from('AWS4' + secretKey), dateStamp);
  signingKey = awsSign(signingKey, region);
  signingKey = awsSign(signingKey, 'ses');
  signingKey = awsSign(signingKey, 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Host': host,
        'X-Amz-Date': amzDate,
        'Authorization': authHeader,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const match = data.match(/<MessageId>(.+?)<\/MessageId>/);
          resolve(match ? match[1] : 'sent');
        } else {
          reject(new Error(`SES error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

server.tool(
  'send_email',
  'Send an email via AWS SES. Use for sending reports, notifications, or any content the user requests via email. Supports HTML body for rich formatting.',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject line'),
    body_html: z.string().describe('Email body in HTML format'),
    body_text: z.string().optional().describe('Plain text fallback (defaults to subject if omitted)'),
  },
  async (args) => {
    if (!process.env.SES_KEY || !process.env.SES_FROM_EMAIL) {
      return {
        content: [{ type: 'text' as const, text: 'Email not configured: SES credentials missing.' }],
        isError: true,
      };
    }
    try {
      const messageId = await sendSesEmail(args.to, args.subject, args.body_html, args.body_text);
      return { content: [{ type: 'text' as const, text: `Email sent to ${args.to} (MessageId: ${messageId})` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to send email: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
