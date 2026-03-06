import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  ENABLE_DYNAMIC_GROUP_REGISTRATION,
  ENABLE_SCHEDULER,
  ENABLE_WORKER_STEERING,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import {
  buildDispatchBlockedMessage as buildJarvisDispatchBlockedMessage,
  canJarvisDispatchToTarget,
  type DispatchBlockEvent,
  normalizeWorkerDispatchPayloadText as normalizeJarvisWorkerDispatchPayloadText,
  queueAndyWorkerDispatchRun as queueJarvisWorkerDispatchRun,
  recordBlockedDispatchAttempt,
  validateAndyToWorkerPayload as validateJarvisWorkerPayload,
  validateAndyWorkerDispatchMessage as validateJarvisWorkerDispatchMessage,
} from './extensions/jarvis/index.js';
import { emitBridgeEvent } from './event-bridge.js';
import { parseDispatchPayload } from './dispatch-validator.js';
import { AvailableGroup } from './container-runner.js';
import {
  ackSteeringEvent,
  completeWorkerRun,
  createTask,
  deleteTask,
  getWorkerRun,
  getTaskById,
  insertSteeringEvent,
  updateTask,
  updateWorkerRunProgress,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { isJarvisWorkerFolder, RegisteredGroup, WorkerProgressEvent, WorkerSteerEvent } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string, sourceGroup: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata?: (force: boolean) => Promise<void>;
  syncGroups?: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  options?: IpcRuntimeOptions;
}

export interface IpcRuntimeOptions {
  taskControlEnabled: boolean;
  workerSteeringEnabled: boolean;
  dynamicGroupRegistrationEnabled: boolean;
}

let ipcWatcherRunning = false;
const IPC_BASE_DIR = path.join(DATA_DIR, 'ipc');
const PROGRESS_POLL_INTERVAL = 2000;

function findGroupJidByFolder(
  registeredGroups: Record<string, RegisteredGroup>,
  folder: string,
): string | undefined {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === folder) return jid;
  }
  return undefined;
}

