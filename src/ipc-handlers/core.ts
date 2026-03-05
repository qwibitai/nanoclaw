/**
 * Core IPC Handlers
 * Domain logic extracted from ws-server.ts.
 * Registered at startup via initCoreHandlers().
 */
import { CronExpressionParser } from 'cron-parser';
import { JSONRPCErrorException } from 'json-rpc-2.0';

import { TIMEZONE } from '../config.js';
import { AvailableGroup } from '../container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from '../db.js';
import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import { HandlerContext, registerIpcHandler } from './registry.js';

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.length > 0;
}

export interface CoreHandlerDeps {
  sendMessage: (jid: string, text: string, sender?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  getTasksSnapshot: (
    groupFolder: string,
    isMain: boolean,
  ) => Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>;
  getGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
  ) => { groups: AvailableGroup[]; lastSync: string };
}

let deps: CoreHandlerDeps;

export function initCoreHandlers(d: CoreHandlerDeps): void {
  deps = d;

  registerIpcHandler('message', handleMessage);
  registerIpcHandler('list_tasks', handleListTasks);
  registerIpcHandler('schedule_task', handleScheduleTask);
  registerIpcHandler('pause_task', handlePauseTask);
  registerIpcHandler('resume_task', handleResumeTask);
  registerIpcHandler('cancel_task', handleCancelTask);
  registerIpcHandler('refresh_groups', handleRefreshGroups);
  registerIpcHandler('register_group', handleRegisterGroup);
}

