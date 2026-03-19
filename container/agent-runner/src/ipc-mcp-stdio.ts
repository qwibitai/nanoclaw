/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 *
 * This is a thin wiring layer — business logic lives in ipc-handlers.ts,
 * IPC utilities in ipc-utils.ts. Extracted for testability (kaizen #167).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { McpConfig } from './ipc-handlers.js';
import {
  handleSendMessage,
  handleSendImage,
  handleSendDocument,
  handleScheduleTask,
  handleListTasks,
  handlePauseTask,
  handleResumeTask,
  handleCancelTask,
  handleUpdateTask,
  handleRegisterGroup,
  handleListCases,
  handleCreateCase,
  handleCaseMarkDone,
  handleCaseMarkBlocked,
  handleAddCaseComment,
  handleAttachCaseArtifact,
  handleCaseMarkActive,
  handleCaseSuggestDev,
  handleCreateGithubIssue,
  handleRouteDecision,
} from './ipc-handlers.js';

// Context from environment variables (set by the agent runner)
const config: McpConfig = {
  chatJid: process.env.NANOCLAW_CHAT_JID!,
  groupFolder: process.env.NANOCLAW_GROUP_FOLDER!,
  isMain: process.env.NANOCLAW_IS_MAIN === '1',
  ipcDir: '/workspace/ipc',
};

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
  async (args: any) => handleSendMessage(args, config),
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
  async (args: any) => handleSendImage(args, config),
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
  async (args: any) => handleSendDocument(args, config),
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
  async (args: any) => handleScheduleTask(args, config),
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => handleListTasks(config),
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args: any) => handlePauseTask(args, config),
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args: any) => handleResumeTask(args, config),
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args: any) => handleCancelTask(args, config),
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
  async (args: any) => handleUpdateTask(args, config),
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
  async (args: any) => handleRegisterGroup(args, config),
);

// Case lifecycle tools

server.tool(
  'list_cases',
  `List all active cases (work items). Shows case name, type, status, description, last activity, and cost.
From main group: shows all cases. From other groups: shows only that group's cases.`,
  {},
  async () => handleListCases(config),
);

server.tool(
  'create_case',
  `Create a new work case (isolated work item). Use this when the user asks you to do something that warrants tracking as a discrete piece of work — research, analysis, writing, multi-step tasks, etc.

The case gets its own workspace and session, so subsequent messages routed to it have isolated context. Don't create cases for simple one-off questions.

Case types:
• "work" — Uses existing tooling for productive work (research, analysis, writing, file conversions). Gets a scratch directory. NO git or GitHub access.
• "dev" — Any task that produces code changes: bug fixes, new features, tooling improvements, config changes, workflow updates. Gets a git worktree + GitHub access for pushing branches and creating PRs. Use this whenever the deliverable is a code change or PR.`,
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
      .describe(
        'Type of case: "work" for non-code tasks, "dev" for anything that changes code (bug fixes, features, config, workflows)',
      ),
    customer_name: z
      .string()
      .optional()
      .describe(
        'Customer name (for work cases). Extract from conversation context if available.',
      ),
    customer_phone: z
      .string()
      .optional()
      .describe('Customer phone number, if mentioned in the conversation.'),
    customer_email: z
      .string()
      .optional()
      .describe('Customer email address, if mentioned in the conversation.'),
    customer_org: z
      .string()
      .optional()
      .describe(
        'Customer organization or business name, if mentioned in the conversation.',
      ),
    github_issue: z
      .number()
      .optional()
      .describe(
        'Existing GitHub issue number to link this case to (e.g., a kaizen issue). If omitted for dev cases, a new issue is auto-created.',
      ),
    gap_type: z
      .string()
      .optional()
      .describe(
        'Escalation gap type from the vertical escalation config (e.g., "missing_info", "approval_needed"). Triggers priority computation.',
      ),
    signals: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        'Explicit escalation signal overrides (e.g., { "customer_waiting": true }). Auto-detected signals are merged in.',
      ),
    branch_name: z
      .string()
      .optional()
      .describe(
        'Existing git branch name to link this case to. Must be provided together with worktree_path. When both are provided and the worktree path exists, the case reuses the existing worktree instead of creating a new one.',
      ),
    worktree_path: z
      .string()
      .optional()
      .describe(
        'Existing worktree path to link this case to. Must be provided together with branch_name. When both are provided and the path exists on disk, the case reuses it.',
      ),
  },
  async (args: any) => handleCreateCase(args, config),
);

