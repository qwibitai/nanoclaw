/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, communicates with host via WebSocket.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { WsClient } from './ws-client.js';

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const wsUrl = process.env.NANOCLAW_WS_URL!;
const wsToken = process.env.NANOCLAW_WS_TOKEN!;

// Create WS client for communicating with the host
const wsClient = new WsClient(wsUrl, wsToken);
let wsReady = false;

// Connect asynchronously — tools that need it will await this
const wsConnectPromise = wsClient.connect().then(() => {
  wsReady = true;
}).catch((err) => {
  console.error(`[ipc-mcp] WS connect failed: ${err instanceof Error ? err.message : String(err)}`);
});

async function ensureWs(): Promise<void> {
  if (!wsReady) await wsConnectPromise;
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
    await ensureWs();
    wsClient.sendMessage(chatJid, args.text, args.sender || undefined);
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
    // Validate schedule_value before sending
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

    await ensureWs();
    wsClient.sendTask({
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
      content: [{ type: 'text' as const, text: `Task scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    await ensureWs();
    try {
      const tasks = await wsClient.listTasks();

      const filtered = isMain
        ? tasks
        : tasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (filtered.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = filtered
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string | null }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error listing tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    await ensureWs();
    wsClient.sendTask({
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
    await ensureWs();
    wsClient.sendTask({
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
    await ensureWs();
    wsClient.sendTask({
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
  `Register a new chat/group so the agent can respond to messages there. Main group only.

The groups data provided when the agent connects includes available groups with their JIDs. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
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

    await ensureWs();
    wsClient.sendTask({
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// --- X (Twitter) Integration Tools (main group only) ---

if (isMain) {
  server.tool(
    'x_post',
    `Post a tweet to X (Twitter). Main group only.
Make sure the content is appropriate and within X's character limit (280 chars for text).`,
    {
      content: z
        .string()
        .max(280)
        .describe('The tweet content to post (max 280 characters)'),
    },
    async (args) => {
      try {
        await ensureWs();
        const result = await wsClient.sendTaskRequest({
          type: 'x_post',
          content: args.content,
        });
        if (result.success) {
          return {
            content: [
              {
                type: 'text' as const,
                text: result.message as string,
              },
            ],
          };
        }
        return {
          content: [
            { type: 'text' as const, text: result.message as string },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `X post failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'x_like',
    'Like a tweet on X (Twitter). Provide the tweet URL or tweet ID.',
    {
      tweet_url: z
        .string()
        .describe(
          'The tweet URL (e.g., https://x.com/user/status/123) or tweet ID',
        ),
    },
    async (args) => {
      try {
        await ensureWs();
        const result = await wsClient.sendTaskRequest({
          type: 'x_like',
          tweetUrl: args.tweet_url,
        });
        if (result.success) {
          return {
            content: [
              { type: 'text' as const, text: result.message as string },
            ],
          };
        }
        return {
          content: [
            { type: 'text' as const, text: result.message as string },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `X like failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'x_reply',
    'Reply to a tweet on X (Twitter). Provide the tweet URL and your reply content.',
    {
      tweet_url: z
        .string()
        .describe(
          'The tweet URL (e.g., https://x.com/user/status/123) or tweet ID',
        ),
      content: z
        .string()
        .max(280)
        .describe('The reply content (max 280 characters)'),
    },
    async (args) => {
      try {
        await ensureWs();
        const result = await wsClient.sendTaskRequest({
          type: 'x_reply',
          tweetUrl: args.tweet_url,
          content: args.content,
        });
        if (result.success) {
          return {
            content: [
              { type: 'text' as const, text: result.message as string },
            ],
          };
        }
        return {
          content: [
            { type: 'text' as const, text: result.message as string },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `X reply failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'x_retweet',
    'Retweet a tweet on X (Twitter). Provide the tweet URL.',
    {
      tweet_url: z
        .string()
        .describe(
          'The tweet URL (e.g., https://x.com/user/status/123) or tweet ID',
        ),
    },
    async (args) => {
      try {
        await ensureWs();
        const result = await wsClient.sendTaskRequest({
          type: 'x_retweet',
          tweetUrl: args.tweet_url,
        });
        if (result.success) {
          return {
            content: [
              { type: 'text' as const, text: result.message as string },
            ],
          };
        }
        return {
          content: [
            { type: 'text' as const, text: result.message as string },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `X retweet failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'x_quote',
    'Quote tweet on X (Twitter). Retweet with your own comment added.',
    {
      tweet_url: z
        .string()
        .describe(
          'The tweet URL (e.g., https://x.com/user/status/123) or tweet ID',
        ),
      comment: z
        .string()
        .max(280)
        .describe('Your comment for the quote tweet (max 280 characters)'),
    },
    async (args) => {
      try {
        await ensureWs();
        const result = await wsClient.sendTaskRequest({
          type: 'x_quote',
          tweetUrl: args.tweet_url,
          comment: args.comment,
        });
        if (result.success) {
          return {
            content: [
              { type: 'text' as const, text: result.message as string },
            ],
          };
        }
        return {
          content: [
            { type: 'text' as const, text: result.message as string },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `X quote failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