async function handleMessage(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<unknown> {
  if (!isNonEmptyString(params.chatJid) || !isNonEmptyString(params.text)) {
    throw new JSONRPCErrorException('Missing chatJid or text', -32602);
  }

  const chatJid = params.chatJid;
  const text = params.text;
  const sender = params.sender as string | undefined;

  const registeredGroups = deps.registeredGroups();
  const targetGroup = registeredGroups[chatJid];
  if (ctx.isMain || (targetGroup && targetGroup.folder === ctx.groupFolder)) {
    await deps.sendMessage(chatJid, text, sender);
    logger.info({ chatJid, sourceGroup: ctx.groupFolder }, 'WS message sent');
    return { ok: true };
  }

  logger.warn(
    { chatJid, sourceGroup: ctx.groupFolder },
    'Unauthorized WS message attempt blocked',
  );
  throw new JSONRPCErrorException(
    'Unauthorized: cannot send to that group',
    -32600,
  );
}

async function handleListTasks(
  _params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<unknown> {
  return { tasks: deps.getTasksSnapshot(ctx.groupFolder, ctx.isMain) };
}

async function handleScheduleTask(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<unknown> {
  const registeredGroups = deps.registeredGroups();

  if (
    !isNonEmptyString(params.prompt) ||
    !isNonEmptyString(params.schedule_type) ||
    !isNonEmptyString(params.schedule_value) ||
    !isNonEmptyString(params.targetJid)
  ) {
    throw new JSONRPCErrorException('Missing required fields', -32602);
  }

  const prompt = params.prompt;
  const scheduleType = params.schedule_type;
  const scheduleValue = params.schedule_value;
  const targetJid = params.targetJid;

  const targetGroupEntry = registeredGroups[targetJid];
  if (!targetGroupEntry) {
    logger.warn(
      { targetJid },
      'Cannot schedule task: target group not registered',
    );
    throw new JSONRPCErrorException('Target group not registered', -32602);
  }

  const targetFolder = targetGroupEntry.folder;

  if (!ctx.isMain && targetFolder !== ctx.groupFolder) {
    logger.warn(
      { sourceGroup: ctx.groupFolder, targetFolder },
      'Unauthorized schedule_task attempt blocked',
    );
    throw new JSONRPCErrorException(
      'Unauthorized: cannot schedule for other groups',
      -32600,
    );
  }

  if (
    scheduleType !== 'cron' &&
    scheduleType !== 'interval' &&
    scheduleType !== 'once'
  ) {
    logger.warn({ scheduleType }, 'Invalid schedule type');
    throw new JSONRPCErrorException(
      `Invalid schedule type: ${scheduleType}`,
      -32602,
    );
  }

  let nextRun: string | null = null;
  if (scheduleType === 'cron') {
    try {
      const interval = CronExpressionParser.parse(scheduleValue, {
        tz: TIMEZONE,
      });
      nextRun = interval.next().toISOString();
    } catch {
      logger.warn({ scheduleValue }, 'Invalid cron expression');
      throw new JSONRPCErrorException(
        `Invalid cron expression: ${scheduleValue}`,
        -32602,
      );
    }
  } else if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) {
      logger.warn({ scheduleValue }, 'Invalid interval');
      throw new JSONRPCErrorException(
        `Invalid interval: ${scheduleValue}`,
        -32602,
      );
    }
    nextRun = new Date(Date.now() + ms).toISOString();
  } else if (scheduleType === 'once') {
    const scheduled = new Date(scheduleValue);
    if (isNaN(scheduled.getTime())) {
      logger.warn({ scheduleValue }, 'Invalid timestamp');
      throw new JSONRPCErrorException(
        `Invalid timestamp: ${scheduleValue}`,
        -32602,
      );
    }
    nextRun = scheduled.toISOString();
  }

  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contextMode =
    params.context_mode === 'group' || params.context_mode === 'isolated'
      ? (params.context_mode as 'group' | 'isolated')
      : 'isolated';
  createTask({
    id: taskId,
    group_folder: targetFolder,
    chat_jid: targetJid,
    prompt,
    schedule_type: scheduleType,
    schedule_value: scheduleValue,
    context_mode: contextMode,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });
  logger.info(
    { taskId, sourceGroup: ctx.groupFolder, targetFolder, contextMode },
    'Task created via IPC',
  );
  return { taskId };
}

function withAuthorizedTask(
  params: Record<string, unknown>,
  ctx: HandlerContext,
  action: (taskId: string) => void,
  verb: string,
): Record<string, unknown> {
  if (!isNonEmptyString(params.taskId)) {
    throw new JSONRPCErrorException('Missing taskId', -32602);
  }
  const taskId = params.taskId;
  const task = getTaskById(taskId);
  if (task && (ctx.isMain || task.group_folder === ctx.groupFolder)) {
    action(taskId);
    logger.info(
      { taskId, sourceGroup: ctx.groupFolder },
      `Task ${verb} via IPC`,
    );
    return { ok: true };
  }
  logger.warn(
    { taskId, sourceGroup: ctx.groupFolder },
    `Unauthorized task ${verb} attempt`,
  );
  throw new JSONRPCErrorException('Task not found or unauthorized', -32600);
}

async function handlePauseTask(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<unknown> {
  return withAuthorizedTask(
    params,
    ctx,
    (id) => updateTask(id, { status: 'paused' }),
    'paused',
  );
}

async function handleResumeTask(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<unknown> {
  return withAuthorizedTask(
    params,
    ctx,
    (id) => updateTask(id, { status: 'active' }),
    'resumed',
  );
}

async function handleCancelTask(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<unknown> {
  return withAuthorizedTask(params, ctx, (id) => deleteTask(id), 'cancelled');
}

async function handleRefreshGroups(
  _params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<unknown> {
  if (!ctx.isMain) {
    logger.warn(
      { sourceGroup: ctx.groupFolder },
      'Unauthorized refresh_groups attempt blocked',
    );
    throw new JSONRPCErrorException('Unauthorized: main group only', -32600);
  }
  logger.info(
    { sourceGroup: ctx.groupFolder },
    'Group metadata refresh requested via IPC',
  );
  await deps.syncGroups(true);
  const groupsData = deps.getGroupsSnapshot(ctx.groupFolder, ctx.isMain);
  return { groups: groupsData };
}

async function handleRegisterGroup(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<unknown> {
  if (!ctx.isMain) {
    logger.warn(
      { sourceGroup: ctx.groupFolder },
      'Unauthorized register_group attempt blocked',
    );
    throw new JSONRPCErrorException('Unauthorized: main group only', -32600);
  }
  if (
    !isNonEmptyString(params.jid) ||
    !isNonEmptyString(params.name) ||
    !isNonEmptyString(params.folder) ||
    !isNonEmptyString(params.trigger)
  ) {
    logger.warn('Invalid register_group request - missing required fields');
    throw new JSONRPCErrorException('Missing required fields', -32602);
  }
  const jid = params.jid;
  const name = params.name;
  const folder = params.folder;
  const trigger = params.trigger;
  if (!isValidGroupFolder(folder)) {
    logger.warn(
      { sourceGroup: ctx.groupFolder, folder },
      'Invalid register_group request - unsafe folder name',
    );
    throw new JSONRPCErrorException('Invalid folder name', -32602);
  }
  deps.registerGroup(jid, {
    name,
    folder,
    trigger,
    added_at: new Date().toISOString(),
    containerConfig:
      params.containerConfig as RegisteredGroup['containerConfig'],
    requiresTrigger: params.requiresTrigger as boolean | undefined,
  });
  return { ok: true };
}
