import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { authorizeCaseCreation } from './case-auth.js';
import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  createCaseWorkspace,
  generateCaseId,
  generateCaseName,
  getActiveCasesByGithubIssue,
  getCaseById,
  getStaleActiveCases,
  getStaleDoneCases,
  insertCase,
  pruneCaseWorkspace,
  removeWorktreeLock,
  suggestDevCase,
  updateCase,
  updateWorktreeLockHeartbeat,
} from './cases.js';
import type { Case } from './cases.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { createGitHubIssue, DEV_CASE_ISSUE_REPO } from './github-issues.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  /** Optional: send an image file. Falls back to sendMessage with caption if not supported. */
  sendImage?: (
    jid: string,
    imagePath: string,
    caption?: string,
  ) => Promise<void>;
  /** Optional: send a document/file. Falls back to sendMessage with caption if not supported. */
  sendDocument?: (
    jid: string,
    documentPath: string,
    filename?: string,
    caption?: string,
  ) => Promise<void>;
  /** Optional channel-aware send for pool bots (e.g. Telegram swarm).
   *  Returns true if handled, false to fall back to sendMessage. */
  sendPoolMessage?: (
    jid: string,
    text: string,
    sender: string,
    groupFolder: string,
  ) => Promise<boolean>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

/**
 * Translate a container filesystem path to the corresponding host path.
 * Returns { hostPath, allowedDir } on success, or null if the prefix is
 * unrecognised (caller should treat this as a traversal block).
 *
 * Supported prefixes:
 *   /workspace/group/...   → groups/{sourceGroup}/...
 *   /workspace/extra/...   → looked up from the group's additionalMounts config
 */
export function resolveContainerToHostPath(
  containerPath: string,
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
): { hostPath: string; allowedDir: string } | null {
  // /workspace/group/ → groups/{sourceGroup}/
  if (containerPath.startsWith('/workspace/group/')) {
    const relativePath = containerPath.slice('/workspace/group/'.length);
    const groupDir = resolveGroupFolderPath(sourceGroup);
    return {
      hostPath: path.join(groupDir, relativePath),
      allowedDir: groupDir,
    };
  }

  // /workspace/extra/{name}/... → reverse-map via validated additional mounts
  if (containerPath.startsWith('/workspace/extra/')) {
    const group = Object.values(registeredGroups).find(
      (g) => g.folder === sourceGroup,
    );
    if (!group?.containerConfig?.additionalMounts) return null;

    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      group.isMain ?? false,
    );

    for (const mount of validatedMounts) {
      const prefix = mount.containerPath.endsWith('/')
        ? mount.containerPath
        : mount.containerPath + '/';
      if (
        containerPath === mount.containerPath ||
        containerPath.startsWith(prefix)
      ) {
        const relativePath = containerPath
          .slice(mount.containerPath.length)
          .replace(/^\//, '');
        const hostPath = relativePath
          ? path.join(mount.hostPath, relativePath)
          : mount.hostPath;
        return { hostPath, allowedDir: mount.hostPath };
      }
    }
    return null;
  }

  // Paths already on the host filesystem (within the group dir) — pass through
  const groupDir = resolveGroupFolderPath(sourceGroup);
  if (containerPath.startsWith(groupDir)) {
    return { hostPath: containerPath, allowedDir: groupDir };
  }

  return null;
}

/** Dispatch an IPC message, routing through pool bots when a sender is present. */
export async function dispatchIpcMessage(
  data: { chatJid: string; text: string; sender?: string },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<'sent' | 'unauthorized'> {
  const registeredGroups = deps.registeredGroups();
  const targetGroup = registeredGroups[data.chatJid];
  if (!isMain && !(targetGroup && targetGroup.folder === sourceGroup)) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC message attempt blocked',
    );
    return 'unauthorized';
  }

  if (data.sender && deps.sendPoolMessage && data.chatJid.startsWith('tg:')) {
    const sent = await deps.sendPoolMessage(
      data.chatJid,
      data.text,
      data.sender,
      sourceGroup,
    );
    if (!sent) {
      await deps.sendMessage(data.chatJid, data.text);
    }
  } else {
    await deps.sendMessage(data.chatJid, data.text);
  }
  logger.info(
    { chatJid: data.chatJid, sourceGroup, sender: data.sender },
    'IPC message sent',
  );
  return 'sent';
}

