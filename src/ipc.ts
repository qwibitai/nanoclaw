import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { readEnvFile } from './env.js';
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
    // For launch_skill
    skillName?: string;
    skillArgs?: string;
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

    case 'launch_skill': {
      // Groups can launch skills matching their own folder name (e.g., "dora" group → "dora" skill).
      // Main group can launch any skill.
      if (!isMain && sourceGroup !== (data.skillName as string)) {
        logger.warn({ sourceGroup, skillName: data.skillName }, 'Unauthorized launch_skill attempt blocked');
        break;
      }

      const ALLOWED_SKILLS = ['dora'];
      const skillName = data.skillName as string;
      const skillArgs = data.skillArgs as string || '';
      const skillChatJid = data.chatJid as string;

      if (!skillName || !ALLOWED_SKILLS.includes(skillName)) {
        logger.warn({ skillName }, 'Unknown or disallowed skill');
        break;
      }

      if (!skillChatJid) {
        logger.warn({ skillName }, 'launch_skill missing chatJid');
        break;
      }

      // Read the SKILL.md and inject it as system prompt context.
      // In -p mode, /skillname doesn't trigger the skill loader —
      // we must inject the instructions explicitly.
      const projectRoot = path.resolve(DATA_DIR, '..');
      const skillPath = path.join(projectRoot, '.claude', 'skills', skillName, 'SKILL.md');
      if (!fs.existsSync(skillPath)) {
        logger.error({ skillName, skillPath }, 'Skill file not found');
        await deps.sendMessage(skillChatJid, `❌ Skill "${skillName}" not found.`);
        break;
      }

      let skillContent = fs.readFileSync(skillPath, 'utf-8');
      // Strip YAML frontmatter
      skillContent = skillContent.replace(/^---[\s\S]*?---\n*/, '');

      logger.info({ skillName, skillArgs, sourceGroup }, 'Launching skill on host');

      // Notify the group that the skill is starting
      await deps.sendMessage(skillChatJid, `🔍 Launching /${skillName} ${skillArgs}...`);

      // Build the user prompt. The Chrome MCP bridge takes ~10 seconds
      // to connect to the Unix sockets. We MUST tell the model to wait
      // before its first Chrome tool call, otherwise it will fail and
      // respond with text instead of browsing.
      const userPrompt = [
        `You are running the /${skillName} skill. Follow your system prompt instructions precisely.`,
        `IMPORTANT: The Chrome MCP bridge needs ~10 seconds to initialize.`,
        `Before your FIRST Chrome tool call, you MUST wait 12 seconds using the computer tool's wait action (action: "wait", duration: 12).`,
        `After waiting, call mcp__Claude_in_Chrome__tabs_context_mcp with createIfEmpty: true.`,
        `If it returns an error, wait 5 more seconds and retry — up to 3 times.`,
        `Once Chrome is connected, proceed with the full workflow from your system prompt.`,
        `Do NOT skip the wait. Do NOT respond with just text. You MUST browse with Chrome tools.`,
        skillArgs ? `\nUser request: ${skillArgs}` : '',
      ].filter(Boolean).join('\n');

      // Spawn claude CLI async — don't block IPC loop.
      // Uses sonnet (not haiku) because complex multi-step Chrome
      // browsing requires stronger reasoning.
      // Read API credentials from .env (not in process.env by design).
      const secrets = readEnvFile(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
      const startTime = Date.now();
      const child = spawn('claude', [
        '-p',
        '--chrome',
        '--model', 'sonnet',
        '--permission-mode', 'bypassPermissions',
        '--append-system-prompt', skillContent,
        userPrompt,
      ], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...secrets },
        detached: false,
      });

      let skillStdout = '';
      let skillStderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        if (skillStdout.length < 10000) skillStdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (skillStderr.length < 5000) skillStderr += chunk.toString();
      });

      child.on('close', async (code) => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        // Find main group JID for cross-group notifications
        const currentGroups = deps.registeredGroups();
        const mainJid = Object.entries(currentGroups).find(
          ([_, g]) => g.folder === MAIN_GROUP_FOLDER,
        )?.[0];

        if (code === 0) {
          logger.info({ skillName, elapsed, stdout: skillStdout.slice(0, 1000) }, 'Skill completed');
          if (elapsed < 30) {
            // Suspiciously fast — model probably just responded with text
            logger.warn({ skillName, elapsed, stdout: skillStdout.slice(0, 2000) }, 'Skill completed too fast — likely did not browse');
            await deps.sendMessage(skillChatJid, `⚠️ /${skillName} finished in ${elapsed}s (too fast — may not have browsed). Output: ${skillStdout.slice(0, 300)}`);
          } else {
            await deps.sendMessage(skillChatJid, `✅ /${skillName} completed (${elapsed}s). Research report saved.`);

            // Notify main group (Ruby) if skill was launched by a different group
            if (sourceGroup !== MAIN_GROUP_FOLDER && mainJid) {
              await deps.sendMessage(
                mainJid,
                `📊 Dora completed research (${elapsed}s). New report saved in research/. Please review and organize to Google Drive.`,
              );
            }
          }
        } else {
          const output = (skillStderr || skillStdout).slice(0, 500);
          logger.error({ skillName, code, elapsed, stderr: skillStderr.slice(0, 500), stdout: skillStdout.slice(0, 500) }, 'Skill failed');
          await deps.sendMessage(skillChatJid, `❌ /${skillName} failed (exit ${code}). ${output}`);

          // Also notify main on failure if from a different group
          if (sourceGroup !== MAIN_GROUP_FOLDER && mainJid) {
            await deps.sendMessage(mainJid, `⚠️ Dora research failed (exit ${code}). Check logs.`);
          }
        }
      });

      child.on('error', async (err) => {
        logger.error({ skillName, err }, 'Failed to spawn skill process');
        await deps.sendMessage(skillChatJid, `❌ Failed to launch /${skillName}: ${err.message}`);
      });

      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
