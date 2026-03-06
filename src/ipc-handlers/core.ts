import { CronExpressionParser } from 'cron-parser';
import { JSONRPCErrorException } from 'json-rpc-2.0';

import { TIMEZONE } from '../config.js';
import {
  createTask,
  deleteTask,
  getAllTasks,
  getTaskById,
  updateTask,
} from '../db.js';
import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  registerHandler,
  type HandlerContext,
  type HandlerDeps,
} from './registry.js';

// --- message ---
registerHandler(
  'message',
  async (
    params: { chatJid: string; text: string; sender?: string },
    context: HandlerContext,
    deps: HandlerDeps,
  ) => {
    const registeredGroups = deps.registeredGroups();
    const targetGroup = registeredGroups[params.chatJid];

    if (!context.isMain && (!targetGroup || targetGroup.folder !== context.sourceGroup)) {
      logger.warn(
        { chatJid: params.chatJid, sourceGroup: context.sourceGroup },
        'Unauthorized message attempt blocked',
      );
      throw new JSONRPCErrorException(
        'Not authorized to send messages to this chat',
        -32600,
      );
    }

    await deps.sendMessage(params.chatJid, params.text, params.sender);
    logger.info(
      { chatJid: params.chatJid, sourceGroup: context.sourceGroup },
      'Message sent via JSON-RPC',
    );
    return { ok: true };
  },
);