/** Dispatch an IPC image message, translating container paths to host paths. */
export async function dispatchIpcImage(
  data: { chatJid: string; imagePath: string; caption?: string },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<'sent' | 'unauthorized'> {
  const registeredGroups = deps.registeredGroups();
  const targetGroup = registeredGroups[data.chatJid];
  if (!isMain && !(targetGroup && targetGroup.folder === sourceGroup)) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC image attempt blocked',
    );
    return 'unauthorized';
  }

  // Translate container path to host path
  const pathResult = resolveContainerToHostPath(
    data.imagePath,
    sourceGroup,
    registeredGroups,
  );
  if (!pathResult) {
    logger.warn(
      { chatJid: data.chatJid, imagePath: data.imagePath, sourceGroup },
      'IPC image path: unrecognised container prefix blocked',
    );
    return 'unauthorized';
  }

  const { hostPath, allowedDir } = pathResult;
  const resolved = path.resolve(hostPath);
  if (!resolved.startsWith(path.resolve(allowedDir))) {
    logger.warn(
      {
        chatJid: data.chatJid,
        imagePath: data.imagePath,
        resolved,
        allowedDir,
      },
      'IPC image path traversal blocked',
    );
    return 'unauthorized';
  }

  if (!fs.existsSync(hostPath)) {
    logger.warn(
      { chatJid: data.chatJid, imagePath: data.imagePath, hostPath },
      'IPC image file not found',
    );
    await deps.sendMessage(
      data.chatJid,
      data.caption
        ? `${data.caption}\n\n(Image not found: ${data.imagePath})`
        : `(Image not found: ${data.imagePath})`,
    );
    return 'sent';
  }

  if (deps.sendImage) {
    await deps.sendImage(data.chatJid, hostPath, data.caption);
  } else {
    // Channel doesn't support images — send caption as text
    await deps.sendMessage(
      data.chatJid,
      data.caption || '(Image sent but channel does not support images)',
    );
  }

  logger.info(
    { chatJid: data.chatJid, sourceGroup, hostPath },
    'IPC image sent',
  );
  return 'sent';
}

