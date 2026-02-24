import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import {
  cleanupDevBranch,
  createDevBranch,
  createDevGroupClaudeMd,
  devGroupFolder,
  getFeatureDiff,
  mergeFeatureBranch,
  rebuildProject,
  restartService,
  sanitizeFeatureName,
  testFeature,
} from './dev-workflow.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  createWhatsAppGroup?: (name: string, participants?: string[]) => Promise<string>;
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

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
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
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
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
    // For dev workflow
    featureName?: string;
    participants?: string[];
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
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
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

    case 'create_dev_group': {
      // Only main group can create dev groups
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized create_dev_group attempt blocked');
        break;
      }
      if (!data.featureName) {
        logger.warn({ data }, 'Invalid create_dev_group - missing featureName');
        break;
      }

      const featureName = data.featureName;

      try {
        // 1. Create git branch + worktree
        const { branchName } = createDevBranch(featureName);
        const folder = devGroupFolder(featureName);

        // 2. Create WhatsApp group if the channel supports it
        let groupJid: string | undefined;
        if (deps.createWhatsAppGroup) {
          const groupName = `Dev: ${featureName}`;
          groupJid = await deps.createWhatsAppGroup(groupName, data.participants);
        }

        if (!groupJid) {
          // No WhatsApp group creation available — log for manual setup
          logger.info(
            { featureName, branchName, folder },
            'Dev branch created. Create a WhatsApp group manually and register it.',
          );
          // Find the chat JID that sent the request so we can notify them
          const mainJid = Object.entries(registeredGroups)
            .find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];
          if (mainJid) {
            await deps.sendMessage(
              mainJid,
              `${ASSISTANT_NAME}: Dev branch \`${branchName}\` created. Create a WhatsApp group and register it with folder \`${folder}\`.`,
            );
          }
          break;
        }

        // 3. Create CLAUDE.md for the dev group
        createDevGroupClaudeMd(folder, featureName, branchName);

        // 4. Register the group
        deps.registerGroup(groupJid, {
          name: `Dev: ${featureName}`,
          folder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false, // Dev groups process all messages
          isDev: true,
          featureBranch: branchName,
        });

        // 5. Notify the main group
        const mainJid = Object.entries(registeredGroups)
          .find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];
        if (mainJid) {
          await deps.sendMessage(
            mainJid,
            `${ASSISTANT_NAME}: Dev group created for *${featureName}*\nBranch: \`${branchName}\`\nGroup registered and ready to use.`,
          );
        }

        // Send welcome message to the new dev group
        await deps.sendMessage(
          groupJid,
          `${ASSISTANT_NAME}: Dev group ready!\n\nBranch: \`${branchName}\`\nDescribe what you want to build and I'll implement it.`,
        );

        logger.info(
          { featureName, branchName, groupJid, folder },
          'Dev group created successfully',
        );
      } catch (err) {
        logger.error({ featureName, err }, 'Failed to create dev group');
        const mainJid = Object.entries(registeredGroups)
          .find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];
        if (mainJid) {
          await deps.sendMessage(
            mainJid,
            `${ASSISTANT_NAME}: Failed to create dev group: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    case 'test_feature': {
      // Can be called from the dev group itself or from main
      const devGroup = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup && g.isDev,
      );
      if (!devGroup && !isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized test_feature attempt');
        break;
      }

      const featureBranchName = devGroup?.featureBranch || data.featureName;
      if (!featureBranchName) {
        logger.warn({ sourceGroup }, 'test_feature: no feature branch found');
        break;
      }

      const feature = featureBranchName.replace(/^feature\//, '');
      const testResult = testFeature(feature);

      // Send result to the requesting group
      const requestJid = Object.entries(registeredGroups)
        .find(([, g]) => g.folder === sourceGroup)?.[0];
      if (requestJid) {
        const status = testResult.success ? 'passed' : 'FAILED';
        const output = testResult.output.slice(-500); // Last 500 chars
        await deps.sendMessage(
          requestJid,
          `${ASSISTANT_NAME}: Tests ${status}\n\`\`\`\n${output}\n\`\`\``,
        );
      }

      logger.info(
        { feature, success: testResult.success, sourceGroup },
        'Feature test completed',
      );
      break;
    }

    case 'feature_status': {
      const devGroupStatus = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup && g.isDev,
      );
      if (!devGroupStatus && !isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized feature_status attempt');
        break;
      }

      const branchForStatus = devGroupStatus?.featureBranch || data.featureName;
      if (!branchForStatus) {
        logger.warn({ sourceGroup }, 'feature_status: no feature branch found');
        break;
      }

      const featureForStatus = branchForStatus.replace(/^feature\//, '');
      const diff = getFeatureDiff(featureForStatus);

      const statusJid = Object.entries(registeredGroups)
        .find(([, g]) => g.folder === sourceGroup)?.[0];
      if (statusJid) {
        await deps.sendMessage(
          statusJid,
          `${ASSISTANT_NAME}: Feature status for \`${branchForStatus}\`:\n\`\`\`\n${diff}\n\`\`\``,
        );
      }
      break;
    }

    case 'merge_feature': {
      // Only main group or the dev group itself can merge
      const devGroupMerge = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup && g.isDev,
      );
      if (!devGroupMerge && !isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized merge_feature attempt');
        break;
      }

      const branchToMerge = devGroupMerge?.featureBranch || data.featureName;
      if (!branchToMerge) {
        logger.warn({ sourceGroup }, 'merge_feature: no feature branch found');
        break;
      }

      const mergeJid = Object.entries(registeredGroups)
        .find(([, g]) => g.folder === sourceGroup)?.[0];

      // 1. Merge the branch
      const mergeResult = mergeFeatureBranch(branchToMerge);
      if (!mergeResult.success) {
        if (mergeJid) {
          await deps.sendMessage(
            mergeJid,
            `${ASSISTANT_NAME}: Merge failed:\n\`\`\`\n${mergeResult.output.slice(-500)}\n\`\`\``,
          );
        }
        break;
      }

      // 2. Rebuild
      const buildResult = rebuildProject();
      if (!buildResult.success) {
        if (mergeJid) {
          await deps.sendMessage(
            mergeJid,
            `${ASSISTANT_NAME}: Merge succeeded but build failed:\n\`\`\`\n${buildResult.output.slice(-500)}\n\`\`\``,
          );
        }
        break;
      }

      // 3. Notify before restart
      const mainJidForMerge = Object.entries(registeredGroups)
        .find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];
      if (mainJidForMerge) {
        await deps.sendMessage(
          mainJidForMerge,
          `${ASSISTANT_NAME}: Feature \`${branchToMerge}\` merged and built successfully. Restarting...`,
        );
      }

      // 4. Clean up worktree (keep branch for history)
      const featureToClean = branchToMerge.replace(/^feature\//, '');
      cleanupDevBranch(featureToClean, true);

      // 5. Restart (this will kill the process)
      logger.info({ branchToMerge }, 'Merge complete, restarting service');
      // Small delay to let the notification message send
      setTimeout(() => restartService(), 2000);
      break;
    }

    case 'cleanup_dev_group': {
      // Only main group can clean up dev groups
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized cleanup_dev_group attempt');
        break;
      }

      if (!data.featureName) {
        logger.warn({ data }, 'cleanup_dev_group: missing featureName');
        break;
      }

      const featureToRemove = data.featureName;
      const folderToRemove = devGroupFolder(featureToRemove);

      // Find and unregister the group
      const devJid = Object.entries(registeredGroups)
        .find(([, g]) => g.folder === folderToRemove)?.[0];

      // Clean up git worktree and branch
      cleanupDevBranch(sanitizeFeatureName(featureToRemove), true);

      logger.info(
        { featureName: featureToRemove, folder: folderToRemove, jid: devJid },
        'Dev group cleaned up',
      );

      const mainJidCleanup = Object.entries(registeredGroups)
        .find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];
      if (mainJidCleanup) {
        await deps.sendMessage(
          mainJidCleanup,
          `${ASSISTANT_NAME}: Dev group for *${featureToRemove}* cleaned up. Worktree and branch removed.`,
        );
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