// --- schedule_task ---
registerHandler(
  'schedule_task',
  async (
    params: {
      prompt: string;
      schedule_type: string;
      schedule_value: string;
      context_mode?: string;
      targetJid: string;
    },
    context: HandlerContext,
    deps: HandlerDeps,
  ) => {
    const registeredGroups = deps.registeredGroups();
    const targetGroupEntry = registeredGroups[params.targetJid];

    if (!targetGroupEntry) {
      throw new JSONRPCErrorException(
        'Cannot schedule task: target group not registered',
        -32600,
      );
    }

    const targetFolder = targetGroupEntry.folder;

    if (!context.isMain && targetFolder !== context.sourceGroup) {
      throw new JSONRPCErrorException(
        'Not authorized to schedule tasks for other groups',
        -32600,
      );
    }

    const scheduleType = params.schedule_type as 'cron' | 'interval' | 'once';
    let nextRun: string | null = null;

    if (scheduleType === 'cron') {
      try {
        const interval = CronExpressionParser.parse(params.schedule_value, {
          tz: TIMEZONE,
        });
        nextRun = interval.next().toISOString();
      } catch {
        throw new JSONRPCErrorException(
          `Invalid cron expression: ${params.schedule_value}`,
          -32602,
        );
      }
    } else if (scheduleType === 'interval') {
      const ms = parseInt(params.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        throw new JSONRPCErrorException(
          `Invalid interval: ${params.schedule_value}`,
          -32602,
        );
      }
      nextRun = new Date(Date.now() + ms).toISOString();
    } else if (scheduleType === 'once') {
      const scheduled = new Date(params.schedule_value);
      if (isNaN(scheduled.getTime())) {
        throw new JSONRPCErrorException(
          `Invalid timestamp: ${params.schedule_value}`,
          -32602,
        );
      }
      nextRun = scheduled.toISOString();
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const contextMode =
      params.context_mode === 'group' || params.context_mode === 'isolated'
        ? params.context_mode
        : 'isolated';

    createTask({
      id: taskId,
      group_folder: targetFolder,
      chat_jid: params.targetJid,
      prompt: params.prompt,
      schedule_type: scheduleType,
      schedule_value: params.schedule_value,
      context_mode: contextMode,
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    logger.info(
      { taskId, sourceGroup: context.sourceGroup, targetFolder, contextMode },
      'Task created via JSON-RPC',
    );

    return { taskId };
  },
);

// --- list_tasks ---
registerHandler(
  'list_tasks',
  async (
    _params: Record<string, never>,
    context: HandlerContext,
  ) => {
    const allTasks = getAllTasks();

    const filteredTasks = context.isMain
      ? allTasks
      : allTasks.filter((t) => t.group_folder === context.sourceGroup);

    return {
      tasks: filteredTasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    };
  },
);

// --- pause_task ---
registerHandler(
  'pause_task',
  async (
    params: { taskId: string },
    context: HandlerContext,
  ) => {
    const task = getTaskById(params.taskId);
    if (!task) {
      throw new JSONRPCErrorException(
        `Task not found: ${params.taskId}`,
        -32600,
      );
    }
    if (!context.isMain && task.group_folder !== context.sourceGroup) {
      throw new JSONRPCErrorException(
        'Not authorized to pause this task',
        -32600,
      );
    }

    updateTask(params.taskId, { status: 'paused' });
    logger.info(
      { taskId: params.taskId, sourceGroup: context.sourceGroup },
      'Task paused via JSON-RPC',
    );
    return { ok: true };
  },
);

// --- resume_task ---
registerHandler(
  'resume_task',
  async (
    params: { taskId: string },
    context: HandlerContext,
  ) => {
    const task = getTaskById(params.taskId);
    if (!task) {
      throw new JSONRPCErrorException(
        `Task not found: ${params.taskId}`,
        -32600,
      );
    }
    if (!context.isMain && task.group_folder !== context.sourceGroup) {
      throw new JSONRPCErrorException(
        'Not authorized to resume this task',
        -32600,
      );
    }

    updateTask(params.taskId, { status: 'active' });
    logger.info(
      { taskId: params.taskId, sourceGroup: context.sourceGroup },
      'Task resumed via JSON-RPC',
    );
    return { ok: true };
  },
);

// --- update_task ---
registerHandler(
  'update_task',
  async (
    params: {
      taskId: string;
      prompt?: string;
      schedule_type?: string;
      schedule_value?: string;
    },
    context: HandlerContext,
  ) => {
    const task = getTaskById(params.taskId);
    if (!task) {
      throw new JSONRPCErrorException(
        `Task not found: ${params.taskId}`,
        -32600,
      );
    }
    if (!context.isMain && task.group_folder !== context.sourceGroup) {
      throw new JSONRPCErrorException(
        'Not authorized to update this task',
        -32600,
      );
    }

    const updates: Parameters<typeof updateTask>[1] = {};
    if (params.prompt !== undefined) updates.prompt = params.prompt;
    if (params.schedule_type !== undefined)
      updates.schedule_type = params.schedule_type as 'cron' | 'interval' | 'once';
    if (params.schedule_value !== undefined)
      updates.schedule_value = params.schedule_value;

    // Recompute next_run if schedule changed
    if (params.schedule_type || params.schedule_value) {
      const updated = { ...task, ...updates };
      if (updated.schedule_type === 'cron') {
        try {
          const interval = CronExpressionParser.parse(updated.schedule_value, {
            tz: TIMEZONE,
          });
          updates.next_run = interval.next().toISOString();
        } catch {
          throw new JSONRPCErrorException(
            `Invalid cron expression: ${updated.schedule_value}`,
            -32602,
          );
        }
      } else if (updated.schedule_type === 'interval') {
        const ms = parseInt(updated.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          throw new JSONRPCErrorException(
            `Invalid interval: ${updated.schedule_value}`,
            -32602,
          );
        }
        updates.next_run = new Date(Date.now() + ms).toISOString();
      }
    }

    updateTask(params.taskId, updates);
    logger.info(
      { taskId: params.taskId, sourceGroup: context.sourceGroup, updates },
      'Task updated via JSON-RPC',
    );
    return { ok: true };
  },
);

// --- cancel_task ---
registerHandler(
  'cancel_task',
  async (
    params: { taskId: string },
    context: HandlerContext,
  ) => {
    const task = getTaskById(params.taskId);
    if (!task) {
      throw new JSONRPCErrorException(
        `Task not found: ${params.taskId}`,
        -32600,
      );
    }
    if (!context.isMain && task.group_folder !== context.sourceGroup) {
      throw new JSONRPCErrorException(
        'Not authorized to cancel this task',
        -32600,
      );
    }

    deleteTask(params.taskId);
    logger.info(
      { taskId: params.taskId, sourceGroup: context.sourceGroup },
      'Task cancelled via JSON-RPC',
    );
    return { ok: true };
  },
);

// --- register_group ---
registerHandler(
  'register_group',
  async (
    params: {
      jid: string;
      name: string;
      folder: string;
      trigger: string;
      requiresTrigger?: boolean;
      containerConfig?: any;
    },
    context: HandlerContext,
    deps: HandlerDeps,
  ) => {
    if (!context.isMain) {
      throw new JSONRPCErrorException(
        'Only the main group can register new groups',
        -32600,
      );
    }

    if (!params.jid || !params.name || !params.folder || !params.trigger) {
      throw new JSONRPCErrorException(
        'Missing required fields: jid, name, folder, trigger',
        -32602,
      );
    }

    if (!isValidGroupFolder(params.folder)) {
      throw new JSONRPCErrorException(
        `Invalid folder name: ${params.folder}`,
        -32602,
      );
    }

    deps.registerGroup(params.jid, {
      name: params.name,
      folder: params.folder,
      trigger: params.trigger,
      added_at: new Date().toISOString(),
      containerConfig: params.containerConfig,
      requiresTrigger: params.requiresTrigger,
    });

    logger.info(
      { jid: params.jid, folder: params.folder, sourceGroup: context.sourceGroup },
      'Group registered via JSON-RPC',
    );
    return { ok: true };
  },
);

// --- refresh_groups ---
registerHandler(
  'refresh_groups',
  async (
    _params: Record<string, never>,
    context: HandlerContext,
    deps: HandlerDeps,
  ) => {
    if (!context.isMain) {
      throw new JSONRPCErrorException(
        'Only the main group can refresh groups',
        -32600,
      );
    }

    logger.info(
      { sourceGroup: context.sourceGroup },
      'Group refresh requested via JSON-RPC',
    );

    await deps.syncGroups(true);
    const availableGroups = deps.getAvailableGroups();
    return { groups: availableGroups };
  },
);
