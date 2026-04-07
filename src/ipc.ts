import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getPrThread,
  getTaskById,
  updatePrThreadStatus,
  updateTask,
  upsertPrThread,
} from './db.js';
import { isError, isSyntaxError } from './error-utils.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  unregisterGroup?: (jid: string, agentType: string) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  createThread?: (parentJid: string, name: string) => Promise<string>;
  archiveThread?: (threadJid: string) => Promise<void>;
  enqueueSyntheticMessage?: (
    chatJid: string,
    groupFolder: string,
    text: string,
  ) => void;
}

function computePrFingerprint(task: {
  ciStatus?: string;
  mergeability?: string;
  failedChecks?: string[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ciStatus: task.ciStatus || null,
        mergeability: task.mergeability || null,
        failedChecks: [...(task.failedChecks || [])].sort(),
      }),
    )
    .digest('hex');
}

function buildPrStatusMessage(task: {
  repoFullName?: string;
  prNumber?: number;
  prTitle?: string;
  branch?: string;
  author?: string;
  headSha?: string;
  ciStatus?: string;
  mergeability?: string;
  failedChecks?: string[];
}): string {
  const lines = [
    `PR #${task.prNumber}${task.prTitle ? `: ${task.prTitle}` : ''}`,
    task.repoFullName ? `Repo: ${task.repoFullName}` : null,
    task.branch ? `Branch: ${task.branch}` : null,
    task.author ? `Author: ${task.author}` : null,
    task.headSha ? `Head SHA: ${task.headSha}` : null,
    `CI: ${task.ciStatus || 'unknown'}`,
    `Mergeability: ${task.mergeability || 'unknown'}`,
  ];

  if (task.failedChecks && task.failedChecks.length > 0) {
    lines.push(`Failed checks: ${task.failedChecks.join(', ')}`);
  }

  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

function buildPrAgentPrompt(task: {
  repoFullName: string;
  prNumber: number;
  prTitle?: string;
  branch?: string;
  author?: string;
  ciStatus?: string;
  mergeability?: string;
  failedChecks?: string[];
}): string {
  return [
    'PR review thread initialized.',
    `PR #${task.prNumber}${task.prTitle ? `: ${task.prTitle}` : ''}`,
    `Repository: ${task.repoFullName}`,
    task.branch ? `Branch: ${task.branch}` : null,
    task.author ? `Author: ${task.author}` : null,
    `CI status: ${task.ciStatus || 'unknown'}`,
    `Mergeability: ${task.mergeability || 'unknown'}`,
    task.failedChecks && task.failedChecks.length > 0
      ? `Failed checks: ${task.failedChecks.join(', ')}`
      : null,
    'Wait for user instructions. Use the GitHub plugin for merge, comment, request changes, or close actions.',
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function writePrAgentFile(
  groupFolder: string,
  task: {
    repoFullName: string;
    prNumber: number;
    prTitle?: string;
    branch?: string;
    author?: string;
  },
): void {
  const groupDir = resolveGroupFolderPath(groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(
    path.join(groupDir, 'agent.md'),
    `# PR Review Agent

이 세션은 GitHub PR 관리를 위한 전용 에이전트입니다.

## PR 정보
- PR #${task.prNumber}: ${task.prTitle || ''}
- 저장소: ${task.repoFullName}
- 브랜치: ${task.branch || 'unknown'}
- 작성자: ${task.author || 'unknown'}

## 사용 가능한 명령
사용자의 자연어 명령을 GitHub plugin으로 실행합니다:
- "머지해줘" -> PR merge
- "댓글 달아줘 [내용]" -> PR comment
- "수정 요청해줘 [이유]" -> request changes review
- "닫아줘" -> PR close
- "상태 확인해줘" -> CI/merge 상태 재조회

## 규칙
- 명령 전에는 PR 상태 요약만 간단히 답하고 대기
- GitHub plugin을 사용해서 실제 액션 수행
- 에러 발생 시 명확하게 알림
`,
  );
}

function buildPrGroupFolder(repoFullName: string, prNumber: number): string {
  const repoSlug = repoFullName.replace(/[^A-Za-z0-9_-]+/g, '-');
  const folder = `pr-${repoSlug}-${prNumber}`.replace(/-+/g, '-');
  if (folder.length <= 64 && isValidGroupFolder(folder)) return folder;
  const hash = createHash('sha1').update(`${repoFullName}#${prNumber}`).digest('hex').slice(0, 12);
  return `pr-${hash}-${prNumber}`;
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
      if (!isError(err)) throw err;
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
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              if (!isError(err) && !isSyntaxError(err)) throw err;
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
        if (!isError(err)) throw err;
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
              if (!isError(err) && !isSyntaxError(err)) throw err;
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
        if (!isError(err)) throw err;
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    action?: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    repoFullName?: string;
    prNumber?: number;
    headSha?: string;
    workflowRunId?: number;
    prTitle?: string;
    branch?: string;
    author?: string;
    ciStatus?: string;
    mergeability?: string;
    failedChecks?: string[];
    merged?: boolean;
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
          } catch (err) {
            if (!isError(err)) throw err;
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
          script: data.script || null,
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
        deps.onTasksChanged();
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
          deps.onTasksChanged();
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
          deps.onTasksChanged();
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
          deps.onTasksChanged();
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
        if (data.script !== undefined) updates.script = data.script || null;
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
        deps.onTasksChanged();
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

    case 'github_pr_event': {
      if (!data.groupFolder || !data.repoFullName || !data.prNumber) {
        logger.warn({ data }, 'Invalid github_pr_event request');
        break;
      }
      if (!isMain && data.groupFolder !== sourceGroup) {
        logger.warn(
          { sourceGroup, groupFolder: data.groupFolder },
          'Unauthorized github_pr_event attempt blocked',
        );
        break;
      }

      if (data.action === 'notify') {
        const parentGroup = Object.entries(registeredGroups).find(
          ([, group]) =>
            group.folder === data.groupFolder && group.agentType === 'codex',
        );
        if (!parentGroup) {
          logger.warn(
            { groupFolder: data.groupFolder },
            'No registered PR review parent group found',
          );
          break;
        }
        if (!deps.createThread) {
          logger.warn('No createThread support configured for github_pr_event');
          break;
        }

        const fingerprint = computePrFingerprint(data);
        const existing = getPrThread(data.repoFullName, data.prNumber);
        if (existing?.last_fingerprint === fingerprint) {
          logger.info(
            { repo: data.repoFullName, prNumber: data.prNumber },
            'Skipping duplicate PR notification',
          );
          break;
        }

        const parentJid = parentGroup[0];
        const threadJid =
          existing?.thread_jid ??
          (await deps.createThread(
            parentJid,
            `PR #${data.prNumber}${data.prTitle ? ` ${data.prTitle}` : ''}`,
          ));
        const prGroupFolder = existing?.group_folder
          ? existing.group_folder
          : buildPrGroupFolder(data.repoFullName, data.prNumber);
        const statusMessage = buildPrStatusMessage(data);

        if (!existing) {
          deps.registerGroup(threadJid, {
            name: `PR #${data.prNumber}`,
            folder: prGroupFolder,
            trigger: parentGroup[1].trigger,
            added_at: new Date().toISOString(),
            agentType: 'codex',
            requiresTrigger: false,
            isMain: false,
            containerConfig: parentGroup[1].containerConfig,
          });
          writePrAgentFile(prGroupFolder, {
            repoFullName: data.repoFullName,
            prNumber: data.prNumber,
            prTitle: data.prTitle,
            branch: data.branch,
            author: data.author,
          });
        }

        upsertPrThread(
          data.repoFullName,
          data.prNumber,
          threadJid,
          prGroupFolder,
          parentJid,
          data.headSha,
          data.workflowRunId,
          fingerprint,
        );
        await deps.sendMessage(threadJid, statusMessage);

        if (!existing && deps.enqueueSyntheticMessage) {
          deps.enqueueSyntheticMessage(
            threadJid,
            prGroupFolder,
            buildPrAgentPrompt({
              repoFullName: data.repoFullName,
              prNumber: data.prNumber,
              prTitle: data.prTitle,
              branch: data.branch,
              author: data.author,
              ciStatus: data.ciStatus,
              mergeability: data.mergeability,
              failedChecks: data.failedChecks,
            }),
          );
        }
        break;
      }

      if (data.action === 'closed') {
        const existing = getPrThread(data.repoFullName, data.prNumber);
        if (!existing) {
          logger.warn(
            { repo: data.repoFullName, prNumber: data.prNumber },
            'PR thread not found for close event',
          );
          break;
        }

        await deps.sendMessage(
          existing.thread_jid,
          `PR #${data.prNumber} ${data.merged ? 'merged' : 'closed'}. Archiving thread.`,
        );
        deps.unregisterGroup?.(existing.thread_jid, 'codex');

        const closedAt = new Date().toISOString();
        if (!deps.archiveThread) {
          updatePrThreadStatus(
            data.repoFullName,
            data.prNumber,
            'archive_pending',
            closedAt,
          );
          break;
        }

        try {
          await deps.archiveThread(existing.thread_jid);
          updatePrThreadStatus(
            data.repoFullName,
            data.prNumber,
            'archived',
            closedAt,
          );
        } catch (err) {
          if (!isError(err)) throw err;
          logger.warn(
            { repo: data.repoFullName, prNumber: data.prNumber, err },
            'Failed to archive PR thread, will retry later',
          );
          updatePrThreadStatus(
            data.repoFullName,
            data.prNumber,
            'archive_pending',
            closedAt,
          );
        }
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