/** Dispatch an IPC document message, translating container paths to host paths. */
export async function dispatchIpcDocument(
  data: {
    chatJid: string;
    documentPath: string;
    filename?: string;
    caption?: string;
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<'sent' | 'unauthorized'> {
  const registeredGroups = deps.registeredGroups();
  const targetGroup = registeredGroups[data.chatJid];
  if (!isMain && !(targetGroup && targetGroup.folder === sourceGroup)) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC document attempt blocked',
    );
    return 'unauthorized';
  }

  // Translate container path to host path
  const pathResult = resolveContainerToHostPath(
    data.documentPath,
    sourceGroup,
    registeredGroups,
  );
  if (!pathResult) {
    logger.warn(
      { chatJid: data.chatJid, documentPath: data.documentPath, sourceGroup },
      'IPC document path: unrecognised container prefix blocked',
    );
    return 'unauthorized';
  }

  const { hostPath, allowedDir } = pathResult;
  const resolved = path.resolve(hostPath);
  if (!resolved.startsWith(path.resolve(allowedDir))) {
    logger.warn(
      {
        chatJid: data.chatJid,
        documentPath: data.documentPath,
        resolved,
        allowedDir,
      },
      'IPC document path traversal blocked',
    );
    return 'unauthorized';
  }

  if (!fs.existsSync(hostPath)) {
    logger.warn(
      { chatJid: data.chatJid, documentPath: data.documentPath, hostPath },
      'IPC document file not found',
    );
    await deps.sendMessage(
      data.chatJid,
      data.caption
        ? `${data.caption}\n\n(Document not found: ${data.documentPath})`
        : `(Document not found: ${data.documentPath})`,
    );
    return 'sent';
  }

  if (deps.sendDocument) {
    await deps.sendDocument(
      data.chatJid,
      hostPath,
      data.filename,
      data.caption,
    );
  } else {
    await deps.sendMessage(
      data.chatJid,
      data.caption || '(Document sent but channel does not support documents)',
    );
  }

  logger.info(
    { chatJid: data.chatJid, sourceGroup, hostPath },
    'IPC document sent',
  );
  return 'sent';
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                await dispatchIpcMessage(data, sourceGroup, isMain, deps);
              } else if (
                data.type === 'image' &&
                data.chatJid &&
                data.imagePath
              ) {
                await dispatchIpcImage(data, sourceGroup, isMain, deps);
              } else if (
                data.type === 'document' &&
                data.chatJid &&
                data.documentPath
              ) {
                await dispatchIpcDocument(data, sourceGroup, isMain, deps);
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');

  // Auto-done: every 10 minutes, mark active cases with no activity for >2h as done.
  // Catches cases where the agent exited without calling case_mark_done.
  const AUTO_DONE_INTERVAL = 10 * 60 * 1000;
  const AUTO_DONE_MAX_IDLE = 2 * 60 * 60 * 1000;
  setInterval(() => {
    try {
      const staleCases = getStaleActiveCases(AUTO_DONE_MAX_IDLE);
      for (const c of staleCases) {
        logger.info(
          { caseId: c.id, name: c.name, lastActivity: c.last_activity_at },
          'Auto-marking stale active case as done',
        );
        if (c.worktree_path) {
          removeWorktreeLock(c.worktree_path);
        }
        updateCase(c.id, {
          status: 'done',
          done_at: new Date().toISOString(),
          last_activity_at: new Date().toISOString(),
          conclusion:
            'Auto-completed: no activity for 2+ hours without calling case_mark_done',
        });
      }
      if (staleCases.length > 0) {
        logger.info({ count: staleCases.length }, 'Auto-done cycle complete');
      }
    } catch (err) {
      logger.error({ err }, 'Auto-done reaper failed');
    }
  }, AUTO_DONE_INTERVAL);

  // Auto-prune: every 10 minutes, prune cases that have been done for >24h
  const AUTO_PRUNE_INTERVAL = 10 * 60 * 1000;
  const AUTO_PRUNE_MAX_AGE = 24 * 60 * 60 * 1000;
  setInterval(() => {
    try {
      const staleCases = getStaleDoneCases(AUTO_PRUNE_MAX_AGE);
      for (const c of staleCases) {
        logger.info(
          { caseId: c.id, name: c.name, doneAt: c.done_at },
          'Auto-pruning stale done case',
        );
        try {
          pruneCaseWorkspace(c);
          updateCase(c.id, {
            status: 'pruned',
            pruned_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString(),
          });
        } catch (pruneErr) {
          logger.warn(
            { caseId: c.id, err: pruneErr },
            'Auto-prune skipped for case (locked or status guard)',
          );
        }
      }
      if (staleCases.length > 0) {
        logger.info({ count: staleCases.length }, 'Auto-prune cycle complete');
      }
    } catch (err) {
      logger.error({ err }, 'Auto-prune failed');
    }
  }, AUTO_PRUNE_INTERVAL);
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    caseId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
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
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    // --- Case lifecycle IPC ---
    case 'case_mark_done':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          // Release worktree lock when case is done
          if (caseItem.worktree_path) {
            removeWorktreeLock(caseItem.worktree_path);
          }
          updateCase(data.caseId, {
            status: 'done',
            done_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString(),
            conclusion:
              ((data as Record<string, unknown>).conclusion as string) || null,
            last_message:
              ((data as Record<string, unknown>).conclusion as string) ||
              caseItem.last_message,
          });
          logger.info(
            { caseId: data.caseId, sourceGroup },
            'Case marked done via IPC',
          );
        }
      }
      break;

    case 'case_mark_blocked':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          updateCase(data.caseId, {
            status: 'blocked',
            blocked_on:
              ((data as Record<string, unknown>).blocked_on as string) ||
              'user',
            last_activity_at: new Date().toISOString(),
          });
          logger.info(
            { caseId: data.caseId, sourceGroup },
            'Case marked blocked via IPC',
          );
        }
      }
      break;

    case 'case_mark_active':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          updateCase(data.caseId, {
            status: 'active',
            blocked_on: null,
            last_activity_at: new Date().toISOString(),
          });
          logger.info(
            { caseId: data.caseId, sourceGroup },
            'Case marked active via IPC',
          );
        }
      }
      break;

    case 'case_mark_reviewed':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          if (caseItem.status !== 'done') {
            logger.warn(
              { caseId: data.caseId, status: caseItem.status },
              'Cannot review case — not in done status',
            );
          } else {
            updateCase(data.caseId, {
              status: 'reviewed',
              reviewed_at: new Date().toISOString(),
              last_activity_at: new Date().toISOString(),
            });
            logger.info(
              { caseId: data.caseId, sourceGroup },
              'Case marked reviewed via IPC',
            );
          }
        }
      }
      break;

    case 'case_prune':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          try {
            pruneCaseWorkspace(caseItem);
            updateCase(data.caseId, {
              status: 'pruned',
              pruned_at: new Date().toISOString(),
              last_activity_at: new Date().toISOString(),
            });
            logger.info(
              { caseId: data.caseId, sourceGroup },
              'Case pruned via IPC — workspace removed',
            );
          } catch (pruneErr) {
            logger.warn(
              { caseId: data.caseId, err: pruneErr },
              'Case prune refused — status guard or lock prevented deletion',
            );
          }
        }
      }
      break;

    case 'case_update_activity':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          const updates: Record<string, unknown> = {
            last_activity_at: new Date().toISOString(),
          };
          if ((data as Record<string, unknown>).last_message) {
            updates.last_message = (
              data as Record<string, unknown>
            ).last_message;
          }
          updateCase(data.caseId, updates as Parameters<typeof updateCase>[1]);
        }
      }
      break;

    case 'case_create': {
      const d = data as unknown as {
        description: string;
        context?: string;
        shortName?: string;
        caseType?: string;
        chatJid?: string;
        initiator?: string;
        githubIssue?: number;
      };
      if (!d.description) {
        logger.warn({ sourceGroup }, 'case_create missing description');
        break;
      }
      // Warn if a kaizen issue already has an active case
      if (d.githubIssue) {
        const existing = getActiveCasesByGithubIssue(d.githubIssue);
        if (existing.length > 0) {
          const names = existing.map((c) => c.name).join(', ');
          logger.warn(
            { githubIssue: d.githubIssue, existingCases: names, sourceGroup },
            `Kaizen #${d.githubIssue} already has active case(s): ${names}`,
          );
          // Resolve chatJid early for the warning message
          const warnJid =
            d.chatJid ||
            Object.entries(registeredGroups).find(
              ([, g]) => g.folder === sourceGroup,
            )?.[0];
          if (warnJid) {
            deps
              .sendMessage(
                warnJid,
                `⚠️ Kaizen #${d.githubIssue} already has active case(s): ${names}. Creating another anyway.`,
              )
              .catch(() => {
                /* non-critical */
              });
          }
        }
      }

      // Authoritative gate: determines case type and authorization status.
      // All case type + approval decisions go through case-auth.ts — do NOT duplicate here.
      const requestedType = d.caseType === 'dev' ? 'dev' : 'work';
      const authDecision = authorizeCaseCreation({
        requestedType,
        description: d.description,
        sourceGroup,
        isMain,
      });

      const { caseType, autoPromoted } = authDecision;
      const id = generateCaseId();
      const name = generateCaseName(d.description, d.shortName);
      const now = new Date().toISOString();

      // Resolve chatJid: use provided value, or find from registered groups
      const resolvedChatJid =
        d.chatJid ||
        Object.entries(registeredGroups).find(
          ([, g]) => g.folder === sourceGroup,
        )?.[0] ||
        '';

      // Unauthorized dev case → route through approval gate
      if (authDecision.status === 'suggested') {
        const suggested = suggestDevCase({
          groupFolder: sourceGroup,
          chatJid: resolvedChatJid,
          description: autoPromoted
            ? `[auto-promoted work→dev] ${d.description}`
            : d.description,
          sourceWorkCaseId: 'direct-request',
          initiator: d.initiator || 'agent',
          initiatorChannel: undefined,
          githubIssue: d.githubIssue,
        });

        logger.info(
          {
            caseId: suggested.id,
            name: suggested.name,
            sourceGroup,
            autoPromoted,
            reason: authDecision.reason,
          },
          'Dev case routed to approval gate',
        );

        // Write result so MCP tool can read it back
        const resultDir = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'case_results',
        );
        fs.mkdirSync(resultDir, { recursive: true });
        const resultFile = (data as Record<string, unknown>).requestId
          ? `${(data as Record<string, unknown>).requestId}.json`
          : `${suggested.id}.json`;
        fs.writeFileSync(
          path.join(resultDir, resultFile),
          JSON.stringify({
            id: suggested.id,
            name: suggested.name,
            workspace_path: '',
            github_issue: suggested.github_issue,
            issue_url: null,
            status: 'suggested',
            needs_approval: true,
          }),
        );

        // Notify main group about pending approval
        const mainJid = Object.entries(registeredGroups).find(
          ([, g]) => g.isMain,
        )?.[0];
        if (mainJid) {
          deps
            .sendMessage(
              mainJid,
              `🔒 Dev case needs approval: ${suggested.name}\n${d.description.slice(0, 200)}\n(from: ${sourceGroup}${autoPromoted ? ', auto-promoted from work' : ''})\nReply "approve" to activate.`,
            )
            .catch(() => {
              /* non-critical */
            });
        }
        break;
      }

      // Authorized case — create immediately as active
      // Dev cases auto-create a GitHub issue for tracking (unless one was provided)
      let githubIssue = d.githubIssue ?? null;
      let issueUrl: string | null = null;
      if (caseType === 'dev' && !githubIssue) {
        const issueBody = d.context
          ? `## TL;DR\n\n${d.description}\n\n---\n\n## Details\n\n${d.context}\n\n---\n\n*Auto-created by dev case \`${name}\`*`
          : `${d.description}\n\n---\n*Auto-created by dev case \`${name}\`*`;
        const issueResult = await createGitHubIssue({
          owner: DEV_CASE_ISSUE_REPO.owner,
          repo: DEV_CASE_ISSUE_REPO.repo,
          title: d.description,
          body: issueBody,
          labels: ['kaizen'],
        });
        if (issueResult.success && issueResult.issueNumber) {
          githubIssue = issueResult.issueNumber;
          issueUrl = issueResult.issueUrl ?? null;
          logger.info(
            { caseId: id, issueNumber: githubIssue, issueUrl },
            'Auto-created GitHub issue for dev case',
          );
        } else {
          logger.warn(
            { caseId: id, error: issueResult.error },
            'Failed to auto-create GitHub issue for dev case (continuing without)',
          );
        }
      }

      const { workspacePath, worktreePath, branchName } = createCaseWorkspace(
        name,
        caseType,
        id,
      );

      const newCase: Case = {
        id,
        group_folder: sourceGroup,
        chat_jid: resolvedChatJid,
        name,
        description: d.description,
        type: caseType,
        status: 'active',
        blocked_on: null,
        worktree_path: worktreePath,
        workspace_path: workspacePath,
        branch_name: branchName,
        initiator: d.initiator || 'agent',
        initiator_channel: null,
        last_message: null,
        last_activity_at: now,
        conclusion: null,
        created_at: now,
        done_at: null,
        reviewed_at: null,
        pruned_at: null,
        total_cost_usd: 0,
        token_source: null,
        time_spent_ms: 0,
        github_issue: githubIssue,
      };

      insertCase(newCase);
      logger.info(
        {
          caseId: id,
          name,
          caseType,
          sourceGroup,
          githubIssue,
          autoPromoted,
          reason: authDecision.reason,
        },
        'Case created via IPC',
      );

      // Write result file so the MCP tool can read it back
      const resultDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'case_results');
      fs.mkdirSync(resultDir, { recursive: true });
      const resultFile = (data as Record<string, unknown>).requestId
        ? `${(data as Record<string, unknown>).requestId}.json`
        : `${id}.json`;
      fs.writeFileSync(
        path.join(resultDir, resultFile),
        JSON.stringify({
          id,
          name,
          workspace_path: workspacePath,
          github_issue: githubIssue,
          issue_url: issueUrl,
        }),
      );

      // Notify user — dev cases notify main group, work cases notify source group
      const notifyJid =
        caseType === 'dev'
          ? Object.entries(registeredGroups).find(([, g]) => g.isMain)?.[0] ||
            resolvedChatJid
          : resolvedChatJid;
      if (notifyJid) {
        const issueInfo = issueUrl ? `\nGitHub: ${issueUrl}` : '';
        deps
          .sendMessage(
            notifyJid,
            `📋 New ${caseType} case created: ${name}\n${d.description.slice(0, 200)}${issueInfo}`,
          )
          .catch(() => {
            /* non-critical */
          });
      }
      break;
    }

    case 'case_suggest_dev':
      if (
        (data as Record<string, unknown>).description &&
        (data as Record<string, unknown>).sourceCaseId
      ) {
        const d = data as unknown as {
          description: string;
          sourceCaseId: string;
          chatJid?: string;
          githubIssue?: number;
        };
        suggestDevCase({
          groupFolder: sourceGroup,
          chatJid: d.chatJid || '',
          description: d.description,
          sourceWorkCaseId: d.sourceCaseId,
          initiator: 'agent',
          initiatorChannel: undefined,
          githubIssue: d.githubIssue,
        });
        // Notify main group about the dev suggestion
        const targetJid =
          Object.entries(registeredGroups).find(([, g]) => g.isMain)?.[0] ||
          Object.entries(registeredGroups).find(
            ([, g]) => g.folder === sourceGroup,
          )?.[0];
        if (targetJid) {
          deps
            .sendMessage(
              targetJid,
              `💡 Dev case suggested: ${d.description.slice(0, 200)}\n(from case ${d.sourceCaseId})\nReply "approve" to add to backlog.`,
            )
            .catch(() => {
              /* non-critical */
            });
        }
      }
      break;

    case 'case_heartbeat':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          if (caseItem.worktree_path) {
            updateWorktreeLockHeartbeat(caseItem.worktree_path);
          }
          updateCase(data.caseId, {
            last_activity_at: new Date().toISOString(),
          });
          logger.debug(
            { caseId: data.caseId, sourceGroup },
            'Case heartbeat updated',
          );
        }
      }
      break;

    case 'case_unlock':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          if (caseItem.worktree_path) {
            removeWorktreeLock(caseItem.worktree_path);
            logger.info(
              { caseId: data.caseId, sourceGroup },
              'Case worktree unlocked via IPC',
            );
          }
        }
      }
      break;

    case 'create_github_issue': {
      const d = data as unknown as {
        owner?: string;
        repo?: string;
        title?: string;
        body?: string;
        labels?: string[];
        requestId?: string;
      };
      if (!d.title || !d.owner || !d.repo) {
        logger.warn(
          { sourceGroup, isMain },
          'create_github_issue missing required fields',
        );
        break;
      }

      logger.info(
        { sourceGroup, isMain, repo: `${d.owner}/${d.repo}`, title: d.title },
        'create_github_issue requested',
      );

      const result = await createGitHubIssue({
        owner: d.owner,
        repo: d.repo,
        title: d.title,
        body: d.body || '',
        labels: d.labels || ['work-agent', 'needs-dev'],
      });

      // Write result file so the MCP tool can read it back
      if (d.requestId) {
        const resultDir = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'issue_results',
        );
        fs.mkdirSync(resultDir, { recursive: true });
        fs.writeFileSync(
          path.join(resultDir, `${d.requestId}.json`),
          JSON.stringify(result),
        );
      }

      // Notify via Telegram if issue was created successfully
      if (result.success && result.issueUrl) {
        const chatJid = Object.entries(registeredGroups).find(
          ([, g]) => g.folder === sourceGroup,
        )?.[0];
        if (chatJid) {
          deps
            .sendMessage(
              chatJid,
              `🐛 Work agent created issue: ${result.issueUrl}`,
            )
            .catch(() => {
              /* non-critical */
            });
        }
      }

      logger.info(
        { sourceGroup, success: result.success, issueUrl: result.issueUrl },
        'create_github_issue processed',
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
