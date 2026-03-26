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
const LI_RESULTS_DIR = path.join(IPC_DIR, 'li_results');

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

// ─── LinkedIn Automation Tools ────────────────────────────────────────────────

function writeLiIpcFile(data: object): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(TASKS_DIR, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
}

async function waitForLiResult(requestId: string, maxWait = 180000): Promise<{ success: boolean; message: string; data?: unknown }> {
  const resultFile = path.join(LI_RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 1000;
  let elapsed = 0;
  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch {
        return { success: false, message: 'Failed to read result file' };
      }
    }
    await new Promise(r => setTimeout(r, pollInterval));
    elapsed += pollInterval;
  }
  return { success: false, message: 'Request timed out (3 min)' };
}

function makeLiId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function liDispatch(type: string, requestId: string, payload: object): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  writeLiIpcFile({ type, requestId, groupFolder, timestamp: new Date().toISOString(), ...payload });
  const result = await waitForLiResult(requestId);
  const text = result.data
    ? `${result.message}\n\n${JSON.stringify(result.data, null, 2)}`
    : result.message;
  return { content: [{ type: 'text' as const, text }], isError: !result.success || undefined };
}

const liMainOnly = { content: [{ type: 'text' as const, text: 'LinkedIn tools are only available in the main group.' }], isError: true as const };

server.tool('li_visit_profile',
  'Visit a LinkedIn profile page. Registers as a profile view. Updates lead status to Visited in Notion.',
  { profile_url: z.string().describe('LinkedIn profile URL (e.g. https://linkedin.com/in/johndoe)') },
  async ({ profile_url }: { profile_url: string }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_visit_profile', makeLiId('li-visit'), { profileUrl: profile_url });
  }
);

server.tool('li_connect',
  'Send a LinkedIn connection request. Optionally include a personalized note (max 300 chars). Respects daily limit.',
  {
    profile_url: z.string().describe('LinkedIn profile URL'),
    note: z.string().optional().describe('Optional personalized note (max 300 chars)'),
  },
  async ({ profile_url, note }: { profile_url: string; note?: string }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_connect', makeLiId('li-connect'), { profileUrl: profile_url, note });
  }
);

server.tool('li_withdraw_request',
  'Withdraw a pending LinkedIn connection request.',
  { profile_url: z.string().describe('LinkedIn profile URL of the pending request to withdraw') },
  async ({ profile_url }: { profile_url: string }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_withdraw_request', makeLiId('li-withdraw'), { profileUrl: profile_url });
  }
);

server.tool('li_message',
  'Send a direct message to a 1st-degree LinkedIn connection. Respects daily message limit.',
  {
    profile_url: z.string().describe('LinkedIn profile URL'),
    message: z.string().describe('The message to send'),
  },
  async ({ profile_url, message }: { profile_url: string; message: string }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_message', makeLiId('li-msg'), { profileUrl: profile_url, message });
  }
);

server.tool('li_follow',
  'Follow a LinkedIn person or company page.',
  { profile_url: z.string().describe('LinkedIn profile or company page URL') },
  async ({ profile_url }: { profile_url: string }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_follow', makeLiId('li-follow'), { profileUrl: profile_url });
  }
);

server.tool('li_unfollow',
  'Unfollow a LinkedIn person or company page.',
  { profile_url: z.string().describe('LinkedIn profile or company page URL') },
  async ({ profile_url }: { profile_url: string }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_unfollow', makeLiId('li-unfollow'), { profileUrl: profile_url });
  }
);

server.tool('li_like_post',
  'Like a LinkedIn post.',
  { post_url: z.string().describe('LinkedIn post URL') },
  async ({ post_url }: { post_url: string }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_like_post', makeLiId('li-like'), { postUrl: post_url });
  }
);

server.tool('li_react_post',
  'React to a LinkedIn post with a specific reaction: like, celebrate, support, funny, love, insightful, or curious.',
  {
    post_url: z.string().describe('LinkedIn post URL'),
    reaction: z.enum(['like', 'celebrate', 'support', 'funny', 'love', 'insightful', 'curious']).describe('Reaction type'),
  },
  async ({ post_url, reaction }: { post_url: string; reaction: string }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_react_post', makeLiId('li-react'), { postUrl: post_url, reaction });
  }
);

server.tool('li_comment_post',
  'Comment on a LinkedIn post.',
  {
    post_url: z.string().describe('LinkedIn post URL'),
    comment: z.string().describe('The comment text to post'),
  },
  async ({ post_url, comment }: { post_url: string; comment: string }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_comment_post', makeLiId('li-comment'), { postUrl: post_url, comment });
  }
);

