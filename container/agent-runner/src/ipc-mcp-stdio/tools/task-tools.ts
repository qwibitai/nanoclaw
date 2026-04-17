import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import type { ToolContext } from '../context.js';
import { validateSchedule } from '../schedule-validator.js';

import { textResponse, type ToolDefinition } from './types.js';

// --- schedule_task -----------------------------------------------------

interface ScheduleTaskArgs {
  name?: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode?: 'group' | 'isolated';
  target_group_jid?: string;
  script?: string;
  model?: string;
}

const SCHEDULE_TASK_DESCRIPTION = `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

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
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`;

export function buildScheduleTaskTool(
  ctx: ToolContext,
): ToolDefinition<ScheduleTaskArgs, ReturnType<typeof textResponse>> {
  return {
    name: 'schedule_task',
    description: SCHEDULE_TASK_DESCRIPTION,
    schema: {
      name: z
        .string()
        .optional()
        .describe(
          'Optional human-readable name for this task (e.g. "daily-report", "heartbeat")',
        ),
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
      script: z
        .string()
        .optional()
        .describe(
          'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
        ),
      model: z
        .string()
        .optional()
        .describe(
          'Model to use for this task (e.g. "haiku", "opus", or full model ID). Resolved via model aliases. If omitted, uses group or global default.',
        ),
    },
    handler: async (args) => {
      const validation = validateSchedule(
        args.schedule_type,
        args.schedule_value,
      );
      if (!validation.valid) {
        return textResponse(validation.error, true);
      }

      // Non-main groups can only schedule for themselves
      const targetJid =
        ctx.isMain && args.target_group_jid
          ? args.target_group_jid
          : ctx.chatJid;

      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      ctx.writeIpcFile(ctx.tasksDir, {
        type: 'schedule_task',
        taskId,
        taskName: args.name || undefined,
        prompt: args.prompt,
        script: args.script || undefined,
        schedule_type: args.schedule_type,
        schedule_value: args.schedule_value,
        context_mode: args.context_mode || 'group',
        model: args.model || undefined,
        targetJid,
        createdBy: ctx.groupFolder,
        timestamp: new Date().toISOString(),
      });

      return textResponse(
        `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
      );
    },
  };
}

// --- list_tasks --------------------------------------------------------

interface TaskSnapshot {
  id: string;
  name?: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  context_mode?: string;
  status: string;
  next_run: string;
  groupFolder: string;
}

export function buildListTasksTool(
  ctx: ToolContext,
): ToolDefinition<Record<string, never>, ReturnType<typeof textResponse>> {
  return {
    name: 'list_tasks',
    description:
      "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
    schema: {},
    handler: async () => {
      const tasksFile = path.join(ctx.groupDir, 'current_tasks.json');

      try {
        if (!fs.existsSync(tasksFile)) {
          return textResponse(
            `No scheduled tasks found. (file not found: ${tasksFile})`,
          );
        }

        const allTasks: TaskSnapshot[] = JSON.parse(
          fs.readFileSync(tasksFile, 'utf-8'),
        );

        const tasks = ctx.isMain
          ? allTasks
          : allTasks.filter((t) => t.groupFolder === ctx.groupFolder);

        if (tasks.length === 0) {
          return textResponse(
            `No scheduled tasks found. (${allTasks.length} total, 0 for ${ctx.groupFolder}, isMain=${ctx.isMain})`,
          );
        }

        const formatted = tasks
          .map(
            (t) =>
              `- [${t.id}]${t.name ? ` "${t.name}"` : ''} ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}, ${t.context_mode || 'isolated'}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
          )
          .join('\n');

        return textResponse(`Scheduled tasks:\n${formatted}`);
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        return textResponse(
          `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

// --- pause/resume/cancel — identical shape ----------------------------

function buildSimpleTaskOpTool(
  ctx: ToolContext,
  name: 'pause_task' | 'resume_task' | 'cancel_task',
  description: string,
  action: 'paused' | 'resumed' | 'cancelled',
  ipcType: 'pause_task' | 'resume_task' | 'cancel_task',
): ToolDefinition<{ task_id: string }, ReturnType<typeof textResponse>> {
  return {
    name,
    description,
    schema: { task_id: z.string().describe('The task ID to act on') },
    handler: async (args) => {
      ctx.writeIpcFile(ctx.tasksDir, {
        type: ipcType,
        taskId: args.task_id,
        groupFolder: ctx.groupFolder,
        isMain: ctx.isMain,
        timestamp: new Date().toISOString(),
      });
      return textResponse(`Task ${args.task_id} ${action.replace(/ed$/, '')} requested.`);
    },
  };
}

export function buildPauseTaskTool(ctx: ToolContext) {
  return buildSimpleTaskOpTool(
    ctx,
    'pause_task',
    'Pause a scheduled task. It will not run until resumed.',
    'paused',
    'pause_task',
  );
}

export function buildResumeTaskTool(ctx: ToolContext) {
  return buildSimpleTaskOpTool(
    ctx,
    'resume_task',
    'Resume a paused task.',
    'resumed',
    'resume_task',
  );
}

export function buildCancelTaskTool(ctx: ToolContext) {
  return buildSimpleTaskOpTool(
    ctx,
    'cancel_task',
    'Cancel and delete a scheduled task.',
    'cancelled',
    'cancel_task',
  );
}

// --- update_task -------------------------------------------------------

interface UpdateTaskArgs {
  task_id: string;
  name?: string;
  prompt?: string;
  schedule_type?: 'cron' | 'interval' | 'once';
  schedule_value?: string;
  script?: string;
  model?: string;
}

export function buildUpdateTaskTool(
  ctx: ToolContext,
): ToolDefinition<UpdateTaskArgs, ReturnType<typeof textResponse>> {
  return {
    name: 'update_task',
    description:
      'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
    schema: {
      task_id: z.string().describe('The task ID to update'),
      name: z
        .string()
        .optional()
        .describe('New name for the task. Set to empty string to clear the name.'),
      prompt: z.string().optional().describe('New prompt for the task'),
      schedule_type: z
        .enum(['cron', 'interval', 'once'])
        .optional()
        .describe('New schedule type'),
      schedule_value: z
        .string()
        .optional()
        .describe('New schedule value (see schedule_task for format)'),
      script: z
        .string()
        .optional()
        .describe(
          'New script for the task. Set to empty string to remove the script.',
        ),
      model: z
        .string()
        .optional()
        .describe(
          'Change the model for this task (e.g. "haiku", "opus"). Use "default" to clear and fall back to group/global model.',
        ),
    },
    handler: async (args) => {
      // If a new schedule_value is provided, validate using either the
      // new schedule_type or the existing one (we don't know the existing
      // type here — fall back to cron semantics only when schedule_type
      // is also 'cron', matching the legacy behaviour).
      if (args.schedule_value) {
        if (args.schedule_type) {
          const v = validateSchedule(args.schedule_type, args.schedule_value);
          if (!v.valid) return textResponse(v.error, true);
        } else {
          // No schedule_type override — legacy behaviour treated this as cron.
          const v = validateSchedule('cron', args.schedule_value);
          if (!v.valid) return textResponse(v.error, true);
        }
      }

      const data: Record<string, string | undefined> = {
        type: 'update_task',
        taskId: args.task_id,
        groupFolder: ctx.groupFolder,
        isMain: String(ctx.isMain),
        timestamp: new Date().toISOString(),
      };
      if (args.name !== undefined) data.taskName = args.name;
      if (args.prompt !== undefined) data.prompt = args.prompt;
      if (args.script !== undefined) data.script = args.script;
      if (args.model !== undefined) data.model = args.model;
      if (args.schedule_type !== undefined)
        data.schedule_type = args.schedule_type;
      if (args.schedule_value !== undefined)
        data.schedule_value = args.schedule_value;

      ctx.writeIpcFile(ctx.tasksDir, data);

      return textResponse(`Task ${args.task_id} update requested.`);
    },
  };
}
