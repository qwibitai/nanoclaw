import { CronExpressionParser } from 'cron-parser';

import { DEFAULT_MODEL, resolveModelAlias, TIMEZONE } from '../config.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  setGroupEffort,
  setGroupThinkingBudget,
  updateTask,
} from '../db.js';
import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';

import { computeNextRun } from './schedule.js';
import type { IpcDeps, IpcTaskPayload } from './types.js';

/**
 * Dispatch a single IPC task payload to its handler. `sourceGroup` and
 * `isMain` come from the directory the file was found in (so agents
 * cannot forge them in the payload). Authorization is enforced per
 * handler.
 */
export async function processTaskIpc(
  data: IpcTaskPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  switch (data.type) {
    case 'schedule_task':
      return handleScheduleTask(data, sourceGroup, isMain, deps);
    case 'pause_task':
      return handlePauseTask(data, sourceGroup, isMain, deps);
    case 'resume_task':
      return handleResumeTask(data, sourceGroup, isMain, deps);
    case 'cancel_task':
      return handleCancelTask(data, sourceGroup, isMain, deps);
    case 'update_task':
      return handleUpdateTask(data, sourceGroup, isMain, deps);
    case 'refresh_groups':
      return handleRefreshGroups(sourceGroup, isMain, deps);
    case 'register_group':
      return handleRegisterGroup(data, sourceGroup, isMain, deps);
    case 'switch_model':
      return handleSwitchModel(data, sourceGroup, deps);
    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

function handleScheduleTask(
  data: IpcTaskPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): void {
  if (
    !data.prompt ||
    !data.schedule_type ||
    !data.schedule_value ||
    !data.targetJid
  ) {
    return;
  }

  const targetJid = data.targetJid;
  const registeredGroups = deps.registeredGroups();
  const targetGroupEntry = registeredGroups[targetJid];

  if (!targetGroupEntry) {
    logger.warn(
      { targetJid },
      'Cannot schedule task: target group not registered',
    );
    return;
  }

  const targetFolder = targetGroupEntry.folder;

  // Authorization: non-main groups can only schedule for themselves
  if (!isMain && targetFolder !== sourceGroup) {
    logger.warn(
      { sourceGroup, targetFolder },
      'Unauthorized schedule_task attempt blocked',
    );
    return;
  }

  const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';
  const nextRun = computeNextRun(scheduleType, data.schedule_value);
  if (nextRun === null) {
    logger.warn(
      { scheduleType, scheduleValue: data.schedule_value },
      'Invalid schedule value',
    );
    return;
  }

  const taskId =
    data.taskId ||
    `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contextMode =
    data.context_mode === 'group' || data.context_mode === 'isolated'
      ? data.context_mode
      : 'isolated';
  const taskModel = data.model ? resolveModelAlias(data.model) : null;

  createTask({
    id: taskId,
    name: data.taskName || null,
    group_folder: targetFolder,
    chat_jid: targetJid,
    prompt: data.prompt,
    script: data.script || null,
    schedule_type: scheduleType,
    schedule_value: data.schedule_value,
    context_mode: contextMode,
    model: taskModel,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });
  logger.info(
    { taskId, sourceGroup, targetFolder, contextMode },
    'Task created via IPC',
  );
  deps.onTasksChanged();
}

function handleSimpleTaskOp(
  data: IpcTaskPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  action: 'pause' | 'resume' | 'cancel',
): void {
  if (!data.taskId) return;
  const task = getTaskById(data.taskId);
  if (!task || (!isMain && task.group_folder !== sourceGroup)) {
    logger.warn(
      { taskId: data.taskId, sourceGroup, action },
      `Unauthorized task ${action} attempt`,
    );
    return;
  }
  if (action === 'cancel') {
    deleteTask(data.taskId);
  } else {
    updateTask(data.taskId, {
      status: action === 'pause' ? 'paused' : 'active',
    });
  }
  logger.info(
    { taskId: data.taskId, sourceGroup },
    `Task ${action} via IPC`,
  );
  deps.onTasksChanged();
}

function handlePauseTask(
  data: IpcTaskPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): void {
  handleSimpleTaskOp(data, sourceGroup, isMain, deps, 'pause');
}

function handleResumeTask(
  data: IpcTaskPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): void {
  handleSimpleTaskOp(data, sourceGroup, isMain, deps, 'resume');
}

function handleCancelTask(
  data: IpcTaskPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): void {
  handleSimpleTaskOp(data, sourceGroup, isMain, deps, 'cancel');
}

function handleUpdateTask(
  data: IpcTaskPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): void {
  if (!data.taskId) return;
  const task = getTaskById(data.taskId);
  if (!task) {
    logger.warn(
      { taskId: data.taskId, sourceGroup },
      'Task not found for update',
    );
    return;
  }
  if (!isMain && task.group_folder !== sourceGroup) {
    logger.warn(
      { taskId: data.taskId, sourceGroup },
      'Unauthorized task update attempt',
    );
    return;
  }

  const updates: Parameters<typeof updateTask>[1] = {};
  if (data.taskName !== undefined) updates.name = data.taskName;
  if (data.prompt !== undefined) updates.prompt = data.prompt;
  if (data.script !== undefined) updates.script = data.script || null;
  if (data.model !== undefined) {
    updates.model =
      data.model === 'default' || data.model === ''
        ? null
        : resolveModelAlias(data.model);
  }
  if (data.schedule_type !== undefined)
    updates.schedule_type = data.schedule_type as 'cron' | 'interval' | 'once';
  if (data.schedule_value !== undefined)
    updates.schedule_value = data.schedule_value;

  // Recompute next_run when schedule changed
  if (data.schedule_type || data.schedule_value) {
    const updatedTask = { ...task, ...updates };
    if (updatedTask.schedule_type === 'cron') {
      try {
        const interval = CronExpressionParser.parse(
          updatedTask.schedule_value,
          { tz: TIMEZONE },
        );
        updates.next_run = interval.next().toISOString();
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch {
        logger.warn(
          { taskId: data.taskId, value: updatedTask.schedule_value },
          'Invalid cron in task update',
        );
        return;
      }
    } else if (updatedTask.schedule_type === 'interval') {
      const ms = parseInt(updatedTask.schedule_value, 10);
      if (!isNaN(ms) && ms > 0) {
        updates.next_run = new Date(Date.now() + ms).toISOString();
      }
    }
  }

  updateTask(data.taskId, updates);
  logger.info(
    { taskId: data.taskId, sourceGroup, updates },
    'Task updated via IPC',
  );
  deps.onTasksChanged();
}

async function handleRefreshGroups(
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
    return;
  }
  logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
  await deps.syncGroups(true);
  const availableGroups = deps.getAvailableGroups();
  deps.writeGroupsSnapshot(
    sourceGroup,
    true,
    availableGroups,
    new Set(Object.keys(deps.registeredGroups())),
  );
}

function handleRegisterGroup(
  data: IpcTaskPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): void {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
    return;
  }
  if (!data.jid || !data.name || !data.folder || !data.trigger) {
    logger.warn({ data }, 'Invalid register_group request - missing fields');
    return;
  }
  if (!isValidGroupFolder(data.folder)) {
    logger.warn(
      { sourceGroup, folder: data.folder },
      'Invalid register_group request - unsafe folder name',
    );
    return;
  }
  // Defense in depth: agent cannot set isMain via IPC. Preserve isMain
  // from any existing registration so IPC config updates don't strip it.
  const existingGroup = deps.registeredGroups()[data.jid];
  deps.registerGroup(data.jid, {
    name: data.name,
    folder: data.folder,
    trigger: data.trigger,
    added_at: new Date().toISOString(),
    containerConfig: data.containerConfig,
    requiresTrigger: data.requiresTrigger,
    isMain: existingGroup?.isMain,
  });
}

function handleSwitchModel(
  data: IpcTaskPayload,
  sourceGroup: string,
  deps: IpcDeps,
): void {
  if (!data.chatJid) {
    logger.warn({ sourceGroup }, 'switch_model missing chatJid');
    return;
  }
  const registeredGroups = deps.registeredGroups();
  const targetGroup = registeredGroups[data.chatJid];
  if (!targetGroup) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'switch_model: target group not registered',
    );
    return;
  }
  if (targetGroup.folder !== sourceGroup) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized switch_model attempt blocked',
    );
    return;
  }

  if (data.model === 'reset' || data.model === '') {
    const previousOverride = targetGroup.agentModelOverride;
    targetGroup.agentModelOverride = undefined;
    targetGroup.agentModelOverrideSetAt = undefined;
    if (previousOverride) {
      const effectiveModel = targetGroup.model || DEFAULT_MODEL;
      targetGroup.pendingModelNotice = `[model override cleared — reverted to ${effectiveModel}]`;
      deps
        .sendMessage(
          data.chatJid,
          `Model override cleared — reverted to ${effectiveModel}`,
        )
        .catch((err) =>
          logger.error({ err }, 'Failed to send model reset notification'),
        );
    }
    logger.info(
      { chatJid: data.chatJid, sourceGroup },
      'Agent model override cleared via IPC',
    );
  } else if (data.model) {
    const resolved = resolveModelAlias(data.model);
    const previousEffective =
      targetGroup.agentModelOverride || targetGroup.model || DEFAULT_MODEL;
    targetGroup.agentModelOverride = resolved;
    targetGroup.agentModelOverrideSetAt = Date.now();
    if (previousEffective !== resolved) {
      targetGroup.pendingModelNotice = `[model has switched to ${resolved} (agent-initiated, auto-reverts in 20 min)]`;
    }
    deps
      .sendMessage(
        data.chatJid,
        `Model switched to ${resolved} (agent-initiated, auto-reverts in 20 min)`,
      )
      .catch((err) =>
        logger.error({ err }, 'Failed to send model switch notification'),
      );
    logger.info(
      { chatJid: data.chatJid, sourceGroup, model: resolved },
      'Agent model override set via IPC',
    );
  }

  if (data.effort) {
    const effortValue = data.effort === 'reset' ? null : data.effort;
    setGroupEffort(data.chatJid, effortValue);
    targetGroup.effort = effortValue || undefined;
    logger.info(
      { chatJid: data.chatJid, effort: effortValue },
      'Effort set via switch_model IPC',
    );
  }

  if (data.thinking_budget) {
    const tbValue =
      data.thinking_budget === 'reset' ? null : data.thinking_budget;
    setGroupThinkingBudget(data.chatJid, tbValue);
    targetGroup.thinking_budget = tbValue || undefined;
    logger.info(
      { chatJid: data.chatJid, thinking_budget: tbValue },
      'Thinking budget set via switch_model IPC',
    );
  }
}
