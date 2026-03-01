import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  EMAIL_FROM_NAME,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  SMTP_USER,
  TIMEZONE,
} from './config.js';
import { EmailChannel } from './channels/email.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
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
  emailChannel?: EmailChannel;
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
    // For email actions
    to?: string;
    cc?: string;
    subject?: string;
    text?: string;
    comment?: string;
    messageId?: string;
    query?: string;
    attachments?: Array<{ filename: string; path: string }>;
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

    case 'email_send': {
      const transporter = deps.emailChannel?.getTransporter();
      if (!transporter) {
        logger.warn('email_send: no email transporter available');
        break;
      }
      if (!data.to || !data.subject || !data.text) {
        logger.warn({ data }, 'email_send: missing required fields (to, subject, text)');
        break;
      }
      try {
        await transporter.sendMail({
          from: `${EMAIL_FROM_NAME} <${SMTP_USER}>`,
          to: data.to,
          subject: data.subject,
          text: data.text,
          cc: data.cc || undefined,
          attachments: data.attachments?.map((a) => ({
            filename: a.filename,
            path: containerToHostPath(a.path, sourceGroup),
          })),
        });
        logger.info({ to: data.to, subject: data.subject }, 'Email sent via IPC');
        // Send confirmation to the source group's chat
        const chatJid = resolveChatJid(sourceGroup, registeredGroups);
        if (chatJid) {
          await deps.sendMessage(chatJid, `Email an ${data.to} gesendet.`);
        }
      } catch (err) {
        logger.error({ err, to: data.to }, 'Failed to send email via IPC');
      }
      break;
    }

    case 'email_reply': {
      const transporter = deps.emailChannel?.getTransporter();
      if (!transporter) {
        logger.warn('email_reply: no email transporter available');
        break;
      }
      if (!data.messageId || !data.text) {
        logger.warn({ data }, 'email_reply: missing required fields (messageId, text)');
        break;
      }
      const replyMeta = deps.emailChannel?.getThreadMetadata('email:' + data.messageId);
      if (!replyMeta) {
        logger.warn({ messageId: data.messageId }, 'email_reply: thread metadata not found');
        break;
      }
      try {
        const refs = replyMeta.references
          ? replyMeta.references + ' ' + replyMeta.messageId
          : replyMeta.messageId;
        await transporter.sendMail({
          from: `${EMAIL_FROM_NAME} <${SMTP_USER}>`,
          to: replyMeta.from,
          subject: 'Re: ' + replyMeta.subject,
          inReplyTo: replyMeta.messageId,
          references: refs,
          text: data.text,
          attachments: data.attachments?.map((a) => ({
            filename: a.filename,
            path: containerToHostPath(a.path, sourceGroup),
          })),
        });
        logger.info(
          { to: replyMeta.from, subject: replyMeta.subject },
          'Email reply sent via IPC',
        );
        const chatJid = resolveChatJid(sourceGroup, registeredGroups);
        if (chatJid) {
          await deps.sendMessage(chatJid, `Antwort an ${replyMeta.from} gesendet.`);
        }
      } catch (err) {
        logger.error({ err, messageId: data.messageId }, 'Failed to send email reply via IPC');
      }
      break;
    }

    case 'email_forward': {
      const transporter = deps.emailChannel?.getTransporter();
      if (!transporter) {
        logger.warn('email_forward: no email transporter available');
        break;
      }
      if (!data.messageId || !data.to) {
        logger.warn({ data }, 'email_forward: missing required fields (messageId, to)');
        break;
      }
      const fwdMeta = deps.emailChannel?.getThreadMetadata('email:' + data.messageId);
      if (!fwdMeta) {
        logger.warn({ messageId: data.messageId }, 'email_forward: thread metadata not found');
        break;
      }
      try {
        const fwdBody =
          (data.comment ? data.comment + '\n\n---\n\n' : '') +
          'Weitergeleitet von: ' +
          fwdMeta.fromName +
          ' <' +
          fwdMeta.from +
          '>\n' +
          'Betreff: ' +
          fwdMeta.subject +
          (fwdMeta.body ? '\n\n' + fwdMeta.body : '');
        await transporter.sendMail({
          from: `${EMAIL_FROM_NAME} <${SMTP_USER}>`,
          to: data.to,
          subject: 'Fwd: ' + fwdMeta.subject,
          text: fwdBody,
          attachments: data.attachments?.map((a) => ({
            filename: a.filename,
            path: containerToHostPath(a.path, sourceGroup),
          })),
        });
        logger.info(
          { to: data.to, subject: fwdMeta.subject },
          'Email forwarded via IPC',
        );
        const chatJid = resolveChatJid(sourceGroup, registeredGroups);
        if (chatJid) {
          await deps.sendMessage(chatJid, `Email an ${data.to} weitergeleitet.`);
        }
      } catch (err) {
        logger.error({ err, messageId: data.messageId }, 'Failed to forward email via IPC');
      }
      break;
    }

    case 'email_list': {
      if (!deps.emailChannel) {
        logger.warn('email_list: no email channel available');
        break;
      }
      const chatJid = resolveChatJid(sourceGroup, registeredGroups);
      if (chatJid) {
        await deps.sendMessage(chatJid, 'E-Mail-Postfach wird geprüft...');
      }
      try {
        await deps.emailChannel.pollOnce();
        logger.info({ sourceGroup }, 'Email list triggered via IPC');
      } catch (err) {
        logger.error({ err }, 'Failed to poll emails via IPC');
      }
      break;
    }

    case 'email_search': {
      if (!deps.emailChannel) {
        logger.warn('email_search: no email channel available');
        break;
      }
      const chatJid = resolveChatJid(sourceGroup, registeredGroups);
      if (chatJid) {
        await deps.sendMessage(chatJid, 'E-Mail-Suche wird durchgeführt...');
      }
      try {
        await deps.emailChannel.pollOnce();
        logger.info({ sourceGroup, query: data.query }, 'Email search triggered via IPC');
      } catch (err) {
        logger.error({ err }, 'Failed to search emails via IPC');
      }
      break;
    }

    case 'email_read': {
      if (!deps.emailChannel) {
        logger.warn('email_read: no email channel available');
        break;
      }
      if (!data.messageId) {
        logger.warn({ data }, 'email_read: missing messageId');
        break;
      }
      const readMeta = deps.emailChannel.getThreadMetadata('email:' + data.messageId);
      if (readMeta) {
        const chatJid = resolveChatJid(sourceGroup, registeredGroups);
        if (chatJid) {
          const info = [
            `Von: ${readMeta.fromName} <${readMeta.from}>`,
            `Betreff: ${readMeta.subject}`,
            `Message-ID: ${readMeta.messageId}`,
          ];
          if (readMeta.inReplyTo) info.push(`In-Reply-To: ${readMeta.inReplyTo}`);
          if (readMeta.body) {
            info.push('', readMeta.body);
          }
          await deps.sendMessage(chatJid, info.join('\n'));
        }
        logger.info({ messageId: data.messageId }, 'Email metadata read via IPC');
      } else {
        logger.warn({ messageId: data.messageId }, 'email_read: thread metadata not found');
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/** Translate container paths to host paths for attachments. */
function containerToHostPath(containerPath: string, sourceGroup: string): string {
  // /workspace/group/... -> groups/{sourceGroup}/...
  if (containerPath.startsWith('/workspace/group/')) {
    return path.join('groups', sourceGroup, containerPath.slice('/workspace/group/'.length));
  }
  // /workspace/extra/... -> groups/{sourceGroup}/extra/...
  if (containerPath.startsWith('/workspace/extra/')) {
    return path.join('groups', sourceGroup, 'extra', containerPath.slice('/workspace/extra/'.length));
  }
  // /workspace/ipc/... or other workspace paths
  if (containerPath.startsWith('/workspace/')) {
    return path.join('groups', sourceGroup, containerPath.slice('/workspace/'.length));
  }
  return containerPath;
}

/** Resolve the chat JID for a given source group folder. */
function resolveChatJid(
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | undefined {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === sourceGroup) return jid;
  }
  return undefined;
}
