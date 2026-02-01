/**
 * IPC-based MCP Server for NanoClaw
 * Writes messages and tasks to files for the host process to pick up
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

type ScheduleType = 'cron' | 'interval' | 'once';

interface ScheduleValidationResult {
  valid: boolean;
  error?: string;
  nextRun?: string | null;
}

/**
 * Validates a schedule value based on its type.
 * Returns validation result with next run time if valid.
 */
function validateSchedule(
  scheduleType: ScheduleType,
  scheduleValue: string
): ScheduleValidationResult {
  switch (scheduleType) {
    case 'cron':
      try {
        const interval = CronExpressionParser.parse(scheduleValue);
        const nextRun = interval.next().toISOString();
        return { valid: true, nextRun };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          valid: false,
          error: `Invalid cron expression "${scheduleValue}": ${message}. Use standard cron format (e.g., "0 9 * * *" for daily at 9am, "*/5 * * * *" for every 5 minutes).`
        };
      }

    case 'interval': {
      const ms = parseInt(scheduleValue, 10);
      if (isNaN(ms)) {
        return {
          valid: false,
          error: `Invalid interval "${scheduleValue}": must be a number (milliseconds). Use values like "300000" for 5 minutes or "3600000" for 1 hour.`
        };
      }
      if (ms <= 0) {
        return {
          valid: false,
          error: `Invalid interval "${scheduleValue}": must be a positive number. Use values like "300000" for 5 minutes.`
        };
      }
      if (ms < 60000) {
        return {
          valid: false,
          error: `Interval ${ms}ms is too short. Minimum interval is 60000ms (1 minute).`
        };
      }
      const nextRun = new Date(Date.now() + ms).toISOString();
      return { valid: true, nextRun };
    }

    case 'once': {
      const date = new Date(scheduleValue);
      if (isNaN(date.getTime())) {
        return {
          valid: false,
          error: `Invalid timestamp "${scheduleValue}": must be a valid ISO 8601 date (e.g., "2026-02-01T15:30:00.000Z").`
        };
      }
      if (date.getTime() <= Date.now()) {
        return {
          valid: false,
          error: `Timestamp "${scheduleValue}" is in the past. Please provide a future date/time.`
        };
      }
      return { valid: true, nextRun: date.toISOString() };
    }

    default:
      return { valid: false, error: `Unknown schedule type: ${scheduleType}` };
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
          text: z.string().describe('The message text to send')
        },
        async (args) => {
          const data = {
            type: 'message',
            chatJid,
            text: args.text,
            groupFolder,
            timestamp: new Date().toISOString()
          };

          const filename = writeIpcFile(MESSAGES_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Message queued for delivery (${filename})`
            }]
          };
        }
      ),

      tool(
        'schedule_task',
        `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

IMPORTANT - schedule_value format depends on schedule_type:
• cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am)
• interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
• once: ISO 8601 timestamp (e.g., "2026-02-01T15:30:00.000Z"). Calculate this from current time.`,
        {
          prompt: z.string().describe('What the agent should do when the task runs'),
          schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
          schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: ISO timestamp like "2026-02-01T15:30:00.000Z"'),
          target_group: z.string().optional().describe('Target group folder (main only, defaults to current group)')
        },
        async (args) => {
          // Validate the schedule before writing IPC file
          const validation = validateSchedule(args.schedule_type, args.schedule_value);
          if (!validation.valid) {
            return {
              content: [{
                type: 'text',
                text: `Error: ${validation.error}\n\nPlease correct the schedule_value and try again.`
              }],
              isError: true
            };
          }

          // Non-main groups can only schedule for themselves
          const targetGroup = isMain && args.target_group ? args.target_group : groupFolder;

          const data = {
            type: 'schedule_task',
            prompt: args.prompt,
            schedule_type: args.schedule_type,
            schedule_value: args.schedule_value,
            groupFolder: targetGroup,
            chatJid,
            createdBy: groupFolder,
            timestamp: new Date().toISOString()
          };

          const filename = writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}\nNext run: ${validation.nextRun}`
            }]
          };
        }
      ),

      // Reads from current_tasks.json which host keeps updated
      tool(
        'list_tasks',
        'List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group\'s tasks.',
        {},
        async () => {
          const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

          try {
            if (!fs.existsSync(tasksFile)) {
              return {
                content: [{
                  type: 'text',
                  text: 'No scheduled tasks found.'
                }]
              };
            }

            const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

            const tasks = isMain
              ? allTasks
              : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

            if (tasks.length === 0) {
              return {
                content: [{
                  type: 'text',
                  text: 'No scheduled tasks found.'
                }]
              };
            }

            const formatted = tasks.map((t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
              `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`
            ).join('\n');

            return {
              content: [{
                type: 'text',
                text: `Scheduled tasks:\n${formatted}`
              }]
            };
          } catch (err) {
            return {
              content: [{
                type: 'text',
                text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`
              }]
            };
          }
        }
      ),

      tool(
        'pause_task',
        'Pause a scheduled task. It will not run until resumed.',
        {
          task_id: z.string().describe('The task ID to pause')
        },
        async (args) => {
          const data = {
            type: 'pause_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task ${args.task_id} pause requested.`
            }]
          };
        }
      ),

      tool(
        'resume_task',
        'Resume a paused task.',
        {
          task_id: z.string().describe('The task ID to resume')
        },
        async (args) => {
          const data = {
            type: 'resume_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task ${args.task_id} resume requested.`
            }]
          };
        }
      ),

      tool(
        'cancel_task',
        'Cancel and delete a scheduled task.',
        {
          task_id: z.string().describe('The task ID to cancel')
        },
        async (args) => {
          const data = {
            type: 'cancel_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task ${args.task_id} cancellation requested.`
            }]
          };
        }
      )
    ]
  });
}
