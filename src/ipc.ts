import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import type { StagehandBridge } from './browser/stagehand-bridge.js';
import { isDestructiveIntent } from './browser/stagehand-bridge.js';
import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  setGroupVerbose,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import type { LlmConfig, RegisteredGroup } from './types.js';
import { addRule } from './learning/rules-engine.js';
import { addTrace } from './learning/procedure-recorder.js';
import { inferActionClasses } from './learning/outcome-enricher.js';
import { saveProcedure } from './memory/procedure-store.js';
import type { Procedure } from './memory/procedure-store.js';
import { addWatcher } from './watchers/watcher-store.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  /**
   * Send a message authored by an agent (via the container's send_message or
   * relay_message MCP tools). Runs through classifyAndFormat so that Yes/No,
   * forward, RSVP, and open-URL buttons get attached when the text contains
   * a question or actionable item. Falls back to plain sendMessage when the
   * channel doesn't support inline keyboards.
   */
  sendAgentMessage: (jid: string, text: string) => Promise<void>;
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
  onTasksChanged: () => void;
  // Spawn agent for email triggers instead of sending raw messages
  enqueueEmailTrigger: (
    chatJid: string,
    prompt: string,
    onResult: (
      text: string,
      emails: Array<{
        thread_id: string;
        account: string;
        subject: string;
        sender: string;
      }>,
    ) => Promise<void>,
    emails: Array<{
      thread_id: string;
      account: string;
      subject: string;
      sender: string;
    }>,
  ) => void;
  // Browser automation
  stagehandBridge?: StagehandBridge;
  trustGateway?: {
    evaluate: (req: {
      toolName: string;
      actionClass: string;
      description: string;
      groupId: string;
    }) => Promise<{ decision: 'approved' | 'denied' }>;
  };
  browserTrustState?: {
    readGranted: boolean;
    readGrantedAt: number;
    groupId: string;
  };
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
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendAgentMessage(data.chatJid, data.text);
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

export interface WatchPageIpcResult {
  success: boolean;
  watcherId?: string;
  error?: string;
}