server.tool(
  'case_mark_done',
  `Mark the current case as done. You MUST include:
1. A conclusion summarizing what was accomplished
2. A kaizen reflection: list any bugs, impediments, inefficiencies, difficulties, annoyances, or blockers you encountered.
   For each, suggest what improvement would help: QoL features, bug fixes, cached knowledge, hooks, gates/reviews/checks, workflow improvements.
   These become suggested dev cases for continuous improvement.
3. If you genuinely encountered no issues, set no_kaizen_needed=true with a reason explaining why (e.g., "straightforward config change with no friction").

You MUST provide either a non-empty kaizen array OR no_kaizen_needed=true with a reason. Empty reflections are rejected.

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
        'Kaizen reflections — improvements that would make future cases better. Required unless no_kaizen_needed is true.',
      ),
    no_kaizen_needed: z
      .boolean()
      .optional()
      .describe(
        'Set to true ONLY if no improvements were identified. Must include no_kaizen_reason.',
      ),
    no_kaizen_reason: z
      .string()
      .optional()
      .describe(
        'Why no kaizen items were identified (e.g., "straightforward config change with no friction"). Required when no_kaizen_needed is true.',
      ),
  },
  async (args: any) => handleCaseMarkDone(args, config),
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
  async (args: any) => handleCaseMarkBlocked(args, config),
);

server.tool(
  'add_case_comment',
  `Add a comment/note to a case thread. Use this to record important updates, decisions, customer interactions, or progress notes. Comments are synced to the cloud backend (GitHub Issue comments) for visibility.

Use this when:
• A customer provides important information during the conversation
• You want to record a decision or milestone
• You need to add context that should be visible to admins reviewing the case`,
  {
    case_id: z.string().describe('The case ID to add a comment to'),
    text: z
      .string()
      .describe('The comment text. Can include markdown formatting.'),
    author: z
      .string()
      .optional()
      .describe(
        'Who is making this comment (e.g., customer name, "agent", admin name). Defaults to "agent".',
      ),
  },
  async (args: any) => handleAddCaseComment(args, config),
);

server.tool(
  'attach_case_artifact',
  `Attach a file, link, or reference to a case. Use this to associate deliverables, source files, external URLs, or any other artifact with a case for tracking.

The artifact is recorded as a structured comment on the case and synced to the cloud backend.`,
  {
    case_id: z.string().describe('The case ID to attach the artifact to'),
    artifact_type: z
      .enum(['file', 'link', 'note'])
      .describe('Type of artifact: file path, URL/link, or free-text note'),
    value: z
      .string()
      .describe('The artifact value: a file path, URL, or note text'),
    description: z
      .string()
      .optional()
      .describe('Brief description of what this artifact is'),
  },
  async (args: any) => handleAttachCaseArtifact(args, config),
);

server.tool(
  'case_mark_active',
  'Resume a blocked case, marking it as active again.',
  {
    case_id: z.string().describe('The case ID to resume'),
  },
  async (args: any) => handleCaseMarkActive(args, config),
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
  async (args: any) => handleCaseSuggestDev(args, config),
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
  async (args: any) => handleCreateGithubIssue(args, config),
);

// Router-specific tool — only registered when running as the message router
if (config.groupFolder === '__router__') {
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
    async (args: any) => handleRouteDecision(args, config),
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
