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
import { validateScheduleValue } from './validation.js';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

/** Poll for a result file written by the host. Returns parsed JSON or null on timeout. */
async function pollForResult(
  dir: string,
  requestId: string,
  maxAttempts = 30,
): Promise<Record<string, unknown> | null> {
  const resultFile = path.join(dir, `${requestId}.json`);
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      if (fs.existsSync(resultFile)) {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      }
    } catch {
      // File might not exist yet, keep polling
    }
  }
  return null;
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
  'send_image',
  `Send an image file to the user or group. The image must exist in the container filesystem (e.g., /workspace/group/output/chart.png). Use this for screenshots, charts, generated images, downloaded photos, etc.

The file must be accessible from the container. Common locations:
• /workspace/group/output/ — for generated content
• /workspace/group/images/ — for downloaded/processed images
• /workspace/case/ — for case-specific files`,
  {
    image_path: z
      .string()
      .describe(
        'Absolute path to the image file inside the container (e.g., /workspace/group/output/chart.png)',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional caption/description to accompany the image'),
  },
  async (args) => {
    // Verify the file exists before sending IPC
    if (!fs.existsSync(args.image_path)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Image file not found: ${args.image_path}`,
          },
        ],
        isError: true,
      };
    }

    const data: Record<string, string | undefined> = {
      type: 'image',
      chatJid,
      imagePath: args.image_path,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return {
      content: [{ type: 'text' as const, text: 'Image sent.' }],
    };
  },
);

server.tool(
  'send_document',
  `Send a document or file to the user or group. Use this for PDFs, spreadsheets, text files, converted files, or any non-image file the user needs.

The file must be accessible from the container. Common locations:
• /workspace/group/output/ — for generated content
• /workspace/group/ — for processed files
• /workspace/case/ — for case-specific files`,
  {
    document_path: z
      .string()
      .describe(
        'Absolute path to the document file inside the container (e.g., /workspace/group/output/report.pdf)',
      ),
    filename: z
      .string()
      .optional()
      .describe(
        'Optional display name for the document (defaults to the file basename)',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional caption/description to accompany the document'),
  },
  async (args) => {
    if (!fs.existsSync(args.document_path)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Document file not found: ${args.document_path}`,
          },
        ],
        isError: true,
      };
    }

    const data: Record<string, string | undefined> = {
      type: 'document',
      chatJid,
      documentPath: args.document_path,
      filename: args.filename || undefined,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return {
      content: [{ type: 'text' as const, text: 'Document sent.' }],
    };
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
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    const validation = validateScheduleValue(
      args.schedule_type,
      args.schedule_value,
    );
    if (!validation.valid) {
      return {
        content: [{ type: 'text' as const, text: validation.error! }],
        isError: true,
      };
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

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
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
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
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
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
            { type: 'text' as const, text: 'No scheduled tasks found.' },
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
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
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
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
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

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
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

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_value && args.schedule_type) {
      const validation = validateScheduleValue(
        args.schedule_type,
        args.schedule_value,
      );
      if (!validation.valid) {
        return {
          content: [{ type: 'text' as const, text: validation.error! }],
          isError: true,
        };
      }
    } else if (args.schedule_value && !args.schedule_type) {
      // When no schedule_type given, try cron validation as default
      const validation = validateScheduleValue('cron', args.schedule_value);
      if (!validation.valid) {
        return {
          content: [{ type: 'text' as const, text: validation.error! }],
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
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
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

// ---------------------------------------------------------------------------
// Case lifecycle tools
// ---------------------------------------------------------------------------

server.tool(
  'list_cases',
  `List all active cases (work items). Shows case name, type, status, description, last activity, and cost.
From main group: shows all cases. From other groups: shows only that group's cases.`,
  {},
  async () => {
    const casesFile = path.join(IPC_DIR, 'active_cases.json');

    try {
      if (!fs.existsSync(casesFile)) {
        return {
          content: [{ type: 'text' as const, text: 'No active cases.' }],
        };
      }

      const cases = JSON.parse(fs.readFileSync(casesFile, 'utf-8'));
      if (cases.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No active cases.' }],
        };
      }

      const formatted = cases
        .map(
          (c: {
            name: string;
            type: string;
            status: string;
            description: string;
            last_message: string | null;
            last_activity_at: string | null;
            total_cost_usd: number;
            time_spent_ms: number;
            blocked_on: string | null;
            initiator: string;
          }) => {
            const blocked = c.blocked_on ? ` [blocked: ${c.blocked_on}]` : '';
            const cost =
              c.total_cost_usd > 0 ? `$${c.total_cost_usd.toFixed(2)}` : '$0';
            return `- [${c.name}] (${c.type}, ${c.status}${blocked}) — ${c.description.slice(0, 80)}\n  Last: "${(c.last_message || 'none').slice(0, 60)}" | Cost: ${cost} | By: ${c.initiator}`;
          },
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Active cases:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading cases: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'create_case',
  `Create a new work case (isolated work item). Use this when the user asks you to do something that warrants tracking as a discrete piece of work — research, analysis, writing, multi-step tasks, etc.

The case gets its own workspace and session, so subsequent messages routed to it have isolated context. Don't create cases for simple one-off questions.

Case types:
• "work" — Uses existing tooling for productive work (research, analysis, writing). Gets a scratch directory.
• "dev" — Improves tooling/workflows to make future work better. Gets a git worktree. Use sparingly.`,
  {
    short_name: z
      .string()
      .optional()
      .describe(
        'A cute case name: "{Client FirstName} {Last Initial}. {OneWordTask} {FunAdjective}". Use the client/user\'s name, one word for the task, and one cute irrelevant adjective. Examples: "Aviad R. Banner Fun", "Moshe A. Runner Incredible", "Sarah K. Logo Sparkly", "Demarco T. CMYK Magnificent".',
      ),
    description: z
      .string()
      .describe(
        'Brief description of what this case is about (shown in case status)',
      ),
    context: z
      .string()
      .optional()
      .describe(
        'Rich context for the GitHub issue. For dev cases, this MUST include: (1) the original user messages that triggered this case (close to verbatim, abridged if very long), and (2) any relevant details, requirements, or constraints discussed. This becomes the body of the GitHub issue — without it, the issue will lack critical context. For work cases this is optional.',
      ),
    case_type: z
      .enum(['work', 'dev'])
      .default('work')
      .describe('Type of case: work (default) or dev'),
  },
  async (args) => {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'case_create',
      shortName: args.short_name,
      description: args.description,
      context: args.context,
      caseType: args.case_type || 'work',
      chatJid,
      initiator: 'agent',
      groupFolder,
      requestId,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Poll for result (host processes IPC files every ~1s, dev cases also create a GitHub issue)
    const result = await pollForResult(
      path.join(IPC_DIR, 'case_results'),
      requestId,
    );
    if (result) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Case created:\n  ID: ${result.id}\n  Name: ${result.name}\n  Workspace: ${result.workspace_path}${result.issue_url ? `\n  GitHub: ${result.issue_url}` : ''}\n\nThe case is now ACTIVE. Future messages about this topic will be routed to it.`,
          },
        ],
      };
    }

    // Timeout — the IPC was written, case will be created but we can't confirm
    return {
      content: [
        {
          type: 'text' as const,
          text: `Case creation requested for: "${args.description}". It should appear shortly in the active cases list.`,
        },
      ],
    };
  },
);

server.tool(
  'case_mark_done',
  `Mark the current case as done. You MUST include:
1. A conclusion summarizing what was accomplished
2. A kaizen reflection: list any bugs, impediments, inefficiencies, difficulties, annoyances, or blockers you encountered.
   For each, suggest what improvement would help: QoL features, bug fixes, cached knowledge, hooks, gates/reviews/checks, workflow improvements.
   These become suggested dev cases for continuous improvement.

The case will move to DONE status and await user review before being pruned.`,
  {
    case_id: z.string().describe('The case ID to mark as done'),
    conclusion: z
      .string()
      .describe(
        'Brief summary of what was done and the outcome (2-3 sentences)',
      ),
    kaizen: z
      .array(
        z.object({
          issue: z.string().describe('What went wrong or was suboptimal'),
          suggestion: z
            .string()
            .describe('What tooling/workflow improvement would help'),
          severity: z
            .enum(['low', 'medium', 'high'])
            .describe('How much this impacted the work'),
        }),
      )
      .optional()
      .describe(
        'Kaizen reflections — improvements that would make future cases better',
      ),
  },
  async (args) => {
    const data = {
      type: 'case_mark_done',
      caseId: args.case_id,
      conclusion: args.conclusion,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Submit each kaizen reflection as a suggested dev case
    if (args.kaizen && args.kaizen.length > 0) {
      for (const k of args.kaizen) {
        const suggestData = {
          type: 'case_suggest_dev',
          sourceCaseId: args.case_id,
          description: `[${k.severity}] ${k.issue} → ${k.suggestion}`,
          groupFolder,
          chatJid,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, suggestData);
      }
    }

    const kaizenCount = args.kaizen?.length || 0;
    return {
      content: [
        {
          type: 'text' as const,
          text: `Case ${args.case_id} marked as done. Awaiting review.${kaizenCount > 0 ? ` ${kaizenCount} kaizen suggestion(s) submitted.` : ''}`,
        },
      ],
    };
  },
);

server.tool(
  'case_mark_blocked',
  `Mark the current case as blocked. Specify what you're blocked on (e.g., "user decision needed", "waiting for API access", "depends on case X").
This pauses time tracking and signals the user that input is needed.`,
  {
    case_id: z.string().describe('The case ID to mark as blocked'),
    blocked_on: z
      .string()
      .describe(
        'What is blocking progress (e.g., "user input needed", "waiting for deploy")',
      ),
  },
  async (args) => {
    const data = {
      type: 'case_mark_blocked',
      caseId: args.case_id,
      blocked_on: args.blocked_on,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Case ${args.case_id} marked as blocked on: ${args.blocked_on}`,
        },
      ],
    };
  },
);

server.tool(
  'case_mark_active',
  'Resume a blocked case, marking it as active again.',
  {
    case_id: z.string().describe('The case ID to resume'),
  },
  async (args) => {
    const data = {
      type: 'case_mark_active',
      caseId: args.case_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);
    return {
      content: [
        { type: 'text' as const, text: `Case ${args.case_id} resumed.` },
      ],
    };
  },
);

server.tool(
  'case_suggest_dev',
  `Suggest a dev case (tooling/workflow improvement) based on friction encountered during ANY case — successful or not.
Use this when:
• You hit a limitation, missing feature, or workflow problem
• The user gives negative feedback or corrections that could be prevented by better tooling
• A workaround was needed that could be eliminated
• A task took longer than it should have due to tooling gaps
The suggestion stays in SUGGESTED status until the user approves it → BACKLOG.`,
  {
    source_case_id: z
      .string()
      .describe('The work case ID where the issue was encountered'),
    description: z
      .string()
      .describe('What tooling/workflow improvement would help (one paragraph)'),
  },
  async (args) => {
    const data = {
      type: 'case_suggest_dev',
      sourceCaseId: args.source_case_id,
      description: args.description,
      groupFolder,
      chatJid,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Dev case suggested from ${args.source_case_id}. User will be notified for approval.`,
        },
      ],
    };
  },
);

// GitHub issue creation — proxied through host (no token in containers)
server.tool(
  'create_github_issue',
  `Create a GitHub issue to escalate a problem or request dev help. The issue is created by the host (no GitHub token needed in the container).

Use this when:
• You hit a problem you can't solve and need dev intervention
• You discover a bug or missing feature in the tooling
• You want to suggest an improvement for the kaizen backlog

The issue will be created in the specified repo with allowed labels, and the team will be notified via Telegram.

Allowed repos: Garsson-io/kaizen (for improvements and bugs).
Allowed labels: work-agent, needs-dev, kaizen, bug, enhancement.`,
  {
    title: z
      .string()
      .describe('Issue title — clear, concise summary of the problem'),
    body: z
      .string()
      .describe(
        'Issue body — detailed description: what happened, what you tried, what you expected. Markdown supported.',
      ),
    owner: z
      .string()
      .default('Garsson-io')
      .describe('GitHub org/owner (default: Garsson-io)'),
    repo: z
      .string()
      .default('kaizen')
      .describe('Repository name (default: kaizen)'),
    labels: z
      .array(z.string())
      .default(['work-agent', 'needs-dev'])
      .describe('Labels to apply (filtered to allowed set)'),
  },
  async (args) => {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'create_github_issue',
      owner: args.owner || 'Garsson-io',
      repo: args.repo || 'kaizen',
      title: args.title,
      body: args.body,
      labels: args.labels || ['work-agent', 'needs-dev'],
      requestId,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const result = await pollForResult(
      path.join(IPC_DIR, 'issue_results'),
      requestId,
    );
    if (result) {
      if (result.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Issue created: ${result.issueUrl}\nNumber: #${result.issueNumber}`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to create issue: ${result.error}`,
            },
          ],
          isError: true,
        };
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Issue creation requested but timed out waiting for confirmation. The host may still process it.',
        },
      ],
    };
  },
);

// Router-specific tool — only registered when running as the message router
if (groupFolder === '__router__') {
  const ROUTER_RESULTS_DIR = path.join(IPC_DIR, 'results');
  server.tool(
    'route_decision',
    `Submit your routing decision for the current message. You MUST call this tool exactly once per routing request.

Decisions:
• "route_to_case" — message belongs to an existing case (provide caseId + caseName)
• "direct_answer" — simple question you can answer directly (provide directAnswer text)
• "suggest_new" — no case matches, system should create a new case or handle without case context`,
    {
      request_id: z.string().describe('The requestId from the routing prompt'),
      decision: z
        .enum(['route_to_case', 'direct_answer', 'suggest_new'])
        .describe('Your routing decision'),
      case_id: z
        .string()
        .optional()
        .describe('Case ID to route to (required for route_to_case)'),
      case_name: z
        .string()
        .optional()
        .describe('Case name (required for route_to_case)'),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .describe('Confidence in your decision (0.0 to 1.0)'),
      reason: z.string().describe('Brief explanation of your routing decision'),
      direct_answer: z
        .string()
        .optional()
        .describe('Answer text (required for direct_answer)'),
    },
    async (args) => {
      fs.mkdirSync(ROUTER_RESULTS_DIR, { recursive: true });

      const result = {
        requestId: args.request_id,
        decision: args.decision,
        caseId: args.case_id,
        caseName: args.case_name,
        confidence: args.confidence,
        reason: args.reason,
        directAnswer: args.direct_answer,
        timestamp: new Date().toISOString(),
      };

      const filepath = path.join(ROUTER_RESULTS_DIR, `${args.request_id}.json`);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(result, null, 2));
      fs.renameSync(tempPath, filepath);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Routing decision submitted: ${args.decision}${args.case_name ? ` → ${args.case_name}` : ''}`,
          },
        ],
      };
    },
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