function writeDispatchBlockEvent(
  ipcBaseDir: string,
  event: DispatchBlockEvent,
): void {
  const errorDir = path.join(ipcBaseDir, 'errors');
  fs.mkdirSync(errorDir, { recursive: true });
  const filename = `dispatch-block-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  fs.writeFileSync(path.join(errorDir, filename), JSON.stringify(event, null, 2));
}

function buildDispatchBlockedMessage(event: DispatchBlockEvent): string {
  return buildJarvisDispatchBlockedMessage(event);
}

async function notifyDispatchBlocked(
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
  ipcBaseDir: string,
  event: DispatchBlockEvent,
): Promise<void> {
  writeDispatchBlockEvent(ipcBaseDir, event);
  recordBlockedDispatchAttempt(event);
  const sourceJid = event.source_jid
    ?? findGroupJidByFolder(registeredGroups, event.source_group);
  if (!sourceJid) return;

  try {
    await deps.sendMessage(
      sourceJid,
      buildDispatchBlockedMessage(event),
      'nanoclaw-system',
    );
  } catch (err) {
    logger.warn(
      { err, sourceGroup: event.source_group, sourceJid },
      'Failed to send dispatch block notice to source lane',
    );
  }
}

export function canIpcAccessTarget(
  sourceGroup: string,
  isMain: boolean,
  targetGroup: RegisteredGroup | undefined,
): boolean {
  return canJarvisDispatchToTarget(sourceGroup, isMain, targetGroup);
}

export function isIpcTargetAuthorized(
  sourceGroup: string,
  isMain: boolean,
  targetChatJid: string,
  registeredGroups: Record<string, RegisteredGroup>,
): boolean {
  return canIpcAccessTarget(sourceGroup, isMain, registeredGroups[targetChatJid]);
}

function canIpcAccessTaskGroup(
  sourceGroup: string,
  isMain: boolean,
  taskGroupFolder: string,
): boolean {
  if (isMain) return true;
  if (taskGroupFolder === sourceGroup) return true;
  if (sourceGroup === 'andy-developer' && isJarvisWorkerFolder(taskGroupFolder)) {
    return true;
  }
  return false;
}

/**
 * Validate an andy-developer -> jarvis-worker dispatch payload.
 * Shared by both the IPC message path and the schedule_task path.
 */
function validateAndyToWorkerPayload(
  targetFolder: string,
  text: string,
): ReturnType<typeof validateJarvisWorkerPayload> {
  return validateJarvisWorkerPayload(targetFolder, text);
}

function normalizeWorkerDispatchPayloadText(
  sourceGroup: string,
  targetGroup: RegisteredGroup | undefined,
  text: string,
): { text: string; normalized: boolean } {
  return normalizeJarvisWorkerDispatchPayloadText(sourceGroup, targetGroup, text);
}

export function validateAndyWorkerDispatchMessage(
  sourceGroup: string,
  targetGroup: RegisteredGroup | undefined,
  text: string,
): { valid: boolean; reason?: string } {
  return validateJarvisWorkerDispatchMessage(sourceGroup, targetGroup, text);
}

export interface WorkerDispatchQueueDecision {
  allowSend: boolean;
  runId?: string;
  queueState?: 'new' | 'retry';
  reason?: string;
}

export function queueAndyWorkerDispatchRun(
  sourceGroup: string,
  targetGroup: RegisteredGroup | undefined,
  text: string,
): WorkerDispatchQueueDecision {
  return queueJarvisWorkerDispatchRun(sourceGroup, targetGroup, text);
}

function startProgressPoller(deps: IpcDeps): void {
  const ipcBaseDir = IPC_BASE_DIR;

  const pollProgressEvents = async () => {
    try {
      let groupFolders: string[];
      try {
        groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
          try {
            return fs.statSync(path.join(ipcBaseDir, f)).isDirectory() && isJarvisWorkerFolder(f);
          } catch {
            return false;
          }
        });
      } catch {
        setTimeout(pollProgressEvents, PROGRESS_POLL_INTERVAL);
        return;
      }

      const registeredGroups = deps.registeredGroups();

      for (const workerFolder of groupFolders) {
        const progressDir = path.join(ipcBaseDir, workerFolder, 'progress');
        const steerDir = path.join(ipcBaseDir, workerFolder, 'steer');

        // Process progress event files
        if (fs.existsSync(progressDir)) {
          let runDirs: string[];
          try {
            runDirs = fs.readdirSync(progressDir);
          } catch {
            runDirs = [];
          }

          for (const runId of runDirs) {
            const runDir = path.join(progressDir, runId);
            try {
              if (!fs.statSync(runDir).isDirectory()) continue;
            } catch {
              continue;
            }

            let eventFiles: string[];
            try {
              eventFiles = fs.readdirSync(runDir).filter((f) => f.endsWith('.json')).sort();
            } catch {
              continue;
            }

            let latestSummary: string | null = null;
            let latestTimestamp: string | null = null;

            for (const file of eventFiles) {
              const filePath = path.join(runDir, file);
              try {
                const event = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WorkerProgressEvent;
                latestSummary = event.summary;
                latestTimestamp = event.timestamp;
                try { fs.unlinkSync(filePath); } catch { /* ignore */ }
              } catch (err) {
                logger.warn({ err, file, workerFolder }, 'Failed to process progress event file');
              }
            }

            if (latestSummary && latestTimestamp) {
              updateWorkerRunProgress(runId, latestSummary, latestTimestamp);
              void emitBridgeEvent({
                event_type: 'worker_progress',
                summary: `[${workerFolder}] ↻ ${latestSummary}`,
                metadata: { agent: workerFolder, tier: 'worker', run_id: runId, group_folder: workerFolder },
              });

              const andyJid = findGroupJidByFolder(registeredGroups, 'andy-developer');
              if (andyJid) {
                const shortId = runId.length > 6 ? runId.slice(-6) : runId;
                try {
                  await deps.sendMessage(andyJid, `[${shortId}] ↻ ${latestSummary}`, 'nanoclaw-system');
                } catch (err) {
                  logger.warn({ err, runId }, 'Failed to send progress notification to andy-developer');
                }
              }
            }
          }
        }

        // Process ack files for steering events
        if (fs.existsSync(steerDir)) {
          let ackedFiles: string[];
          try {
            ackedFiles = fs.readdirSync(steerDir).filter((f) => f.endsWith('.acked.json'));
          } catch {
            ackedFiles = [];
          }

          for (const file of ackedFiles) {
            const filePath = path.join(steerDir, file);
            try {
              const ack = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
                steer_id: string;
                acked_at: string;
              };
              ackSteeringEvent(ack.steer_id, ack.acked_at);
              try { fs.unlinkSync(filePath); } catch { /* ignore */ }
              logger.debug({ steer_id: ack.steer_id, workerFolder }, 'Steering event acked');
            } catch (err) {
              logger.warn({ err, file, workerFolder }, 'Failed to process steer ack file');
            }
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in worker progress poller');
    }

    setTimeout(pollProgressEvents, PROGRESS_POLL_INTERVAL);
  };

  pollProgressEvents();
  logger.info('Worker progress poller started');
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = IPC_BASE_DIR;
  fs.mkdirSync(ipcBaseDir, { recursive: true });
  const runtimeOptions: IpcRuntimeOptions = {
    taskControlEnabled: deps.options?.taskControlEnabled ?? ENABLE_SCHEDULER,
    workerSteeringEnabled: deps.options?.workerSteeringEnabled ?? ENABLE_WORKER_STEERING,
    dynamicGroupRegistrationEnabled: deps.options?.dynamicGroupRegistrationEnabled
      ?? ENABLE_DYNAMIC_GROUP_REGISTRATION,
  };
  const shouldProcessTaskDir = runtimeOptions.taskControlEnabled
    || runtimeOptions.workerSteeringEnabled
    || runtimeOptions.dynamicGroupRegistrationEnabled;

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
                const canAccessTarget = canIpcAccessTarget(sourceGroup, isMain, targetGroup);
                const normalizedDispatch = normalizeWorkerDispatchPayloadText(
                  sourceGroup,
                  targetGroup,
                  data.text,
                );
                const outboundText = normalizedDispatch.text;
                const dispatchValidation = validateAndyWorkerDispatchMessage(
                  sourceGroup,
                  targetGroup,
                  outboundText,
                );
                const queueDecision = (
                  canAccessTarget && dispatchValidation.valid
                )
                  ? queueAndyWorkerDispatchRun(sourceGroup, targetGroup, outboundText)
                  : { allowSend: true };

                if (canAccessTarget && dispatchValidation.valid && queueDecision.allowSend) {
                  await deps.sendMessage(data.chatJid, outboundText, sourceGroup);
                  if (normalizedDispatch.normalized) {
                    logger.info(
                      { sourceGroup, targetFolder: targetGroup?.folder },
                      'Normalized worker dispatch required_fields before send',
                    );
                  }
                  if (queueDecision.runId && queueDecision.queueState) {
                    logger.info(
                      {
                        runId: queueDecision.runId,
                        queueState: queueDecision.queueState,
                        sourceGroup,
                        targetFolder: targetGroup?.folder,
                      },
                      'Worker dispatch queued',
                    );
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  const reason = !canAccessTarget
                    ? 'target authorization failed'
                    : !dispatchValidation.valid
                      ? dispatchValidation.reason
                      : queueDecision.reason;
                  const isDuplicateRunId = (reason || '').startsWith('duplicate run_id blocked:');
                  logger.warn(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      reason,
                    },
                    'Unauthorized IPC message attempt blocked',
                  );

                  if (targetGroup && isJarvisWorkerFolder(targetGroup.folder)) {
                    const parsed = parseDispatchPayload(outboundText);
                    const reasonCode: DispatchBlockEvent['reason_code'] = !canAccessTarget
                      ? 'target_authorization_failed'
                      : isDuplicateRunId
                        ? 'duplicate_run_id'
                      : !dispatchValidation.valid
                        ? (
                          dispatchValidation.reason?.includes('only andy-developer')
                            ? 'unauthorized_source_lane'
                            : 'invalid_dispatch_payload'
                        )
                        : 'duplicate_run_id';

                    await notifyDispatchBlocked(
                      deps,
                      registeredGroups,
                      ipcBaseDir,
                      {
                        kind: 'dispatch_block',
                        timestamp: new Date().toISOString(),
                        source_group: sourceGroup,
                        source_jid: findGroupJidByFolder(registeredGroups, sourceGroup),
                        target_jid: data.chatJid,
                        target_folder: targetGroup.folder,
                        reason_code: reasonCode,
                        reason_text: reason || 'dispatch blocked',
                        run_id: parsed?.run_id,
                        request_id: parsed?.request_id,
                      },
                    );
                  }
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              const queuedDispatch = (() => {
                try {
                  const parsed = parseDispatchPayload(
                    JSON.parse(fs.readFileSync(filePath, 'utf-8')).text || '',
                  );
                  return parsed?.run_id;
                } catch {
                  return undefined;
                }
              })();
              if (queuedDispatch) {
                completeWorkerRun(
                  queuedDispatch,
                  'failed',
                  `dispatch delivery failed: ${err instanceof Error ? err.message : String(err)}`,
                  JSON.stringify({
                    reason: 'dispatch delivery failed',
                    source_group: sourceGroup,
                    file: filePath,
                    error: err instanceof Error ? err.message : String(err),
                  }),
                );
              }
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
        if (shouldProcessTaskDir && fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps, runtimeOptions);
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
  if (runtimeOptions.workerSteeringEnabled) {
    startProgressPoller(deps);
  } else {
    logger.info('Worker steering progress poller disabled by runtime profile');
  }
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
    // For steer_worker
    run_id?: string;
    message?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
  runtimeOptions: IpcRuntimeOptions = {
    taskControlEnabled: true,
    workerSteeringEnabled: true,
    dynamicGroupRegistrationEnabled: true,
  },
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (!runtimeOptions.taskControlEnabled) {
        logger.warn({ sourceGroup }, 'schedule_task ignored: task control disabled');
        break;
      }
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
        if (!canIpcAccessTarget(sourceGroup, isMain, targetGroupEntry)) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        if (isJarvisWorkerFolder(targetFolder) && sourceGroup !== 'andy-developer') {
          const reasonText = 'worker dispatch ownership violation: only andy-developer may schedule worker dispatch tasks';
          logger.warn(
            { sourceGroup, targetFolder, reason: reasonText },
            'Unauthorized worker schedule_task attempt blocked',
          );
          await notifyDispatchBlocked(deps, registeredGroups, IPC_BASE_DIR, {
            kind: 'dispatch_block',
            timestamp: new Date().toISOString(),
            source_group: sourceGroup,
            source_jid: findGroupJidByFolder(registeredGroups, sourceGroup),
            target_jid: targetJid,
            target_folder: targetFolder,
            reason_code: 'unauthorized_source_lane',
            reason_text: reasonText,
            run_id: parseDispatchPayload(data.prompt)?.run_id,
            request_id: parseDispatchPayload(data.prompt)?.request_id,
          });
          break;
        }

        if (sourceGroup === 'andy-developer' && isJarvisWorkerFolder(targetFolder)) {
          const workerValidation = validateAndyToWorkerPayload(targetFolder, data.prompt);
          if (!workerValidation.valid) {
            logger.warn(
              { sourceGroup, targetFolder, reason: workerValidation.reason },
              'Blocked schedule_task: worker dispatch validation failed',
            );
            await notifyDispatchBlocked(deps, registeredGroups, IPC_BASE_DIR, {
              kind: 'dispatch_block',
              timestamp: new Date().toISOString(),
              source_group: sourceGroup,
              source_jid: findGroupJidByFolder(registeredGroups, sourceGroup),
              target_jid: targetJid,
              target_folder: targetFolder,
              reason_code: workerValidation.reasonCode,
              reason_text: workerValidation.reason,
              run_id: parseDispatchPayload(data.prompt)?.run_id,
              request_id: parseDispatchPayload(data.prompt)?.request_id,
            });
            break;
          }
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
      if (!runtimeOptions.taskControlEnabled) {
        logger.warn({ sourceGroup }, 'pause_task ignored: task control disabled');
        break;
      }
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && canIpcAccessTaskGroup(sourceGroup, isMain, task.group_folder)) {
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
      if (!runtimeOptions.taskControlEnabled) {
        logger.warn({ sourceGroup }, 'resume_task ignored: task control disabled');
        break;
      }
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && canIpcAccessTaskGroup(sourceGroup, isMain, task.group_folder)) {
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
      if (!runtimeOptions.taskControlEnabled) {
        logger.warn({ sourceGroup }, 'cancel_task ignored: task control disabled');
        break;
      }
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && canIpcAccessTaskGroup(sourceGroup, isMain, task.group_folder)) {
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
      if (!runtimeOptions.dynamicGroupRegistrationEnabled) {
        logger.warn({ sourceGroup }, 'refresh_groups ignored: dynamic group registration disabled');
        break;
      }
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        if (deps.syncGroupMetadata) {
          await deps.syncGroupMetadata(true);
        } else if (deps.syncGroups) {
          await deps.syncGroups(true);
        }
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
      if (!runtimeOptions.dynamicGroupRegistrationEnabled) {
        logger.warn({ sourceGroup }, 'register_group ignored: dynamic group registration disabled');
        break;
      }
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

    case 'steer_worker': {
      if (!runtimeOptions.workerSteeringEnabled) {
        logger.warn({ sourceGroup }, 'steer_worker ignored: worker steering disabled');
        break;
      }
      const { run_id, message } = data;

      if (!run_id || !message) {
        logger.warn({ data }, 'steer_worker: missing run_id or message');
        break;
      }

      if (sourceGroup !== 'andy-developer') {
        logger.warn({ sourceGroup }, 'steer_worker: unauthorized source (only andy-developer allowed)');
        break;
      }

      const workerRun = getWorkerRun(run_id);
      if (!workerRun) {
        logger.warn({ run_id }, 'steer_worker: run_id not found');
        const andyJidNotFound = findGroupJidByFolder(registeredGroups, 'andy-developer');
        if (andyJidNotFound) {
          try {
            await deps.sendMessage(andyJidNotFound, `✗ Steer failed: run_id \`${run_id}\` not found`, 'nanoclaw-system');
          } catch { /* ignore */ }
        }
        break;
      }

      if (workerRun.status !== 'running') {
        logger.warn({ run_id, status: workerRun.status }, 'steer_worker: run is not active');
        const andyJidInactive = findGroupJidByFolder(registeredGroups, 'andy-developer');
        if (andyJidInactive) {
          try {
            await deps.sendMessage(andyJidInactive, `✗ Steer failed: \`${run_id}\` is not running (status: ${workerRun.status})`, 'nanoclaw-system');
          } catch { /* ignore */ }
        }
        break;
      }

      const steerId = `steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const steerEvent: WorkerSteerEvent = {
        kind: 'worker_steer',
        run_id,
        from_group: 'andy-developer',
        timestamp: new Date().toISOString(),
        message,
        steer_id: steerId,
      };

      const steerDir = path.join(IPC_BASE_DIR, workerRun.group_folder, 'steer');
      fs.mkdirSync(steerDir, { recursive: true });
      fs.writeFileSync(path.join(steerDir, `${run_id}.json`), JSON.stringify(steerEvent, null, 2));

      insertSteeringEvent({
        steer_id: steerId,
        run_id,
        from_group: 'andy-developer',
        message,
        sent_at: steerEvent.timestamp,
      });
      void emitBridgeEvent({
        event_type: 'worker_steered',
        summary: `[andy-dev → ${workerRun.group_folder}] steer: ${message.slice(0, 80)}`,
        metadata: { agent: workerRun.group_folder, tier: 'andy-developer', run_id, group_folder: workerRun.group_folder },
      });

      const andyJid = findGroupJidByFolder(registeredGroups, 'andy-developer');
      if (andyJid) {
        try {
          await deps.sendMessage(andyJid, `↗ Steering sent to ${run_id}`, 'nanoclaw-system');
        } catch (err) {
          logger.warn({ err, run_id }, 'Failed to send steer confirmation to andy-developer');
        }
      }

      logger.info({ run_id, steer_id: steerId, targetWorkerFolder: workerRun.group_folder }, 'Worker steering event dispatched');
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