server.tool('li_share_post',
  'Share or repost a LinkedIn post, optionally with your own commentary.',
  {
    post_url: z.string().describe('LinkedIn post URL'),
    commentary: z.string().optional().describe('Optional commentary to add when sharing'),
  },
  async ({ post_url, commentary }: { post_url: string; commentary?: string }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_share_post', makeLiId('li-share'), { postUrl: post_url, commentary });
  }
);

server.tool('li_endorse_skill',
  "Endorse a specific skill on someone's LinkedIn profile.",
  {
    profile_url: z.string().describe('LinkedIn profile URL'),
    skill: z.string().describe('The skill name to endorse (must match exactly)'),
  },
  async ({ profile_url, skill }: { profile_url: string; skill: string }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_endorse_skill', makeLiId('li-endorse'), { profileUrl: profile_url, skill });
  }
);

server.tool('li_scrape_search',
  'Search LinkedIn for people matching a query and save them as leads to Notion.',
  {
    query: z.string().describe('Search query (e.g. "Head of Growth SaaS London")'),
    max_leads: z.number().optional().describe('Max number of leads to scrape (default: 25, max: 100)'),
    campaign: z.string().optional().describe('Campaign name to tag these leads with in Notion'),
  },
  async ({ query, max_leads, campaign }: { query: string; max_leads?: number; campaign?: string }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_scrape_search', makeLiId('li-search'), { query, maxLeads: max_leads, campaign });
  }
);

server.tool('li_scrape_profile',
  'Scrape a single LinkedIn profile and save all data to Notion.',
  {
    profile_url: z.string().describe('LinkedIn profile URL'),
    campaign: z.string().optional().describe('Campaign tag for this lead'),
    source: z.string().optional().describe('Where this lead came from (e.g. Search, Event, Referral)'),
  },
  async ({ profile_url, campaign, source }: { profile_url: string; campaign?: string; source?: string }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_scrape_profile', makeLiId('li-scrape-profile'), { profileUrl: profile_url, campaign, source });
  }
);

server.tool('li_scrape_post_engagers',
  'Extract people who reacted to or commented on a LinkedIn post and save them as leads to Notion.',
  {
    post_url: z.string().describe('LinkedIn post URL'),
    max_leads: z.number().optional().describe('Max leads to scrape (default: 50)'),
    campaign: z.string().optional().describe('Campaign tag'),
    type: z.enum(['reactions', 'comments']).optional().describe('Scrape reactions (default) or comments'),
  },
  async ({ post_url, max_leads, campaign, type }: { post_url: string; max_leads?: number; campaign?: string; type?: 'reactions' | 'comments' }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_scrape_post_engagers', makeLiId('li-post-engagers'), { postUrl: post_url, maxLeads: max_leads, campaign, type });
  }
);

server.tool('li_run_campaign',
  'Run an automated LinkedIn outreach campaign. Processes leads from Notion and runs visit → connect → message sequence.',
  {
    steps: z.array(z.enum(['visit', 'connect', 'message'])).describe('Steps to run in order'),
    connect_note: z.string().optional().describe('Connection request note. Use {name} for first name.'),
    message_text: z.string().optional().describe('Message to send. Use {name} for first name.'),
    campaign: z.string().optional().describe('Only process leads in this campaign'),
    from_status: z.enum(['New', 'Visited', 'Requested', 'Connected', 'Messaged', 'Replied', 'Archived']).optional().describe('Process leads with this status (default: New)'),
    max_leads: z.number().optional().describe('Max leads to process this run (default: 10)'),
  },
  async (args: { steps: string[]; connect_note?: string; message_text?: string; campaign?: string; from_status?: string; max_leads?: number }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_run_campaign', makeLiId('li-campaign'), {
      steps: args.steps,
      connectNote: args.connect_note,
      messageText: args.message_text,
      campaign: args.campaign,
      fromStatus: args.from_status,
      maxLeads: args.max_leads,
    });
  }
);

server.tool('li_bulk_message',
  'Send a personalized message to all Connected leads in Notion. Use {name} for first name personalization.',
  {
    message_text: z.string().describe('Message template. Use {name} for recipient first name.'),
    campaign: z.string().optional().describe('Only message leads in this campaign'),
    max_messages: z.number().optional().describe('Max messages to send this run (default: 20)'),
  },
  async ({ message_text, campaign, max_messages }: { message_text: string; campaign?: string; max_messages?: number }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_bulk_message', makeLiId('li-bulk-msg'), { messageText: message_text, campaign, maxMessages: max_messages });
  }
);

server.tool('li_get_campaign_stats',
  'Get LinkedIn outreach stats from Notion — counts of leads by status.',
  { campaign: z.string().optional().describe('Filter stats to a specific campaign') },
  async ({ campaign }: { campaign?: string }) => {
    if (!isMain) return liMainOnly;
    return liDispatch('li_get_campaign_stats', makeLiId('li-stats'), { campaign });
  }
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