export function handleWatchPageIpc(
  taskData: Record<string, unknown>,
  groupName: string,
): WatchPageIpcResult {
  const url = taskData.url as string | undefined;
  const selector = taskData.selector as string | undefined;
  const label = (taskData.label as string) || 'Unnamed watcher';
  const intervalMs = (taskData.intervalMs as number) || 300000; // 5 min default

  if (!url) {
    return { success: false, error: 'watch_page: url is required' };
  }
  if (!selector) {
    return { success: false, error: 'watch_page: selector is required' };
  }

  try {
    const watcher = addWatcher({
      url,
      selector,
      groupId: groupName,
      intervalMs,
      label,
    });

    logger.info(
      { watcherId: watcher.id, url, groupId: groupName },
      'watch_page IPC: watcher created',
    );

    return { success: true, watcherId: watcher.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'watch_page IPC: failed to create watcher');
    return { success: false, error: msg };
  }
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
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
    // For relay_message
    targetGroup?: string;
    text?: string;
    // For email_trigger
    emails?: Array<{
      thread_id: string;
      account: string;
      subject: string;
      sender: string;
    }>;
    // For toggle_verbose
    enabled?: boolean;
    // For switch_model
    provider?: string;
    model?: string;
    // For learn_fact / search_memory
    domain?: string;
    source?: string;
    query?: string;
    limit?: number;
    // For browser_act/extract/observe
    instruction?: string;
    schema?: unknown;
    _responseFile?: string;
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
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'email_trigger': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized email_trigger attempt blocked',
        );
        break;
      }

      const { EMAIL_INTELLIGENCE_ENABLED } = await import('./config.js');
      if (!EMAIL_INTELLIGENCE_ENABLED) {
        logger.debug('Email intelligence disabled, skipping trigger');
        break;
      }

      const emailCount = data.emails?.length ?? 0;
      if (emailCount === 0) {
        logger.debug('Email trigger with no emails, skipping');
        break;
      }

      // Classification is handled inline by sse-classifier.ts when
      // email.received fires. Items are already tracked by the time
      // this IPC handler runs — we only need to build the agent prompt.

      const emailSummaries = (data.emails ?? [])
        .map((e) => {
          const from = e.sender || 'unknown sender';
          const subj = e.subject || '(no subject)';
          return `- [${e.account}] From: ${from}, Subject: ${subj} (thread: ${e.thread_id})`;
        })
        .join('\n');

      const prompt = `## Email Intelligence Trigger\n\n${emailCount} new email(s) to process:\n\n${emailSummaries}\n\nFollow the Email Intelligence instructions in your CLAUDE.md. For each email:\n1. Check if already processed (search processed_items)\n2. Use superpilot MCP to get full context\n3. Classify action tier (AUTO/PROPOSE/ESCALATE)\n4. Act accordingly\n5. Mark as processed`;

      // Run the agent on the Telegram JID (primary notification channel)
      // so that user replies on Telegram go to the same container session.
      // This enables the approval flow: agent proposes → user replies
      // "approve"/"skip" → same agent session processes the response.
      // Falls back to main group if Telegram isn't registered.
      const telegramJid = Object.entries(registeredGroups).find(([jid]) =>
        jid.startsWith('tg:'),
      )?.[0];
      const mainJid = Object.entries(registeredGroups).find(
        ([, g]) => g.isMain,
      )?.[0];
      const agentJid = telegramJid || mainJid;

      if (!agentJid) {
        logger.warn(
          'No Telegram or main group registered, cannot process email trigger',
        );
        break;
      }

      // Build structured email list for passing to the onResult callback
      // so downstream handlers can attach archive/action buttons per email.
      const triggerEmails = (data.emails ?? []).map(
        (e: {
          thread_id?: string;
          account?: string;
          subject?: string;
          sender?: string;
        }) => ({
          thread_id: e.thread_id ?? '',
          account: e.account ?? '',
          subject: e.subject ?? '',
          sender: e.sender ?? '',
        }),
      );

      // Enqueue agent task — the agent processes emails in a container
      // and sends clean proposals back to the same channel it runs on
      deps.enqueueEmailTrigger(
        agentJid,
        prompt,
        async (text: string, emails) => {
          void emails; // available for archive-button attachment in later tasks
          await deps.sendMessage(agentJid, text);
        },
        triggerEmails,
      );

      logger.info(
        { emailCount, sourceGroup, agentJid },
        'Email trigger enqueued for agent processing',
      );
      break;
    }

    case 'relay_message': {
      // Cross-channel relay: main group only
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized relay_message attempt blocked',
        );
        break;
      }

      const targetGroupName = data.targetGroup as string | undefined;
      const relayText = data.text as string | undefined;

      if (!targetGroupName || !relayText) {
        logger.warn(
          { sourceGroup },
          'relay_message: missing targetGroup or text',
        );
        break;
      }

      // Find the target group by folder name or display name (case-insensitive)
      const targetEntry = Object.entries(registeredGroups).find(
        ([, g]) =>
          g.folder.toLowerCase() === targetGroupName.toLowerCase() ||
          g.name.toLowerCase() === targetGroupName.toLowerCase(),
      );

      if (!targetEntry) {
        logger.warn(
          { targetGroup: targetGroupName, sourceGroup },
          'relay_message: target group not found',
        );
        break;
      }

      const [targetJidRelay] = targetEntry;
      await deps.sendAgentMessage(targetJidRelay, relayText);
      logger.info(
        {
          targetJid: targetJidRelay,
          targetGroup: targetGroupName,
          sourceGroup,
        },
        'Message relayed to target group',
      );
      break;
    }

    case 'browser_act':
    case 'browser_extract':
    case 'browser_observe': {
      if (!deps.stagehandBridge) {
        logger.warn(
          { sourceGroup },
          `${data.type}: stagehand bridge not available`,
        );
        break;
      }

      const instruction = data.instruction as string;
      const toolType = data.type as string;

      // Trust check: determine action class based on tool type and intent
      let actionClass =
        toolType === 'browser_act' ? 'services.write' : 'info.read';

      // Escalate destructive browser_act instructions to services.transact
      if (toolType === 'browser_act' && isDestructiveIntent(instruction)) {
        actionClass = 'services.transact';
      }

      // Session-level trust: reads only need one approval per browser session (1hr TTL)
      const grantAge =
        Date.now() - (deps.browserTrustState?.readGrantedAt ?? 0);
      const grantValid =
        deps.browserTrustState?.readGranted && grantAge < 3_600_000;
      const needsTrustCheck = actionClass !== 'info.read' || !grantValid;

      if (needsTrustCheck && deps.trustGateway) {
        const trustResult = await deps.trustGateway.evaluate({
          toolName: toolType,
          actionClass,
          description: instruction,
          groupId: sourceGroup,
        });

        if (trustResult.decision === 'denied') {
          const rejection = {
            success: false,
            error: 'Action denied by trust engine',
          };
          const respFile = data._responseFile;
          if (respFile && typeof respFile === 'string') {
            const safeDir = path.join(DATA_DIR, 'ipc', sourceGroup);
            const resolved = path.resolve(respFile);
            if (resolved.startsWith(safeDir + path.sep)) {
              fs.writeFileSync(resolved, JSON.stringify(rejection));
            } else {
              logger.error(
                { sourceGroup, path: respFile },
                'Blocked _responseFile path traversal',
              );
            }
          }
          break;
        }

        // Cache read-level trust grant for this session
        if (actionClass === 'info.read' && deps.browserTrustState) {
          deps.browserTrustState.readGranted = true;
          deps.browserTrustState.readGrantedAt = Date.now();
        }
      }

      const result = await deps.stagehandBridge.handleRequest({
        type: toolType.replace('browser_', '') as 'act' | 'extract' | 'observe',
        instruction,
        groupId: sourceGroup,
        schema: data.schema as Record<string, unknown> | undefined,
      });

      if (data._responseFile && typeof data._responseFile === 'string') {
        const safeDir = path.join(DATA_DIR, 'ipc', sourceGroup);
        const resolved = path.resolve(data._responseFile);
        if (resolved.startsWith(safeDir + path.sep)) {
          fs.writeFileSync(resolved, JSON.stringify(result));
        } else {
          logger.error(
            { sourceGroup, path: data._responseFile },
            'Blocked _responseFile path traversal',
          );
        }
      }
      break;
    }

    case 'toggle_verbose': {
      if (!data.chatJid) {
        logger.warn({ sourceGroup }, 'toggle_verbose: missing chatJid');
        break;
      }
      // Only allow toggling for own group, or main can toggle any
      const targetJidVerbose = data.chatJid;
      const targetGroupVerbose = registeredGroups[targetJidVerbose];
      if (
        !targetGroupVerbose ||
        (!isMain && targetGroupVerbose.folder !== sourceGroup)
      ) {
        logger.warn(
          { sourceGroup, targetJid: targetJidVerbose },
          'Unauthorized toggle_verbose attempt blocked',
        );
        break;
      }
      const newVerbose =
        data.enabled !== undefined ? data.enabled : !targetGroupVerbose.verbose;
      setGroupVerbose(targetJidVerbose, newVerbose);
      // Update in-memory state
      targetGroupVerbose.verbose = newVerbose;
      logger.info(
        { chatJid: targetJidVerbose, verbose: newVerbose, sourceGroup },
        'Verbose mode toggled via IPC',
      );
      break;
    }

    case 'learn_feedback': {
      const feedbackData = data as typeof data & {
        feedback?: string;
        groupId?: string;
        procedure?: Procedure;
      };
      if (feedbackData.feedback) {
        const actionClasses = inferActionClasses(feedbackData.feedback);
        addRule({
          rule: feedbackData.feedback,
          source: 'user_feedback',
          actionClasses: actionClasses.length > 0 ? actionClasses : ['general'],
          groupId: feedbackData.groupId ?? sourceGroup,
          confidence: 0.9,
          evidenceCount: 1,
        });
      }
      if (feedbackData.procedure) {
        const proc = feedbackData.procedure;
        if (!proc.groupId) {
          proc.groupId = feedbackData.groupId ?? sourceGroup;
        }
        saveProcedure(proc);
        logger.info(
          {
            name: proc.name,
            groupId: proc.groupId,
            stepCount: proc.steps?.length,
          },
          'Teach-mode procedure saved via IPC',
        );
      }
      if (feedbackData.feedback || feedbackData.procedure) {
        logger.info(
          { groupId: feedbackData.groupId ?? sourceGroup },
          'learn_feedback IPC processed',
        );
      }
      break;
    }

    case 'learn_fact': {
      const { storeFactWithVector } =
        await import('./memory/knowledge-store.js');
      const factText = data.text as string;
      const factDomain = data.domain || 'general';
      const factSource = data.source || 'agent';
      const factGroup = data.groupFolder as string;

      await storeFactWithVector({
        text: factText,
        domain: factDomain,
        groupId: factGroup,
        source: factSource,
      });
      logger.info(
        {
          domain: factDomain,
          groupFolder: factGroup,
          textLen: factText.length,
        },
        'Fact stored via IPC',
      );
      break;
    }

    case 'switch_model': {
      const targetJid = data.chatJid;
      if (!targetJid || !data.provider) {
        logger.warn(
          { sourceGroup },
          'switch_model: missing chatJid or provider',
        );
        break;
      }

      const targetGroup = registeredGroups[targetJid];
      if (!targetGroup) {
        logger.warn({ targetJid }, 'switch_model: target group not registered');
        break;
      }

      // Authorization: non-main groups can only switch their own model
      if (!isMain && targetGroup.folder !== sourceGroup) {
        logger.warn(
          { sourceGroup, targetFolder: targetGroup.folder },
          'Unauthorized switch_model attempt blocked',
        );
        break;
      }

      const updatedConfig = { ...(targetGroup.containerConfig ?? {}) };
      updatedConfig.llm = {
        ...updatedConfig.llm,
        provider: data.provider as LlmConfig['provider'],
        model: data.model ?? updatedConfig.llm?.model,
      };

      deps.registerGroup(targetJid, {
        ...targetGroup,
        containerConfig: updatedConfig,
      });

      logger.info(
        {
          targetJid,
          sourceGroup,
          provider: data.provider,
          model: data.model,
        },
        'Model switched via IPC',
      );
      break;
    }

    case 'search_memory': {
      const { queryFactsSemantic } =
        await import('./memory/knowledge-store.js');
      const query = data.query as string;
      const domain = data.domain as string | undefined;
      const limit = (data.limit as number) || 5;
      const groupFolder = data.groupFolder as string;

      const facts = await queryFactsSemantic(query, {
        domain,
        groupId: groupFolder,
        limit,
      });
      if (facts.length > 0) {
        const formatted = facts
          .map((f) => `• ${f.text} [${f.domain}]`)
          .join('\n');
        logger.info(
          { query, resultCount: facts.length, groupFolder },
          'Memory search results',
        );
        const contextDir = path.join(GROUPS_DIR, groupFolder, 'context');
        fs.mkdirSync(contextDir, { recursive: true });
        fs.writeFileSync(
          path.join(contextDir, 'memory-results.txt'),
          `Memory recall for "${query}":\n${formatted}\n`,
          'utf-8',
        );
      }
      break;
    }

    case 'watch_page': {
      const result = handleWatchPageIpc(
        data as Record<string, unknown>,
        sourceGroup,
      );
      if (result.success) {
        logger.info(
          { watcherId: result.watcherId },
          'watch_page IPC processed',
        );
      } else {
        logger.warn({ error: result.error }, 'watch_page IPC failed');
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }

  // Trace IPC actions for procedure recording
  if (data.taskId) {
    const traceableTypes = new Set([
      'browser_navigate',
      'browser_act',
      'browser_extract',
      'browser_observe',
      'schedule_task',
      'cancel_task',
      'relay_message',
      'email_trigger',
    ]);
    if (traceableTypes.has(data.type)) {
      addTrace(sourceGroup, data.taskId, {
        type: data.type,
        timestamp: Date.now(),
        inputSummary: (
          data.instruction ??
          data.prompt ??
          data.text ??
          data.type
        ).slice(0, 200),
        result: 'success',
      });
    }
  }
}
