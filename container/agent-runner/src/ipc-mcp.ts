/**
 * IPC-based MCP Server for NanoClaw
 * Writes messages and tasks to files for the host process to pick up
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const SEARCH_TIMEOUT_MS = 10000;
const MAX_QUERY_LENGTH = 512;

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  age?: string;
}

interface BraveSearchResponse {
  web?: {
    results: BraveSearchResult[];
  };
}

function truncateText(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

async function braveSearch(
  query: string,
  count: number = 5,
): Promise<BraveSearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error('Web search is not configured.');
  }

  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }
  if (normalizedQuery.length > MAX_QUERY_LENGTH) {
    throw new Error(`Query too long (max ${MAX_QUERY_LENGTH} characters).`);
  }

  const params = new URLSearchParams({
    q: normalizedQuery,
    count: String(count),
    text_decorations: 'false',
    search_lang: 'en',
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${BRAVE_SEARCH_URL}?${params}`, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = truncateText(await response.text(), 200);
      if (response.status === 429) {
        throw new Error('Search rate limit exceeded. Try again later.');
      }
      throw new Error(`Search failed (${response.status}): ${errorBody}`);
    }

    const data: BraveSearchResponse = await response.json();

    if (!data.web?.results) {
      return [];
    }

    return data.web.results.map((r) => ({
      title: truncateText(r.title || '', 200),
      url: r.url,
      description: truncateText(r.description || '', 300),
      age: r.age,
    }));
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Search timed out. Try again.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

export interface IpcMcpContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
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

export function createIpcMcp(ctx: IpcMcpContext) {
  const { chatJid, groupFolder, isMain } = ctx;

  return createSdkMcpServer({
    name: 'nanoclaw',
    version: '1.0.0',
    tools: [
      tool(
        'send_message',
        'Send a message to the current WhatsApp group. Use this to proactively share information or updates.',
        {
          text: z.string().describe('The message text to send'),
        },
        async (args) => {
          const data = {
            type: 'message',
            chatJid,
            text: args.text,
            groupFolder,
            timestamp: new Date().toISOString(),
          };

          const filename = writeIpcFile(MESSAGES_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Message queued for delivery (${filename})`,
              },
            ],
          };
        },
      ),

      tool(
        'schedule_task',
        `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
• "group" (recommended for most tasks): Task runs in the group's conversation context, with access to chat history and memory. Use for tasks that need context about ongoing discussions, user preferences, or previous interactions.
• "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, ask the user. Examples:
- "Remind me about our discussion" → group (needs conversation context)
- "Check the weather every morning" → isolated (self-contained task)
- "Follow up on my request" → group (needs to know what was requested)
- "Generate a daily report" → isolated (just needs instructions in prompt)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
• interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
• once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
        {
          prompt: z
            .string()
            .describe(
              'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
            ),
          schedule_type: z
            .enum(['cron', 'interval', 'once'])
            .describe(
              'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
            ),
          schedule_value: z
            .string()
            .describe(
              'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
            ),
          context_mode: z
            .enum(['group', 'isolated'])
            .default('group')
            .describe(
              'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
            ),
          target_group: z
            .string()
            .optional()
            .describe(
              'Target group folder (main only, defaults to current group)',
            ),
        },
        async (args) => {
          // Validate schedule_value before writing IPC
          if (args.schedule_type === 'cron') {
            try {
              CronExpressionParser.parse(args.schedule_value);
            } catch (err) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
                  },
                ],
                isError: true,
              };
            }
          } else if (args.schedule_type === 'interval') {
            const ms = parseInt(args.schedule_value, 10);
            if (isNaN(ms) || ms <= 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
                  },
                ],
                isError: true,
              };
            }
          } else if (args.schedule_type === 'once') {
            const date = new Date(args.schedule_value);
            if (isNaN(date.getTime())) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".`,
                  },
                ],
                isError: true,
              };
            }
          }

          // Non-main groups can only schedule for themselves
          const targetGroup =
            isMain && args.target_group ? args.target_group : groupFolder;

          const data = {
            type: 'schedule_task',
            prompt: args.prompt,
            schedule_type: args.schedule_type,
            schedule_value: args.schedule_value,
            context_mode: args.context_mode || 'group',
            groupFolder: targetGroup,
            chatJid,
            createdBy: groupFolder,
            timestamp: new Date().toISOString(),
          };

          const filename = writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}`,
              },
            ],
          };
        },
      ),

      // Reads from current_tasks.json which host keeps updated
      tool(
        'list_tasks',
        "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
        {},
        async () => {
          const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

          try {
            if (!fs.existsSync(tasksFile)) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'No scheduled tasks found.',
                  },
                ],
              };
            }

            const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

            const tasks = isMain
              ? allTasks
              : allTasks.filter(
                  (t: { groupFolder: string }) => t.groupFolder === groupFolder,
                );

            if (tasks.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'No scheduled tasks found.',
                  },
                ],
              };
            }

            const formatted = tasks
              .map(
                (t: {
                  id: string;
                  prompt: string;
                  schedule_type: string;
                  schedule_value: string;
                  status: string;
                  next_run: string;
                }) =>
                  `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
              )
              .join('\n');

            return {
              content: [
                {
                  type: 'text',
                  text: `Scheduled tasks:\n${formatted}`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        },
      ),

      tool(
        'pause_task',
        'Pause a scheduled task. It will not run until resumed.',
        {
          task_id: z.string().describe('The task ID to pause'),
        },
        async (args) => {
          const data = {
            type: 'pause_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Task ${args.task_id} pause requested.`,
              },
            ],
          };
        },
      ),

      tool(
        'resume_task',
        'Resume a paused task.',
        {
          task_id: z.string().describe('The task ID to resume'),
        },
        async (args) => {
          const data = {
            type: 'resume_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Task ${args.task_id} resume requested.`,
              },
            ],
          };
        },
      ),

      tool(
        'cancel_task',
        'Cancel and delete a scheduled task.',
        {
          task_id: z.string().describe('The task ID to cancel'),
        },
        async (args) => {
          const data = {
            type: 'cancel_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Task ${args.task_id} cancellation requested.`,
              },
            ],
          };
        },
      ),

      tool(
        'register_group',
        `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
        {
          jid: z
            .string()
            .describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
          name: z.string().describe('Display name for the group'),
          folder: z
            .string()
            .describe(
              'Folder name for group files (lowercase, hyphens, e.g., "family-chat")',
            ),
          trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
        },
        async (args) => {
          if (!isMain) {
            return {
              content: [
                {
                  type: 'text',
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
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
              },
            ],
          };
        },
      ),

      tool(
        'web_search',
        'Search the web for current information. Returns titles, URLs, and descriptions of relevant web pages. Results are summaries from external sources - verify important facts via the provided URLs.',
        {
          query: z.string().describe('The search query'),
          count: z
            .number()
            .min(1)
            .max(20)
            .default(5)
            .describe('Number of results to return (1-20, default 5)'),
        },
        async (args) => {
          try {
            const results = await braveSearch(args.query, args.count);

            if (results.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `No results found for: "${args.query}"`,
                  },
                ],
              };
            }

            const formatResult = (r: BraveSearchResult, i: number): string => {
              let domain = '';
              try {
                domain = new URL(r.url).hostname;
              } catch {
                domain = r.url;
              }
              const age = r.age ? ` · ${r.age}` : '';
              return `[${i + 1}] ${r.title}\n    ${domain}${age}\n    ${r.description}\n    ${r.url}`;
            };

            const formatted = results.map(formatResult).join('\n\n');

            return {
              content: [
                {
                  type: 'text',
                  text: `Search results for "${args.query}":\n\n${formatted}`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
